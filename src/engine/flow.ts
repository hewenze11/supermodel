import { v4 as uuidv4 } from 'uuid';
import { promises as dns } from 'dns';
import { MessageList } from './message-list';
import { LLMClient, ChatCompletionRequest, StreamChunk } from '../llm/client';
import { buildOpenAITools, executeToolCall, ToolCall } from './tool-runner';
import { publishCancel, subscribeCancel } from '../redis';
import { db } from '../db';
import { RoleConfig, FlowConfig, NodeConfig, SerialNodeConfig, ParallelNodeConfig, ToolNodeConfig, ToolConfig } from '../config/types';

// ============================================================
// combineAbortSignals: polyfill for AbortSignal.any() (Node 20+)
// Falls back to addEventListener bridge for older Node versions
// ============================================================
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  // Use native AbortSignal.any if available (Node 20+)
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any(signals);
  }
  // Polyfill: bridge all signals into a new controller
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  for (const sig of signals) {
    if (sig.aborted) { ctrl.abort(); break; }
    sig.addEventListener('abort', onAbort, { once: true });
  }
  // Cleanup listeners when combined signal fires
  ctrl.signal.addEventListener('abort', () => {
    for (const sig of signals) sig.removeEventListener('abort', onAbort);
  }, { once: true });
  return ctrl.signal;
}
// Performs both static regex check AND DNS resolution check (defeats DNS rebinding)
// ============================================================
const PRIVATE_IP_REGEX = [
  /^127\./,                           // loopback IPv4
  /^0\./,                             // 0.x.x.x
  /^10\./,                            // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,      // RFC1918
  /^192\.168\./,                      // RFC1918
  /^169\.254\./,                      // link-local
  /^::1$/,                            // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,                 // IPv6 unique local
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,                          // IPv6 link-local
  /^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,1}$/,  // ::
];

function isPrivateAddress(addr: string): boolean {
  return PRIVATE_IP_REGEX.some(re => re.test(addr));
}

