import { FastifyInstance } from 'fastify';
import crypto from 'crypto';

import { ConfigRegistry } from '../config/types';
import { ConfigLoader } from '../config/loader';
import { FlowEngine } from '../engine/flow';
import { SSEWriter } from '../sse/writer';
import { db } from '../db';

interface AdminRoutesOptions {
  configRegistry: ConfigRegistry;
  flowEngine: FlowEngine;
  updateRegistry: (newRegistry: ConfigRegistry) => void;
  adminPassword: string;
  inferenceApiKeys: string[];
}

function timingSafeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) { crypto.timingSafeEqual(bufA, bufA); return false; }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch { return false; }
}

function authenticateAdmin(req: any, reply: any, adminPassword: string): boolean {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: { message: 'Invalid credentials', type: 'authentication_error' } });
    return false;
  }
  if (!timingSafeEqual(authHeader.slice(7), adminPassword)) {
    reply.status(401).send({ error: { message: 'Invalid credentials', type: 'authentication_error' } });
    return false;
  }
  return true;
}

export async function adminRoutes(fastify: FastifyInstance, options: AdminRoutesOptions) {
  const { configRegistry, flowEngine, updateRegistry, adminPassword, inferenceApiKeys } = options;

  // Auth hook — skip for /admin/auth itself
  fastify.addHook('preHandler', async (req: any, reply: any) => {
    if (req.url?.startsWith('/admin/') && req.url !== '/admin/auth') {
      if (!authenticateAdmin(req, reply, adminPassword)) return reply;
    }
  });

  // ── POST /admin/auth ──────────────────────────────────────────────────────
  // Body: { password: string }
  // Returns: { token: string }  (token = adminPassword itself, used as Bearer)
  fastify.post('/admin/auth', async (req: any, reply) => {
    const { password } = req.body as { password?: string };
    if (!password || !timingSafeEqual(password, adminPassword)) {
      return reply.status(401).send({ error: { message: 'Wrong password', type: 'authentication_error' } });
    }
    return { token: adminPassword };
  });

  // ── GET /admin/status ─────────────────────────────────────────────────────
  // Returns full instance/flow/role/tool structure + config snapshot
  fastify.get('/admin/status', async (req: any, reply) => {
    const instances: Record<string, any> = {};
    for (const [instName, inst] of (configRegistry.loadedInstances ?? new Map())) {
      const flows: Record<string, any> = {};
      for (const [flowName, flow] of inst.flows) {
        flows[flowName] = {
          id: flow.id,
          output_node: flow.output_node,
          max_rounds: flow.max_rounds,
          nodes: flow.nodes.map((n: any) => ({
            id: n.id,
            type: n.type,
            role_id: n.role_id,
            roles: n.roles,
            tools: n.tools,
            next: n.next,
          }))
        };
      }
      const roles: Record<string, any> = {};
      for (const [roleId, role] of inst.roles) {
        roles[roleId] = {
          primary: role.primary,
          provider_model: role.provider_model,
          provider_type: role.provider_type,
          context_window: role.context_window,
          // Redact api_key — show last 4 chars only
          api_key_hint: role.api_key ? `****${role.api_key.slice(-4)}` : null,
        };
      }
      const tools: Record<string, any> = {};
      for (const [toolId, tool] of inst.tools) {
        tools[toolId] = { id: tool.id, name: tool.name, description: tool.description, endpoint: tool.endpoint };
      }
      instances[instName] = { flows, roles, tools };
    }

    return {
      status: 'healthy',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      config: {
        port: configRegistry.port,
        admin_port: configRegistry.admin_port,
        log_level: configRegistry.log_level,
        flow_timeout_seconds: configRegistry.flow_timeout_seconds,
        max_concurrent_flows: configRegistry.max_concurrent_flows,
        debug_full_payload: configRegistry.debug_full_payload,
        api_keys: (inferenceApiKeys ?? []).map(k => k.length > 8 ? `${k.slice(0,4)}…${k.slice(-4)}` : '****'),
      },
      instances,
    };
  });

  // ── POST /admin/reload ────────────────────────────────────────────────────
  fastify.post('/admin/reload', async (req: any, reply) => {
    try {
      const newRegistry = await ConfigLoader.getInstance().loadConfigs();
      updateRegistry(newRegistry);
      return { success: true, message: 'Configuration reloaded' };
    } catch (err) {
      return reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ── POST /admin/shutdown ──────────────────────────────────────────────────
  fastify.post('/admin/shutdown', async (req: any, reply) => {
    setImmediate(() => process.emit('SIGTERM' as any));
    return { success: true, message: 'Shutdown initiated' };
  });

  // ── POST /admin/test ──────────────────────────────────────────────────────
  // Body: { model: "instance/flow", messages: [...], stream: true }
  // Acts like /v1/chat/completions but authenticated via admin password
  fastify.post('/admin/test', async (req: any, reply) => {
    const { model, messages, stream = true } = req.body as any;

    if (!model || !messages?.length) {
      return reply.status(400).send({ error: { message: 'model and messages required', type: 'invalid_request_error' } });
    }

    // Resolve model
    let instanceName = '', flowId = '';
    if (model.includes('/')) {
      [instanceName, flowId] = model.split('/', 2);
    } else {
      flowId = model;
      instanceName = [...(configRegistry.loadedInstances?.keys() ?? [])][0] ?? '';
    }
    const inst = configRegistry.loadedInstances?.get(instanceName);
    const flowConfig = inst?.flows.get(flowId);
    if (!inst || !flowConfig) {
      return reply.status(404).send({ error: { message: `Model not found: ${model}`, type: 'not_found' } });
    }

    // Build initialInput from messages
    const conversationMsgs = (messages as any[]).filter((m: any) => m.role === 'user' || m.role === 'assistant');
    let initialInput = '';
    if (conversationMsgs.length === 1) {
      initialInput = conversationMsgs[0].content ?? '';
    } else if (conversationMsgs.length > 1) {
      const history = conversationMsgs.slice(0, -1)
        .map((m: any) => `[${m.role === 'user' ? 'User' : 'Assistant'}]: ${m.content}`).join('\n');
      const last = conversationMsgs[conversationMsgs.length - 1];
      initialInput = `Previous conversation:\n${history}\n\n[User]: ${last.content ?? ''}`;
    }

    const abortController = new AbortController();
    req.raw.on('close', () => abortController.abort());

    const streamId = `chatcmpl-test-${Date.now()}`;
    const streamCreated = Math.floor(Date.now() / 1000);

    const sseWriter = new SSEWriter(reply);
    sseWriter.setupHeaders();
    sseWriter.startHeartbeats();

    try {
      // Send first chunk
      await sseWriter.writeChunk({
        id: streamId, object: 'chat.completion.chunk', created: streamCreated, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
      });

      const genResult = flowEngine.executeFlowStreaming(flowConfig, inst.roles, inst.tools, initialInput, instanceName, abortController);
      let flowResult: any = null;
      for await (const chunk of genResult) {
        if ((chunk as any).__flowResult) { flowResult = (chunk as any).__flowResult; continue; }
        await sseWriter.writeChunk(chunk);
      }

      const usageSummary = flowResult ? {
        prompt_tokens: flowResult.totalUsage?.prompt_tokens ?? 0,
        completion_tokens: flowResult.totalUsage?.completion_tokens ?? 0,
        total_tokens: (flowResult.totalUsage?.prompt_tokens ?? 0) + (flowResult.totalUsage?.completion_tokens ?? 0)
      } : undefined;

      const finalChunk: any = {
        id: streamId, object: 'chat.completion.chunk', created: streamCreated, model,
        choices: [{ index: 0, delta: {}, finish_reason: flowResult?.finishReason ?? 'stop' }]
      };
      if (usageSummary) {
        finalChunk.usage = usageSummary;
        finalChunk.x_supermodel_usage = flowResult?.byRoleUsage;
      }
      await sseWriter.writeFinal(finalChunk);
      sseWriter.writeDone();
    } catch (err: any) {
      if (!abortController.signal.aborted && err?.name !== 'AbortError') {
        await sseWriter.writeError('Upstream error: ' + err.message);
      }
    } finally {
      sseWriter.close();
    }
  });

  // ── GET /admin/flows ──────────────────────────────────────────────────────
  // Query: page, page_size
  // Returns: { executions: [...], total: N }
  fastify.get('/admin/flows', async (req: any, reply) => {
    const page = Math.max(1, parseInt((req.query as any).page ?? '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt((req.query as any).page_size ?? '20')));
    const offset = (page - 1) * pageSize;

    const total = (db.prepare('SELECT COUNT(*) as c FROM flow_executions').get() as any)?.c ?? 0;
    const executions = db.prepare(`
      SELECT id, instance_name, flow_name, status, total_rounds as rounds, finish_reason,
             created_at, started_at, finished_at
      FROM flow_executions ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(pageSize, offset);

    return { executions, total, page, page_size: pageSize };
  });

  // ── GET /admin/flows/:id ──────────────────────────────────────────────────
  // Returns: { execution: {...}, node_executions: [...] }
  fastify.get('/admin/flows/:id', async (req: any, reply) => {
    const { id } = req.params as { id: string };

    const execution = db.prepare(`
      SELECT id, instance_name, flow_name, status,
             total_rounds as rounds, finish_reason,
             created_at, started_at, finished_at
      FROM flow_executions WHERE id = ?
    `).get(id) as any;
    if (!execution) return reply.status(404).send({ error: { message: 'Not found', type: 'not_found' } });

    const node_executions = db.prepare(`
      SELECT id, node_id, role_id, status, started_at, finished_at, round,
             prompt_tokens, completion_tokens, output_text, error_message, parallel_index
      FROM node_executions WHERE flow_execution_id = ? ORDER BY started_at ASC
    `).all(id);

    return { execution, node_executions };
  });

  // ── POST /admin/executions/:id/cancel ─────────────────────────────────────
  fastify.post('/admin/executions/:id/cancel', async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const success = flowEngine.cancelExecution(id);
    if (success) return { success: true, message: 'Execution cancelled' };
    return reply.status(404).send({ success: false, error: 'Execution not found or already completed' });
  });
}
