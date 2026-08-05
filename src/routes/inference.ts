import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import * as jwt from 'jsonwebtoken';
import { ConfigRegistry, FlowConfig, RoleConfig } from '../config/types';
import { FlowEngine } from '../engine/flow';
import { SSEWriter } from '../sse/writer';
import { redisPub } from '../redis';

const MEMCORE_JWT_SECRET = process.env.MEMCORE_JWT_SECRET || 'memcore-dev-jwt-secret-2026';
const MEMCORE_BASE_URL = process.env.MEMCORE_BASE_URL || 'http://memcore-api.dev-memcore.svc.cluster.local:3000';

// ── 按账号套餐的爬虫调用频率限制 ─────────────────────────────────────────────
// 限流点：SuperModel /v1/chat/completions（调一次 = 触发一次完整爬虫）
// 软件层接口（/memory/semantic 等）对 SDK 直接开放，不在此限。
//
// 套餐速率（3秒滑动窗口）：
//   free / personal  = 1 次
//   developer        = 10 次
//   enterprise / 0   = 不限
//
// plan 来源：用 X-User-Token 解出的 memcoreToken 打 MemCore /user/me，带 Redis 缓存（60s）

const PLAN_RATE_MAP: Record<string, number> = {
  free: 1,
  personal: 1,
  developer: 10,
  enterprise: 0,  // 0 = 不限
};
const PLAN_CACHE_TTL_S = 60;  // Redis 缓存 plan 60 秒

const CRAWLER_RATE_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local member = ARGV[4]
  redis.call('zremrangebyscore', key, 0, now - window)
  local count = redis.call('zcard', key)
  if count >= limit then
    return -1
  end
  redis.call('zadd', key, now, member)
  redis.call('expire', key, math.ceil(window / 1000) + 10)
  return count + 1
`;

/** 从 MemCore /user/me 获取用户套餐（带 Redis 缓存） */
async function getUserPlan(memcoreToken: string, userId: string): Promise<string> {
  const cacheKey = `supermodel:plan_cache:${userId}`;
  try {
    const cached = await redisPub.get(cacheKey);
    if (cached) return cached;
  } catch { /* Redis 不可用，继续查 API */ }

  try {
    const resp = await fetch(`${MEMCORE_BASE_URL}/user/me`, {
      headers: { Authorization: `Bearer ${memcoreToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const body = await resp.json() as any;
      const plan: string = body.plan ?? 'free';
      try {
        await redisPub.set(cacheKey, plan, 'EX', PLAN_CACHE_TTL_S);
      } catch { /* 缓存写入失败，忽略 */ }
      return plan;
    }
  } catch { /* MemCore 查询失败，fail-open */ }

  return 'free';
}

/** 按账号套餐限制爬虫调用频率，返回 false 表示已触发限流（reply 已发送 429） */
async function applyCrawlerRateLimit(
  userId: string,
  plan: string,
  reply: any
): Promise<boolean> {
  const limit = PLAN_RATE_MAP[plan] ?? 1;
  if (limit <= 0) return true;  // 0 = 不限速（企业版）

  const key = `supermodel:crawler_rate:${userId}`;
  const now = Date.now();
  const windowMs = 3000;
  const member = `${now}-${crypto.randomUUID()}`;

  try {
    const result = await redisPub.eval(
      CRAWLER_RATE_LUA,
      1,       // numkeys
      key,     // KEYS[1]
      String(now), String(windowMs), String(limit), member  // ARGV[1..4]
    ) as number;

    if (result === -1) {
      reply.code(429).send({ error: { message: 'rate_limit_exceeded', retry_after_ms: windowMs } });
      return false;
    }
  } catch {
    // Redis 异常，fail-open：放行请求
  }
  return true;
}

/** 从请求的 X-User-Token 解析用户 ID，生成 memcore-compatible JWT */
function buildMemcoreToken(userToken: string | undefined): string | null {
  if (!userToken) return null;
  try {
    // 优先：X-User-Token 是 memory-spider-api 签的 JWT，payload.userId 是数字
    const msSecret = process.env.MS_JWT_SECRET || 'memory-spider-jwt-secret-2026-dev';
    const payload = jwt.verify(userToken, msSecret) as any;
    const userId = String(payload.userId ?? payload.user_id ?? '');
    if (!userId) return null;
    return jwt.sign(
      { user_id: userId, type: 'access' },
      MEMCORE_JWT_SECRET,
      { expiresIn: '1h', issuer: 'memcore', algorithm: 'HS256' }
    );
  } catch {
    // 降级：X-User-Token 可能本身就是 memcore JWT，直接透传
    try {
      const payload = jwt.verify(userToken, MEMCORE_JWT_SECRET) as any;
      if (payload.user_id) return userToken;
    } catch {}
    return null;
  }
}

