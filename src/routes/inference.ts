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
//   enterprise       = 0（不限，fast-path）
//
// plan 来源：用已验证的 memcoreToken 打 MemCore /user/me，带 Redis 缓存（60s）
// userId 来源：buildMemcoreToken 内已经 jwt.verify 验签，可信；直接 verify memcoreToken 取 userId

const PLAN_RATE_MAP: Record<string, number> = {
  free: 1,
  personal: 1,
  developer: 10,
  enterprise: 0,  // 0 = 不限
};
const PLAN_CACHE_TTL_S = 60;

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
  -- 只在 key 首次写入时设 TTL，避免高频被限速用户的 key 被不断续期（内存泄漏）
  if redis.call('ttl', key) == -1 then
    redis.call('expire', key, math.ceil(window / 1000) + 10)
  end
  return count + 1
`;

/** 从 MemCore /user/me 获取用户套餐（带 Redis 缓存 60s）
 *  查询失败时 fail-open：返回 null 表示"未知"，调用方会跳过限流
 *  不降为 free，避免 MemCore 抖动时误限付费用户 */
async function getUserPlan(memcoreToken: string, userId: string): Promise<string | null> {
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
      // 规范化 plan：统一小写，防止 MemCore 返回 Enterprise/ENTERPRISE 误判
      const plan: string = String(body.plan ?? 'free').toLowerCase();
      try {
        await redisPub.set(cacheKey, plan, 'EX', PLAN_CACHE_TTL_S);
      } catch { /* 缓存写入失败，忽略 */ }
      return plan;
    }
  } catch { /* MemCore 查询失败 */ }

  // fail-open：查询失败不降为 free（避免误限付费用户），返回 null 跳过限流
  return null;
}

/** 按账号套餐限制爬虫调用频率，返回 false 表示已发 429 */
async function applyCrawlerRateLimit(
  userId: string,
  plan: string,
  reply: any
): Promise<boolean> {
  // plan 规范化确保命中 PLAN_RATE_MAP；未知套餐 fallback 1（保守兜底）
  const limit = PLAN_RATE_MAP[plan] ?? 1;
  if (limit <= 0) return true;  // 0 = 不限速（企业版）

  const key = `supermodel:crawler_rate:${userId}`;
  const now = Date.now();
  const windowMs = 3000;
  const member = `${now}-${crypto.randomUUID()}`;

  try {
    const result = await redisPub.eval(
      CRAWLER_RATE_LUA,
      1,
      key,
      String(now), String(windowMs), String(limit), member
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

/**
 * 从 MemCore 获取 workspace 的 user_system_prompt（带 Redis 缓存 60s）
 * P1-2 修复：作为独立段注入，不拼进官方 system prompt
 * fail-open：查询失败返回 null，不影响主流程
 */
async function getWorkspaceUserPrompt(memcoreToken: string, workspaceId?: string): Promise<string | null> {
  if (!workspaceId) return null;
  const cacheKey = `supermodel:ws_prompt:${workspaceId}`;
  try {
    const cached = await redisPub.get(cacheKey);
    if (cached !== null) return cached === '' ? null : cached;
  } catch { /* Redis 不可用，继续查 API */ }

  try {
    const resp = await fetch(`${MEMCORE_BASE_URL}/workspaces/${workspaceId}`, {
      headers: { Authorization: `Bearer ${memcoreToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const body = await resp.json() as any;
      const prompt: string | null = body.user_system_prompt ?? null;
      try {
        // 缓存 60s，空字符串表示"已查过但为空"
        await redisPub.set(cacheKey, prompt ?? '', 'EX', 60);
      } catch { /* 缓存写入失败，忽略 */ }
      return prompt;
    }
  } catch { /* MemCore 查询失败，fail-open */ }
  return null;
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

    // M0 多租户：透传 x-workspace-id 给 MemCore，让 authResolution 使用正确的子 workspace
    // 客户端每个实例对应一个独立 workspace，通过此 header 指定，MemCore 会校验归属关系
    // 安全说明：MemCore 侧会用 ownerCheck 验证该 workspace 确属当前用户，这里只做格式校验
    const rawWorkspaceId = req.headers['x-workspace-id'];
    const workspaceIdHeader = Array.isArray(rawWorkspaceId) ? rawWorkspaceId[0] : rawWorkspaceId;
    // UUID 格式校验，防止非法值透传
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validWorkspaceId = workspaceIdHeader && UUID_RE.test(workspaceIdHeader.trim())
      ? workspaceIdHeader.trim()
      : undefined;
    if (validWorkspaceId) {
      extraHeaders['x-workspace-id'] = validWorkspaceId;  // 统一小写 key
    }

    // ── 爬虫调用频率限制（按账号套餐，3秒滑动窗口） ────────────────────────
    // 只对携带 X-User-Token 的请求限速（MemCore 用户）。
    // 无 token 的匿名/内部调用跳过，由外层 API key 鉴权已保护。
    if (memcoreToken && userToken) {
      // 用 jwt.verify（验签）取 userId，而不是 jwt.decode（不验签）
      // memcoreToken 由 buildMemcoreToken 内部验签后签出，此处再 verify 确保安全
      let userId: string | null = null;
      try {
        const p = jwt.verify(memcoreToken, MEMCORE_JWT_SECRET, {
          issuer: 'memcore',
          algorithms: ['HS256'],
        }) as any;
        userId = p?.user_id ?? null;
      } catch { /* token 无效，跳过限流（上游鉴权已处理） */ }

      if (userId) {
        const plan = await getUserPlan(memcoreToken, userId);
        if (plan === null) {
          // getUserPlan 查询失败，fail-open：放行，不误限付费用户
        } else {
          const allowed = await applyCrawlerRateLimit(userId, plan, reply);
          if (!allowed) return;  // 429 已发送
        }
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

    // M17: 注入用户自定义提示词（作为独立段，不拼入官方 system prompt）
    // 使用 validWorkspaceId（已格式校验），避免注入非法值
    // 鉴权说明：promptToken 使用用户级 memcoreToken，MemCore 侧会校验 workspace 归属
    const workspaceApiKey = req.headers['x-workspace-token'] as string | undefined;
    const promptToken = workspaceApiKey || memcoreToken;
    if (promptToken && validWorkspaceId) {
      const userPrompt = await getWorkspaceUserPrompt(promptToken, validWorkspaceId);
      if (userPrompt) {
        // 防止提示词标签逃逸：转义闭合标签，防止用户 prompt 中包含 [/User-Workspace-Instructions] 闭合标签
        // 转义开标签和闭标签，防止提示词协议注入/逃逸
        const safePrompt = userPrompt
          .replace(/\[User-Workspace-Instructions\]/gi, '[User-Workspace-Instructions\\]')
          .replace(/\[\/User-Workspace-Instructions\]/gi, '[/User-Workspace-Instructions\\]');
        initialInput += `\n\n[User-Workspace-Instructions]\n${safePrompt}\n[/User-Workspace-Instructions]`;
      }
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