async function validateToolEndpoint(endpoint: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Tool endpoint is not a valid URL: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Tool endpoint must use http(s): ${endpoint}`);
  }
  const hostname = url.hostname;
  // Static check first (catches localhost/literal IPs without DNS cost)
  if (isPrivateAddress(hostname) || hostname === 'localhost') {
    throw new Error(`Tool endpoint points to a private/loopback address which is not allowed: ${endpoint}`);
  }
  // DNS resolution check to defeat DNS rebinding / split-horizon DNS
  try {
    const result = await dns.lookup(hostname, { all: true });
    for (const { address } of result) {
      if (isPrivateAddress(address)) {
        throw new Error(`Tool endpoint DNS resolves to a private address (${address}), which is not allowed: ${endpoint}`);
      }
    }
  } catch (err: any) {
    if (err.message?.includes('not allowed')) throw err;
    // DNS lookup failure is itself a security signal — reject
    throw new Error(`Tool endpoint DNS lookup failed for ${hostname}: ${err.message}`);
  }
}

// ============================================================
// 控制信号正则：在末尾 1KB 内查找 terminate/route 信号
// 架构书 M2.5：terminate → {"signal":"terminate"} 或 {"signal":"terminate"...}
//             route    → {"route":"flowId"} (route 字段，非 signal)
//             terminate 优先于 route
// ============================================================
const TERMINATE_REGEX = /\{"signal"\s*:\s*"terminate"[^}]*\}/;
const ROUTE_REGEX = /\{"route"\s*:\s*"([^"]+)"[^}]*\}/;

function extractSignal(text: string): { signal: 'terminate' | 'route'; target?: string } | null {
  const tail = text.slice(-1024);
  // terminate 优先
  if (TERMINATE_REGEX.test(tail)) return { signal: 'terminate' };
  // route 次之
  const routeMatch = ROUTE_REGEX.exec(tail);
  if (routeMatch) return { signal: 'route', target: routeMatch[1] };
  return null;
}

function stripSignal(text: string): string {
  const tail = text.slice(-1024);
  const terminateMatch = TERMINATE_REGEX.exec(tail);
  if (terminateMatch) {
    const idx = text.lastIndexOf(terminateMatch[0]);
    return idx !== -1 ? text.slice(0, idx).trimEnd() : text;
  }
  const routeMatch = ROUTE_REGEX.exec(tail);
  if (routeMatch) {
    const idx = text.lastIndexOf(routeMatch[0]);
    return idx !== -1 ? text.slice(0, idx).trimEnd() : text;
  }
  return text;
}

// ============================================================
// FlowExecutionResult
// ============================================================
export interface FlowExecutionResult {
  id: string;
  status: 'completed' | 'failed' | 'timeout' | 'aborted' | 'max_rounds_reached';
  output: string;
  rounds: number;
  finishReason: string | null;
  totalUsage: { prompt_tokens: number; completion_tokens: number };
  byRoleUsage: Record<string, { prompt_tokens: number; completion_tokens: number }>;
}

const SQL_INSERT_FLOW = 'INSERT INTO flow_executions (id, instance_name, flow_name, status, started_at, total_rounds) VALUES ($1,$2,$3,$4,$5,$6)';
const SQL_UPDATE_FLOW_FAILED = 'UPDATE flow_executions SET status=\'failed\', finish_reason=$1, finished_at=$2, total_rounds=$3 WHERE id=$4 AND status=\'running\'';
const SQL_UPDATE_FLOW_DONE = 'UPDATE flow_executions SET status=$1, finish_reason=$2, finished_at=$3, total_rounds=$4 WHERE id=$5 AND status=\'running\'';
const SQL_UPDATE_FLOW_ABORTED = 'UPDATE flow_executions SET status=\'aborted\', finished_at=$1, finish_reason=\'cancelled_by_user\' WHERE id=$2';
const SQL_INSERT_NODE = 'INSERT INTO node_executions (id, flow_execution_id, node_id, role_id, round, status, started_at, input_messages_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)';
const SQL_INSERT_NODE_PARALLEL = 'INSERT INTO node_executions (id, flow_execution_id, node_id, role_id, round, parallel_index, status, started_at, input_messages_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)';
const SQL_UPDATE_NODE_SUCCESS = 'UPDATE node_executions SET status=\'success\', finished_at=$1, output_text=$2, prompt_tokens=$3, completion_tokens=$4 WHERE id=$5';
const SQL_UPDATE_NODE_FAILED = 'UPDATE node_executions SET status=$1, finished_at=$2, error_message=$3 WHERE id=$4';
const SQL_INSERT_USAGE = 'INSERT INTO usage_records (flow_execution_id, node_execution_id, role_id, provider_model, prompt_tokens, completion_tokens) VALUES ($1,$2,$3,$4,$5,$6)';
// ============================================================
// FlowEngine
// ============================================================
export class FlowEngine {
  private activeExecutions: Map<string, AbortController> = new Map();

  // Cancel a running execution
  cancelExecution(executionId: string): boolean {
    const ctrl = this.activeExecutions.get(executionId);
    // Publish to Redis so other replicas can also abort (cross-replica cancel)
    publishCancel(executionId); // fire-and-forget, non-fatal if Redis is down
    if (!ctrl) return false;
    ctrl.abort();
    // Eagerly remove so the slot is freed immediately
    this.activeExecutions.delete(executionId);
    // Immediately mark as aborted in DB (main loop may be stuck in async await)
    try {
      db.query(SQL_UPDATE_FLOW_ABORTED, [Date.now(), executionId]).catch(() => { /* ignore DB error on cancel */ });
    } catch { /* ignore DB error on cancel */ }
    return true;
  }

  // Non-streaming execute
  async executeFlow(
    flowConfig: FlowConfig,
    roles: Map<string, RoleConfig>,
    tools: Map<string, ToolConfig>,
    initialInput: string,
    instanceName: string,
    abortController?: AbortController
  ): Promise<FlowExecutionResult> {
    // Drive the generator manually to capture the return value (not yielded)
    const gen = this.executeFlowStreaming(flowConfig, roles, tools, initialInput, instanceName, abortController);
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        // value here is the FlowExecutionResult return value
        return value as FlowExecutionResult;
      }
      // Ignore yielded stream chunks in non-streaming mode
    }
  }

  // Main streaming execute — yields SSE-compatible StreamChunk objects
  async *executeFlowStreaming(
    flowConfig: FlowConfig,
    roles: Map<string, RoleConfig>,
    tools: Map<string, ToolConfig>,
    initialInput: string,
    instanceName: string,
    abortController?: AbortController
  ): AsyncGenerator<StreamChunk, FlowExecutionResult, void> {
    const executionId = uuidv4();
    const abort = abortController ?? new AbortController();
    this.activeExecutions.set(executionId, abort);

    // Subscribe to Redis cancel channel so other replicas can abort this execution
    const unsubscribeCancel = subscribeCancel(executionId, () => {
      if (!abort.signal.aborted) {
        abort.abort();
        this.activeExecutions.delete(executionId);
      }
    });

    const messageList = new MessageList();
    messageList.addMessage({ role: 'user', content: initialInput });

    const now = Date.now();
    await db.query(SQL_INSERT_FLOW, [executionId, instanceName, flowConfig.id, 'running', now, 0]);

    // P0 guard: validate nodes before any iteration (undefined nodes would throw TypeError)
    if (!flowConfig.nodes?.length) throw new Error(`Flow '${flowConfig.id}' has no nodes`);

    const nodeMap = new Map<string, NodeConfig>();
    for (const n of flowConfig.nodes) nodeMap.set(n.id, n);

    if (flowConfig.output_node && !nodeMap.has(flowConfig.output_node)) {
      throw new Error(`Flow '${flowConfig.id}' output_node '${flowConfig.output_node}' not found in nodes`);
    }

    const maxRounds = flowConfig.max_rounds ?? 10;
    let judgeRounds = 0;
    let outputText = '';
    let finishReason: string | null = null;
    let totalPrompt = 0;
    let totalCompletion = 0;
    const byRoleUsage: Record<string, { prompt_tokens: number; completion_tokens: number }> = {};

    // Execution log: tracks each node visit for the final summary
    interface NodeLog { nodeId: string; roleId: string; status: 'ok' | 'failed' | 'timeout' | 'skipped'; durationMs?: number; note?: string; }
    const executionLog: NodeLog[] = [];

    // flow-level timeout: read from flowConfig, fallback to 300s (5 min), clamp 1s-3600s
    const FLOW_TIMEOUT_MS = Math.min(Math.max((flowConfig.timeout_seconds ?? 300) * 1000, 1000), 3600_000);
    let abortedByGlobalTimeout = false;
    const flowTimer = setTimeout(() => {
      abortedByGlobalTimeout = true;
      abort.abort();
    }, FLOW_TIMEOUT_MS);

    const addUsage = (roleId: string, prompt: number, completion: number) => {
      totalPrompt += prompt;
      totalCompletion += completion;
      if (!byRoleUsage[roleId]) byRoleUsage[roleId] = { prompt_tokens: 0, completion_tokens: 0 };
      byRoleUsage[roleId].prompt_tokens += prompt;
      byRoleUsage[roleId].completion_tokens += completion;
    };

    try {
      // Walk nodes following next pointers
      let currentNodeId: string = flowConfig.nodes[0].id;
      let round = 0;

      while (true) {
        if (abort.signal.aborted) {
          const abortReason = abortedByGlobalTimeout ? 'global_timeout' : 'cancelled_by_user';
          const abortStatus = abortedByGlobalTimeout ? 'timeout' : 'aborted';
          await db.query(SQL_UPDATE_FLOW_DONE, [abortStatus, abortReason, Date.now(), round, executionId]);
          return { id: executionId, status: abortStatus, output: outputText, rounds: round, finishReason: abortReason, totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion }, byRoleUsage };
        }

        const node = nodeMap.get(currentNodeId);
        if (!node) throw new Error(`Node not found: ${currentNodeId}`);
        round++;

        // ---- Serial node ----
        if (node.type === 'serial') {
          const sNode = node as SerialNodeConfig;
          const role = roles.get(sNode.role_id);
          if (!role) throw new Error(`Role not found: ${sNode.role_id}`);

          const nodeExecId = uuidv4();
          const contextWindow = role.context_window ?? 32000;
          const systemBudget = role.system_token_budget ?? 2000;
          const systemPrompt = [
            role.system_prompt_extra ?? '',
            sNode.prompt
          ].filter(Boolean).join('\n\n');

          const limit = contextWindow - systemBudget;
          const msgs = messageList.buildMessages(systemPrompt, {
            context_window: contextWindow,
            system_token_budget: systemBudget,
            system_prompt_extra: role.system_prompt_extra
          });
          const snapshot = messageList.getInputMessagesSnapshot();

          await db.query(SQL_INSERT_NODE, [nodeExecId, executionId, sNode.id, sNode.role_id, round, 'running', Date.now(), snapshot]);
          const nodeStartMs = Date.now();

          const client = new LLMClient({
            provider_type: role.provider_type ?? 'openai',
            model: role.provider_model,
            api_key: role.api_key,
            base_url: role.base_url,
            max_tokens: role.max_tokens
          });

          let nodeOutput = '';
          let nodePrompt = 0;
          let nodeCompletion = 0;

          // NODE_TIMEOUT_MS: per-node LLM call timeout (default 60s, max 600s)
          const nodeTimeoutMs = Math.min(
            parseInt(process.env.NODE_TIMEOUT_MS || '60000', 10),
            600_000
          );
          const nodeAbort = new AbortController();
          const nodeTimer = setTimeout(() => nodeAbort.abort(), nodeTimeoutMs);
          // Combine flow abort + node timeout, with polyfill for older Node
          const combinedSignal = combineAbortSignals(abort.signal, nodeAbort.signal);

          // Resolve tool configs for this node
          const nodeToolConfigs: ToolConfig[] = [];
          if (sNode.tools && sNode.tools.length > 0) {
            for (const toolId of sNode.tools) {
              const tc = tools.get(toolId);
              if (tc) nodeToolConfigs.push(tc);
            }
          }
          const openAITools = nodeToolConfigs.length > 0 ? buildOpenAITools(nodeToolConfigs) : undefined;

          try {
            // Is this the output node — we stream to client
            const isOutputNode = (sNode.id === flowConfig.output_node);

            // ── Tool-call loop (non-streaming) ──────────────────────────────
            // If this node has tools, run a non-streaming tool-call loop first,
            // then do a final streaming pass for the output node.
            let toolCallMsgs = [...msgs];
            if (openAITools && openAITools.length > 0) {
              const MAX_TOOL_ROUNDS = 10;
              for (let tr = 0; tr < MAX_TOOL_ROUNDS; tr++) {
                const tcResp = await client.chatCompletion({
                  messages: toolCallMsgs,
                  model: role.provider_model,
                  signal: combinedSignal,
                  // Pass tools in extra fields (typed as any to avoid TS error on non-standard field)
                  ...(openAITools ? { tools: openAITools, tool_choice: 'auto' } : {})
                } as any);

                const choice = tcResp.choices?.[0];
                const finReason = choice?.finish_reason;
                const assistantMsg = choice?.message;

                if (tcResp.usage) {
                  nodePrompt += tcResp.usage.prompt_tokens;
                  nodeCompletion += tcResp.usage.completion_tokens;
                }

                if (finReason === 'tool_calls' && assistantMsg?.tool_calls) {
                  // Append assistant message with tool_calls
                  toolCallMsgs.push(assistantMsg as any);
                  // Execute each tool call
                  const toolResults = await Promise.all(
                    (assistantMsg.tool_calls as unknown as ToolCall[]).map(tc =>
                      executeToolCall(tc, tools, combinedSignal)
                    )
                  );
                  // Append tool results as tool messages
                  for (const tr2 of toolResults) {
                    toolCallMsgs.push({
                      role: 'tool' as any,
                      tool_call_id: tr2.tool_call_id,
                      content: tr2.content
                    } as any);
                  }
                  console.log(`[tool-call] node=${sNode.id} round=${tr + 1} tools=${assistantMsg.tool_calls.length}`);
                  continue; // loop
                }

                // No more tool calls — capture content and break
                if (assistantMsg?.content) {
                  nodeOutput = assistantMsg.content as string;
                }
                break;
              }

              // If output node: re-run streaming with updated context (no tools this time) for SSE delivery
              if (isOutputNode && nodeOutput) {
                // We already have the output from tool-call loop, re-stream it as chunks
                // by yielding a single synthetic chunk
                const syntheticChunk: StreamChunk = {
                  id: `chatcmpl-tool-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: role.provider_model,
                  choices: [{ index: 0, delta: { role: 'assistant', content: nodeOutput }, finish_reason: null }],
                  usage: undefined
                };
                yield syntheticChunk;
              }
            } else {
              // ── Normal streaming path (no tools) ──────────────────────────
              for await (const chunk of client.streamChatCompletion({
                messages: msgs,
                model: role.provider_model,
                stream: true,
                stream_options: { include_usage: true },
                signal: combinedSignal
              })) {
                if (combinedSignal.aborted) break;
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                  nodeOutput += delta;
                  if (isOutputNode) yield chunk;
                }
                if (chunk.usage) {
                  nodePrompt = chunk.usage.prompt_tokens;
                  nodeCompletion = chunk.usage.completion_tokens;
                }
              }
            }
            clearTimeout(nodeTimer);
          } catch (err: any) {
            if (err.name === 'AbortError' || err.message?.includes('aborted')) {
              clearTimeout(nodeTimer);
              // Distinguish: flow-level abort (global timeout or user cancel) vs node timeout
              if (abort.signal.aborted) {
                // Flow-level abort — let the outer while-loop handle DB update on next iteration
                await db.query(SQL_UPDATE_NODE_FAILED, ['aborted', Date.now(), 'Aborted by flow cancellation', nodeExecId]);
                executionLog.push({ nodeId: sNode.id, roleId: sNode.role_id, status: 'failed', durationMs: Date.now() - nodeStartMs, note: 'Aborted by flow cancellation' });
                // Re-check abort at top of loop
                continue;
              }
              // Node-level timeout only
              await db.transaction(async (client) => {
                await client.query(SQL_UPDATE_NODE_FAILED, ['timeout', Date.now(), 'Node execution timed out', nodeExecId]);
                await client.query(SQL_UPDATE_FLOW_FAILED, ['node_timeout', Date.now(), round, executionId]);
              });
              executionLog.push({ nodeId: sNode.id, roleId: sNode.role_id, status: 'timeout', durationMs: Date.now() - nodeStartMs, note: 'Node execution timed out' });
              return { id: executionId, status: 'timeout', output: outputText, rounds: round, finishReason: 'node_timeout', totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion }, byRoleUsage };
            }
            await db.transaction(async (client) => {
              await client.query(SQL_UPDATE_NODE_FAILED, ['failed', Date.now(), err.message ?? 'Unknown error', nodeExecId]);
              await client.query(SQL_UPDATE_FLOW_FAILED, ['node_error', Date.now(), round, executionId]);
            });
            executionLog.push({ nodeId: sNode.id, roleId: sNode.role_id, status: 'failed', durationMs: Date.now() - nodeStartMs, note: err.message ?? 'Unknown error' });
            throw err;
          }

          await db.transaction(async (client) => {
            await client.query(SQL_UPDATE_NODE_SUCCESS, [Date.now(), nodeOutput.slice(0, 4000), nodePrompt, nodeCompletion, nodeExecId]);
            await client.query(SQL_INSERT_USAGE, [executionId, nodeExecId, sNode.role_id, role.provider_model, nodePrompt, nodeCompletion]);
          });
          addUsage(sNode.role_id, nodePrompt, nodeCompletion);
          executionLog.push({ nodeId: sNode.id, roleId: sNode.role_id, status: 'ok', durationMs: Date.now() - nodeStartMs });

          // Check if judge (has next = loop back toward first node) — increment judgeRounds
          if (sNode.next) judgeRounds++;

          // Check for terminate/route signal
          const sig = extractSignal(nodeOutput);
          const cleanOutput = sig ? stripSignal(nodeOutput) : nodeOutput;

          console.log(`[node-output] node=${sNode.id} isOutputNode=${sNode.id === flowConfig.output_node} rawLen=${nodeOutput.length} cleanLen=${cleanOutput.length} sig=${JSON.stringify(sig)}`);

          // Update output if this is output_node
          if (sNode.id === flowConfig.output_node) {
            outputText = cleanOutput;
          }

          // Append to messageList
          messageList.addMessage({ role: 'assistant', content: cleanOutput });

          if (sig?.signal === 'terminate') {
            finishReason = 'terminate';
            break;
          }
          if (sig?.signal === 'route' && sig.target) {
            currentNodeId = sig.target;
            continue;
          }

          // Max rounds guard
          if (judgeRounds >= maxRounds) {
            finishReason = 'max_rounds_reached';
            break;
          }

          // Advance to next node
          if (sNode.next) {
            currentNodeId = sNode.next;
          } else {
            // No next → this is the terminal node
            if (sNode.id !== flowConfig.output_node) {
              outputText = cleanOutput;
            }
            finishReason = 'stop';
            break;
          }
        }

        // ---- Parallel node ----
        else if (node.type === 'parallel') {
          const pNode = node as ParallelNodeConfig;
          const timeoutMs = (pNode.timeout_seconds ?? 60) * 1000;
          const nodeExecIds: string[] = [];

          const tasks = pNode.roles.map((roleId, idx) => {
            const role = roles.get(roleId);
            if (!role) return Promise.resolve({ roleId, output: null as string | null, error: 'Role not found', prompt: 0, completion: 0 });

            const nodeExecId = uuidv4();
            nodeExecIds.push(nodeExecId);
            const contextWindow = role.context_window ?? 32000;
            const systemBudget = role.system_token_budget ?? 2000;
            const systemPrompt = [role.system_prompt_extra ?? '', pNode.prompt].filter(Boolean).join('\n\n');

            const msgs = messageList.buildMessages(systemPrompt, { context_window: contextWindow, system_token_budget: systemBudget });
            const snapshot = messageList.getInputMessagesSnapshot();

            const client = new LLMClient({ provider_type: role.provider_type ?? 'openai', model: role.provider_model, api_key: role.api_key, base_url: role.base_url, max_tokens: role.max_tokens });

            return new Promise<{ roleId: string; nodeExecId: string; output: string | null; error: string | null; prompt: number; completion: number }>(async (resolve) => {
              // Insert node execution record (inside async Promise to use await)
              await db.query(SQL_INSERT_NODE_PARALLEL, [nodeExecId, executionId, pNode.id, roleId, round, idx, 'running', Date.now(), snapshot]);
              let output = '';
              let prompt = 0;
              let completion = 0;
              const nodeAbort = new AbortController();
              const timer = setTimeout(() => nodeAbort.abort(), timeoutMs);
              // Combine flow-level abort with node timeout (P1 fix: parallel node respects flow cancel)
              const parallelCombinedSignal = combineAbortSignals(abort.signal, nodeAbort.signal);
              try {
                for await (const chunk of client.streamChatCompletion({ messages: msgs, model: role.provider_model, stream: true, stream_options: { include_usage: true }, signal: parallelCombinedSignal })) {
                  if (parallelCombinedSignal.aborted) break;
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) output += delta;
                  if (chunk.usage) { prompt = chunk.usage.prompt_tokens; completion = chunk.usage.completion_tokens; }
                }
                clearTimeout(timer);
                await db.query(SQL_UPDATE_NODE_SUCCESS, [Date.now(), output.slice(0, 4000), prompt, completion, nodeExecId]);
                resolve({ roleId, nodeExecId, output, error: null, prompt, completion });
              } catch (err: any) {
                clearTimeout(timer);
                await db.query(SQL_UPDATE_NODE_FAILED, [nodeAbort.signal.aborted ? 'timeout' : 'failed', Date.now(), err.message ?? 'Unknown', nodeExecId]);
                resolve({ roleId, nodeExecId, output: null, error: err.message ?? 'Unknown', prompt, completion });
              }
            });
          });

          const results = await Promise.allSettled(tasks);

          // Merge outputs
          let mergedParts: string[] = [];
          let allFailed = true;
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const roleId = pNode.roles[i];
            const role = roles.get(roleId);
            const modelName = role?.provider_model ?? roleId;
            if (r.status === 'fulfilled') {
              const v = r.value as any;
              if (v.output !== null) {
                allFailed = false;
                mergedParts.push(`=== 幕僚 ${roleId} (${modelName}) 审查结果 ===\n${v.output}`);
                await db.query(SQL_INSERT_USAGE, [executionId, v.nodeExecId, roleId, modelName, v.prompt, v.completion]);
                addUsage(roleId, v.prompt, v.completion);
                executionLog.push({ nodeId: pNode.id, roleId, status: 'ok' });
              } else {
                mergedParts.push(`=== 注意：${roleId} 执行失败（${v.error}），该视角缺失 ===`);
                executionLog.push({ nodeId: pNode.id, roleId, status: 'failed', note: v.error });
              }
            } else {
              mergedParts.push(`=== 注意：${roleId} 执行失败，该视角缺失 ===`);
              executionLog.push({ nodeId: pNode.id, roleId, status: 'failed', note: 'Promise rejected' });
            }
          }

          if (allFailed) {
            await db.query(SQL_UPDATE_FLOW_FAILED, ['all_parallel_failed', Date.now(), round, executionId]);
            return { id: executionId, status: 'failed', output: outputText, rounds: round, finishReason: 'all_parallel_failed', totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion }, byRoleUsage };
          }

          const mergedText = '[审查意见]\n' + mergedParts.join('\n\n');
          messageList.addMessage({ role: 'user', content: mergedText });

          if (pNode.next) {
            currentNodeId = pNode.next;
          } else {
            outputText = mergedText;
            finishReason = 'stop';
            break;
          }
        }

        // ---- Tool node ----
        else if (node.type === 'tool') {
          const tNode = node as ToolNodeConfig;
          const tool = tools.get(tNode.tool_ref);
          if (!tool) throw new Error(`Tool not found: ${tNode.tool_ref}`);

          const nodeExecId = uuidv4();
          const lastMsg = messageList.getMessages();
          const input = lastMsg.length > 0 ? lastMsg[lastMsg.length - 1].content : '';
          await db.query(SQL_INSERT_NODE, [nodeExecId, executionId, tNode.id, 'tool:' + tNode.tool_ref, round, 'running', Date.now(), JSON.stringify([{ role: 'tool_input', content: input }])]);

          const toolTimeoutMs = (tool.timeout_seconds ?? 30) * 1000;
          const toolAbort = new AbortController();
          const toolTimer = setTimeout(() => toolAbort.abort(), toolTimeoutMs);
          // Combine flow-level abort with tool timeout (P1 fix: tool respects flow cancel)
          const toolCombinedSignal = combineAbortSignals(abort.signal, toolAbort.signal);
          try {
            // SSRF guard: validate endpoint before fetch
            await validateToolEndpoint(tool.endpoint);
            const resp = await fetch(tool.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(tool.headers ?? {}) },
              body: JSON.stringify({ input, context: { instance_name: instanceName, flow_name: flowConfig.id, node_id: tNode.id, round, call_mode: 'direct' } }),
              signal: toolCombinedSignal
            });
            clearTimeout(toolTimer);
            if (!resp.ok) throw new Error(`Tool HTTP ${resp.status}`);
            const body: any = await resp.json();
            if (body.status !== 'success') throw new Error(body.error_message ?? 'Tool returned non-success');
            await db.query(SQL_UPDATE_NODE_SUCCESS, [Date.now(), String(body.output).slice(0, 4000), 0, 0, nodeExecId]);
            messageList.addMessage({ role: 'user', content: `[工具执行结果 - ${tNode.tool_ref}]: ${body.output}` });
          } catch (err: any) {
            clearTimeout(toolTimer);
            await db.transaction(async (client) => {
              await client.query(SQL_UPDATE_NODE_FAILED, [toolAbort.signal.aborted ? 'timeout' : 'failed', Date.now(), err.message, nodeExecId]);
              await client.query(SQL_UPDATE_FLOW_FAILED, ['tool_error', Date.now(), round, executionId]);
            });
            throw err;
          }

          if (tNode.next) {
            currentNodeId = tNode.next;
          } else {
            finishReason = 'stop';
            break;
          }
        }

        else {
          throw new Error(`Unknown node type: ${(node as any).type}`);
        }
      }

      // Finalize flow
      const status = finishReason === 'max_rounds_reached' ? 'completed' : 'completed';
      await db.query(SQL_UPDATE_FLOW_DONE, [status, finishReason ?? 'stop', Date.now(), round, executionId]);

      // Build execution summary and yield as extra SSE content (only for multi-node flows or if any issue)
      // NOTE: summaryText is NOT mixed into outputText to preserve original LLM output integrity in DB
      const hasMultipleNodes = flowConfig.nodes.length > 1;
      const hasAnyIssue = executionLog.some(l => l.status !== 'ok');
      if (hasMultipleNodes || hasAnyIssue) {
        const summaryLines: string[] = [];
        summaryLines.push('\n\n---\n**[执行摘要]**');
        const visited = new Set<string>();
        for (const log of executionLog) {
          const key = `${log.nodeId}:${log.roleId}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const icon = log.status === 'ok' ? '✅' : log.status === 'timeout' ? '⏱️' : '❌';
          let line = `\n${icon} ${log.nodeId} (${log.roleId})`;
          if (log.durationMs !== undefined) line += ` — ${(log.durationMs / 1000).toFixed(1)}s`;
          if (log.note && log.status !== 'ok') line += ` — ${log.note}`;
          summaryLines.push(line);
        }
        if (finishReason === 'max_rounds_reached') {
          summaryLines.push(`\n⚠️ 达到最大轮次上限 (${maxRounds})，提前终止`);
        }
        const summaryText = summaryLines.join('');
        // Yield summary as SSE delta so it appears in the stream — separate from outputText (DB record)
        const summaryChunkId = `chatcmpl-summary-${uuidv4()}`;
        yield {
          id: summaryChunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: instanceName,
          choices: [{ index: 0, delta: { content: summaryText }, finish_reason: null }]
        } as StreamChunk;
      }

      const flowResult: FlowExecutionResult = { id: executionId, status: 'completed', output: outputText, rounds: round, finishReason, totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion }, byRoleUsage };
      // Yield a marker chunk so streaming consumers (inference route) can capture the result
      yield { __flowResult: flowResult } as unknown as StreamChunk;
      return flowResult;

    } catch (err: any) {
      await db.query(SQL_UPDATE_FLOW_FAILED, [err.message ?? 'unknown_error', Date.now(), 0, executionId]);
      throw err;
    } finally {
      clearTimeout(flowTimer);
      this.activeExecutions.delete(executionId);
      unsubscribeCancel();
    }
  }
}