interface InferenceRoutesOptions {
  configRegistry: ConfigRegistry;
  flowEngine: FlowEngine;
  apiKeys: string[];
}

import crypto from 'crypto';

function timingSafeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // Still do a dummy compare to avoid timing leak on length
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function authenticateInference(req: any, reply: any, apiKeys: string[]): boolean {
  const authHeader = req.headers['authorization'] as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' } });
    return false;
  }
  const token = authHeader.slice(7);
  const valid = apiKeys.some(k => timingSafeCompare(token, k));
  if (!valid) {
    reply.status(401).send({ error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' } });
    return false;
  }
  return true;
}

// Resolve model field to (instanceName, flowConfig, roles, tools)
function resolveModel(model: string, registry: ConfigRegistry): {
  instanceName: string;
  flowConfig: FlowConfig;
  roles: Map<string, RoleConfig>;
  tools: Map<string, import('../config/types').ToolConfig>;
} | null {
  // Check instances map - need to work with LoadedInstances
  // Registry.instances is ModelConfig[] (legacy bridge)
  // We walk the instances to find the right flow
  if (model.includes('/')) {
    const [instName, flowName] = model.split('/', 2);
    const inst = registry.loadedInstances?.get(instName);
    if (!inst) return null;
    const flow = inst.flows.get(flowName);
    if (!flow) return null;
    return { instanceName: instName, flowConfig: flow, roles: inst.roles, tools: inst.tools };
  }
  // No slash: treat model as flow name, find first instance that has it
  if (registry.loadedInstances) {
    for (const [instName, inst] of registry.loadedInstances) {
      const flow = inst.flows.get(model);
      if (flow) return { instanceName: instName, flowConfig: flow, roles: inst.roles, tools: inst.tools };
    }
  }
  return null;
}

export async function inferenceRoutes(fastify: FastifyInstance, options: InferenceRoutesOptions) {
  const { configRegistry, flowEngine, apiKeys } = options;

  // ── Rate limiting ────────────────────────────────────────────────────────
  // Limit per API key (keyGenerator extracts Bearer token).
  // RATE_LIMIT_MAX: max requests per window (default 60/min).
  // RATE_LIMIT_WINDOW_MS: window in ms (default 60000 = 1 min).
  const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
  const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

  await fastify.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
    keyGenerator: (req: any) => {
      // Rate-limit per API key, fall back to IP
      const auth = req.headers['authorization'] as string | undefined;
      if (auth?.startsWith('Bearer ')) return auth.slice(7);
      return req.ip;
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });
  // ── End rate limiting ────────────────────────────────────────────────────

  fastify.addHook('preHandler', async (req: any, reply: any) => {
    if (!authenticateInference(req, reply, apiKeys)) {
      return reply;
    }
  });

  fastify.post('/v1/chat/completions', async (req: any, reply: any) => {
    const { model, messages, stream = false } = req.body as any;

    // Resolve routing
    const resolved = resolveModel(model, configRegistry);
    if (!resolved) {
      return reply.status(404).send({ error: { message: `Model not found: ${model}`, type: 'not_found', code: 'model_not_found' } });
    }
    const { instanceName, flowConfig, roles, tools } = resolved;

    // Build memcore auth header from X-User-Token
    const userToken = req.headers['x-user-token'] as string | undefined;
    const memcoreToken = buildMemcoreToken(userToken);
    const extraHeaders: Record<string, string> = memcoreToken
      ? { 'Authorization': `Bearer ${memcoreToken}` }
      : {};

    // ── 爬虫调用频率限制（按账号套餐，3秒滑动窗口） ────────────────────────
    // 只对携带 X-User-Token 的请求限速（MemCore 用户）。
    // 无 token 的匿名/内部调用跳过，由外层 API key 鉴权已保护。
    if (memcoreToken && userToken) {
      // 从 JWT 解出 userId（避免重复打 MemCore 接口）
      let userId: string | null = null;
      try {
        const p = jwt.decode(memcoreToken) as any;
        userId = p?.user_id ?? null;
      } catch { /* ignore */ }

      if (userId) {
        const plan = await getUserPlan(memcoreToken, userId);
        const allowed = await applyCrawlerRateLimit(userId, plan, reply);
        if (!allowed) return;  // 429 已发送
      }
    }
    // ── End 爬虫调用频率限制 ─────────────────────────────────────────────────

    // Build initial input from messages — preserve conversation history per arch M6.4
    // Serialize all user/assistant turns as context, system msg prepended to initialInput
    const systemMsg = (messages as any[]).find((m: any) => m.role === 'system')?.content ?? '';
    const conversationMsgs = (messages as any[]).filter((m: any) => m.role === 'user' || m.role === 'assistant');
    // Build initialInput: system prompt prefix + full conversation history serialized
    let initialInput = '';
    if (systemMsg) {
      initialInput += `[System]: ${systemMsg}\n\n`;
    }
    if (conversationMsgs.length === 0) {
      initialInput += '';
    } else if (conversationMsgs.length === 1) {
      initialInput += conversationMsgs[0].content ?? '';
    } else {
      // Multi-turn: serialize history as context, last user message is the actual query
      const history = conversationMsgs.slice(0, -1).map((m: any) =>
        `[${m.role === 'user' ? 'User' : 'Assistant'}]: ${m.content}`
      ).join('\n');
      const lastMsg = conversationMsgs[conversationMsgs.length - 1];
      initialInput += `Previous conversation:\n${history}\n\n[User]: ${lastMsg.content ?? ''}`;
    }

    const abortController = new AbortController();
    req.raw.on('close', () => abortController.abort());

    if (stream) {
      const sseWriter = new SSEWriter(reply);
      sseWriter.setupHeaders();
      sseWriter.startHeartbeats();

      // Generate a stable chatcmpl id for the entire stream
      const streamId = `chatcmpl-${Date.now()}`;
      const streamCreated = Math.floor(Date.now() / 1000);

      try {
        // Send first chunk: delta.role:"assistant", content:"" per arch M5
        await sseWriter.writeChunk({
          id: streamId,
          object: 'chat.completion.chunk',
          created: streamCreated,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        });

        const genResult = flowEngine.executeFlowStreaming(flowConfig, roles, tools, initialInput, instanceName, abortController, extraHeaders);
        let flowResult: any = null;
        for await (const chunk of genResult) {
          // Internal marker chunk carrying FlowExecutionResult — don't forward to client
          if ((chunk as any).__flowResult) {
            flowResult = (chunk as any).__flowResult;
            continue;
          }
          await sseWriter.writeChunk(chunk);
        }
        // Build final chunk with usage + finish_reason + x_supermodel_usage per arch M5
        const usageSummary = flowResult ? {
          prompt_tokens: flowResult.totalUsage?.prompt_tokens ?? 0,
          completion_tokens: flowResult.totalUsage?.completion_tokens ?? 0,
          total_tokens: (flowResult.totalUsage?.prompt_tokens ?? 0) + (flowResult.totalUsage?.completion_tokens ?? 0)
        } : undefined;
        const finalChunk: any = {
          id: streamId,
          object: 'chat.completion.chunk',
          created: streamCreated,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: flowResult?.finishReason ?? 'stop' }]
        };
        if (usageSummary) {
          finalChunk.usage = usageSummary;
          finalChunk.x_supermodel_usage = flowResult?.byRoleUsage;
        }
        await sseWriter.writeFinal(finalChunk);
        // Send SSE termination signal per OpenAI spec
        sseWriter.writeDone();
      } catch (err: any) {
        // Distinguish client disconnect (abort) from real upstream errors
        if (abortController.signal.aborted || err?.name === 'AbortError') {
          // Client disconnected — silent end, no error message
        } else {
          await sseWriter.writeError('Upstream API error');
        }
      } finally {
        sseWriter.close();
      }
      return;
    }

    // Non-streaming
    try {
      const result = await flowEngine.executeFlow(flowConfig, roles, tools, initialInput, instanceName, abortController, extraHeaders);
      return {
        id: `chatcmpl-${result.id}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.output }, finish_reason: result.finishReason ?? 'stop' }],
        usage: { prompt_tokens: result.totalUsage.prompt_tokens, completion_tokens: result.totalUsage.completion_tokens, total_tokens: result.totalUsage.prompt_tokens + result.totalUsage.completion_tokens },
        x_supermodel_usage: result.byRoleUsage
      };
    } catch (err: any) {
      return reply.status(500).send({ error: { message: 'Upstream API error', type: 'api_error', code: 'upstream_error' } });
    }
  });

  fastify.get('/v1/models', async (req: any, reply: any) => {
    const models: any[] = [];
    if (configRegistry.loadedInstances) {
      for (const [instName, inst] of configRegistry.loadedInstances) {
        for (const [flowName] of inst.flows) {
          // Use instName/flowName as canonical id to guarantee uniqueness across instances
          // Also expose bare flowName as an alias in the display name for convenience
          models.push({
            id: `${instName}/${flowName}`,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'supermodel',
            // Non-standard field for UX: show human-readable name
            display_name: flowName
          });
        }
      }
    }
    return { object: 'list', data: models };
  });
}
