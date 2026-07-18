import { v4 as uuidv4 } from 'uuid';
import { promises as dns } from 'dns';
import { MessageList } from './message-list';
import { LLMClient, ChatCompletionRequest, StreamChunk } from '../llm/client';
import { db } from '../db';
import { RoleConfig, FlowConfig, NodeConfig, SerialNodeConfig, ParallelNodeConfig, ToolNodeConfig, ToolConfig } from '../config/types';

// ============================================================
// SSRF guard: reject tool endpoints pointing to private/loopback addresses
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

const SQL_INSERT_FLOW = 'INSERT INTO flow_executions (id, instance_name, flow_name, status, started_at, total_rounds) VALUES (?,?,?,?,?,?)';
const SQL_UPDATE_FLOW_TIMEOUT = 'UPDATE flow_executions SET status=\'timeout\', finish_reason=\'global_timeout\', finished_at=? WHERE id=? AND status=\'running\'';
const SQL_UPDATE_FLOW_FAILED = 'UPDATE flow_executions SET status=\'failed\', finish_reason=?, finished_at=?, total_rounds=? WHERE id=? AND status=\'running\'';
const SQL_UPDATE_FLOW_DONE = 'UPDATE flow_executions SET status=?, finish_reason=?, finished_at=?, total_rounds=? WHERE id=? AND status=\'running\'';
const SQL_UPDATE_FLOW_ABORTED = 'UPDATE flow_executions SET status=\'aborted\', finished_at=?, finish_reason=\'cancelled_by_user\' WHERE id=?';
const SQL_INSERT_NODE = 'INSERT INTO node_executions (id, flow_execution_id, node_id, role_id, round, status, started_at, input_messages_json) VALUES (?,?,?,?,?,?,?,?)';
const SQL_INSERT_NODE_PARALLEL = 'INSERT INTO node_executions (id, flow_execution_id, node_id, role_id, round, parallel_index, status, started_at, input_messages_json) VALUES (?,?,?,?,?,?,?,?,?)';
const SQL_UPDATE_NODE_SUCCESS = 'UPDATE node_executions SET status=\'success\', finished_at=?, output_text=?, prompt_tokens=?, completion_tokens=? WHERE id=?';
const SQL_UPDATE_NODE_FAILED = 'UPDATE node_executions SET status=?, finished_at=?, error_message=? WHERE id=?';
const SQL_INSERT_USAGE = 'INSERT INTO usage_records (flow_execution_id, node_execution_id, role_id, provider_model, prompt_tokens, completion_tokens) VALUES (?,?,?,?,?,?)';
// ============================================================
// FlowEngine
// ============================================================
export class FlowEngine {
  private activeExecutions: Map<string, AbortController> = new Map();

