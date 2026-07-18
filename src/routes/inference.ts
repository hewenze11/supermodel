import { FastifyInstance } from 'fastify';
import { ConfigRegistry, FlowConfig, RoleConfig } from '../config/types';
import { FlowEngine } from '../engine/flow';
import { SSEWriter } from '../sse/writer';

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
      return reply.status(404).send({ error: { message: `Model not found: ${model}`, type: 'invalid_request_error', code: 'model_not_found' } });
    }
    const { instanceName, flowConfig, roles, tools } = resolved;

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
      try {
        const genResult = flowEngine.executeFlowStreaming(flowConfig, roles, tools, initialInput, instanceName, abortController);
        let flowResult: any = null;
        for await (const chunk of genResult) {
          // Internal marker chunk carrying FlowExecutionResult — don't forward to client
          if ((chunk as any).__flowResult) {
            flowResult = (chunk as any).__flowResult;
            continue;
          }
          await sseWriter.writeChunk(chunk);
        }
        // Build final chunk with usage + x_supermodel_usage per arch M5
        const usageSummary = flowResult ? {
          prompt_tokens: flowResult.totalUsage?.prompt_tokens ?? 0,
          completion_tokens: flowResult.totalUsage?.completion_tokens ?? 0,
          total_tokens: (flowResult.totalUsage?.prompt_tokens ?? 0) + (flowResult.totalUsage?.completion_tokens ?? 0)
        } : undefined;
        const finalChunk: any = {
          id: `chatcmpl-${flowResult?.id ?? Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: 'assistant' as const, content: '' }, finish_reason: flowResult?.finishReason ?? 'stop' }]
        };
        if (usageSummary) {
          finalChunk.usage = usageSummary;
          finalChunk.x_supermodel_usage = flowResult?.byRoleUsage;
        }
        await sseWriter.writeFinal(finalChunk);
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
      const result = await flowEngine.executeFlow(flowConfig, roles, tools, initialInput, instanceName, abortController);
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