  // Cancel a running execution
  cancelExecution(executionId: string): boolean {
    const ctrl = this.activeExecutions.get(executionId);
    if (!ctrl) return false;
    ctrl.abort();
    // Eagerly remove so the slot is freed immediately
    this.activeExecutions.delete(executionId);
    // Immediately mark as aborted in DB (main loop may be stuck in async await)
    try {
      db.prepare(SQL_UPDATE_FLOW_ABORTED).run(Date.now(), executionId);
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

    const messageList = new MessageList();
    messageList.addMessage({ role: 'user', content: initialInput });

    const now = Date.now();
    db.prepare(SQL_INSERT_FLOW).run(executionId, instanceName, flowConfig.id, 'running', now, 0);

    const nodeMap = new Map<string, NodeConfig>();
    for (const n of flowConfig.nodes) nodeMap.set(n.id, n);

    // P0 guard: empty nodes or invalid output_node → fail fast
    if (!flowConfig.nodes?.length) throw new Error(`Flow '${flowConfig.id}' has no nodes`);
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
          db.prepare(SQL_UPDATE_FLOW_DONE).run(abortStatus, abortReason, Date.now(), round, executionId);
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

          db.prepare(SQL_INSERT_NODE).run(nodeExecId, executionId, sNode.id, sNode.role_id, round, 'running', Date.now(), snapshot);

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

          const nodeTimeoutMs = 60_000;
          const nodeAbort = new AbortController();
          const nodeTimer = setTimeout(() => nodeAbort.abort(), nodeTimeoutMs);
          // Use AbortSignal.any to avoid listener leaks (Node 18+)
          const combinedSignal = (AbortSignal as any).any
            ? (AbortSignal as any).any([abort.signal, nodeAbort.signal])
            : abort.signal; // fallback for older Node

          try {
            // Is this the output node — we stream to client
            const isOutputNode = (sNode.id === flowConfig.output_node);

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
            clearTimeout(nodeTimer);
          } catch (err: any) {
            if (err.name === 'AbortError' || err.message?.includes('aborted')) {
              clearTimeout(nodeTimer);
              // Distinguish: flow-level abort (global timeout or user cancel) vs node timeout
              if (abort.signal.aborted) {
                // Flow-level abort — let the outer while-loop handle DB update on next iteration
                db.prepare(SQL_UPDATE_NODE_FAILED).run('failed', Date.now(), 'Aborted by flow cancellation', nodeExecId);
                // Re-check abort at top of loop
                continue;
              }
              // Node-level timeout only
              db.prepare(SQL_UPDATE_NODE_FAILED).run('timeout', Date.now(), 'Node execution timed out', nodeExecId);
              db.prepare(SQL_UPDATE_FLOW_FAILED).run('node_timeout', Date.now(), round, executionId);
              return { id: executionId, status: 'timeout', output: outputText, rounds: round, finishReason: 'node_timeout', totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion }, byRoleUsage };
            }
            db.prepare(SQL_UPDATE_NODE_FAILED).run('failed', Date.now(), err.message ?? 'Unknown error', nodeExecId);
            db.prepare(SQL_UPDATE_FLOW_FAILED).run('node_error', Date.now(), round, executionId);
            throw err;
          }

          db.prepare(SQL_UPDATE_NODE_SUCCESS).run(Date.now(), nodeOutput.slice(0, 4000), nodePrompt, nodeCompletion, nodeExecId);
          db.prepare(SQL_INSERT_USAGE).run(executionId, nodeExecId, sNode.role_id, role.provider_model, nodePrompt, nodeCompletion);
          addUsage(sNode.role_id, nodePrompt, nodeCompletion);

          // Check if judge (has next = loop back toward first node) — increment judgeRounds
          if (sNode.next) judgeRounds++;

          // Check for terminate/route signal
          const sig = extractSignal(nodeOutput);
          const cleanOutput = sig ? stripSignal(nodeOutput) : nodeOutput;

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
            db.prepare(SQL_INSERT_NODE_PARALLEL).run(nodeExecId, executionId, pNode.id, roleId, round, idx, 'running', Date.now(), snapshot);

            const client = new LLMClient({ provider_type: role.provider_type ?? 'openai', model: role.provider_model, api_key: role.api_key, base_url: role.base_url, max_tokens: role.max_tokens });

            return new Promise<{ roleId: string; nodeExecId: string; output: string | null; error: string | null; prompt: number; completion: number }>(async (resolve) => {
              let output = '';
              let prompt = 0;
              let completion = 0;
              const nodeAbort = new AbortController();
              const timer = setTimeout(() => nodeAbort.abort(), timeoutMs);
              // Combine flow-level abort with node timeout (P1 fix: parallel node respects flow cancel)
              const parallelCombinedSignal = (AbortSignal as any).any
                ? (AbortSignal as any).any([abort.signal, nodeAbort.signal])
                : abort.signal;
              try {
                for await (const chunk of client.streamChatCompletion({ messages: msgs, model: role.provider_model, stream: true, stream_options: { include_usage: true }, signal: parallelCombinedSignal })) {
                  if (parallelCombinedSignal.aborted) break;
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) output += delta;
                  if (chunk.usage) { prompt = chunk.usage.prompt_tokens; completion = chunk.usage.completion_tokens; }
                }
                clearTimeout(timer);
                db.prepare(SQL_UPDATE_NODE_SUCCESS).run(Date.now(), output.slice(0, 4000), prompt, completion, nodeExecId);
                resolve({ roleId, nodeExecId, output, error: null, prompt, completion });
              } catch (err: any) {
                clearTimeout(timer);
                db.prepare(SQL_UPDATE_NODE_FAILED).run(nodeAbort.signal.aborted ? 'timeout' : 'failed', Date.now(), err.message ?? 'Unknown', nodeExecId);
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
                db.prepare(SQL_INSERT_USAGE).run(executionId, v.nodeExecId, roleId, modelName, v.prompt, v.completion);
                addUsage(roleId, v.prompt, v.completion);
              } else {
                mergedParts.push(`=== 注意：${roleId} 执行失败（${v.error}），该视角缺失 ===`);
              }
            } else {
              mergedParts.push(`=== 注意：${roleId} 执行失败，该视角缺失 ===`);
            }
          }

          if (allFailed) {
            db.prepare(SQL_UPDATE_FLOW_FAILED).run('all_parallel_failed', Date.now(), round, executionId);
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
          db.prepare(SQL_INSERT_NODE).run(nodeExecId, executionId, tNode.id, 'tool:' + tNode.tool_ref, round, 'running', Date.now(), JSON.stringify([{ role: 'tool_input', content: input }]));

          const toolTimeoutMs = (tool.timeout_seconds ?? 30) * 1000;
          const toolAbort = new AbortController();
          const toolTimer = setTimeout(() => toolAbort.abort(), toolTimeoutMs);
          // Combine flow-level abort with tool timeout (P1 fix: tool respects flow cancel)
          const toolCombinedSignal = (AbortSignal as any).any
            ? (AbortSignal as any).any([abort.signal, toolAbort.signal])
            : abort.signal;
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
            db.prepare(SQL_UPDATE_NODE_SUCCESS).run(Date.now(), String(body.output).slice(0, 4000), 0, 0, nodeExecId);
            messageList.addMessage({ role: 'user', content: `[工具执行结果 - ${tNode.tool_ref}]: ${body.output}` });
          } catch (err: any) {
            clearTimeout(toolTimer);
            db.prepare(SQL_UPDATE_NODE_FAILED).run(toolAbort.signal.aborted ? 'timeout' : 'failed', Date.now(), err.message, nodeExecId);
            db.prepare(SQL_UPDATE_FLOW_FAILED).run('tool_error', Date.now(), round, executionId);
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
      db.prepare(SQL_UPDATE_FLOW_DONE).run(status, finishReason ?? 'stop', Date.now(), round, executionId);
      const flowResult: FlowExecutionResult = { id: executionId, status: 'completed', output: outputText, rounds: round, finishReason, totalUsage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion }, byRoleUsage };
      // Yield a marker chunk so streaming consumers (inference route) can capture the result
      yield { __flowResult: flowResult } as unknown as StreamChunk;
      return flowResult;

    } catch (err: any) {
      db.prepare(SQL_UPDATE_FLOW_FAILED).run(err.message ?? 'unknown_error', Date.now(), 0, executionId);
      throw err;
    } finally {
      clearTimeout(flowTimer);
      this.activeExecutions.delete(executionId);
    }
  }
}


