import { ToolConfig } from '../config/types';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  isError?: boolean;
}

/**
 * Convert ToolConfig definitions to OpenAI function-calling format
 */
export function buildOpenAITools(toolConfigs: ToolConfig[]): any[] {
  return toolConfigs.map(t => ({
    type: 'function',
    function: {
      name: t.id,
      description: t.description ?? t.name,
      parameters: t.input_schema ?? {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'The input query or data for this tool' }
        },
        required: ['input']
      }
    }
  }));
}

/**
 * Execute a single tool call by POSTing to the tool's HTTP endpoint.
 * Protocol: POST {endpoint} with body {"input": string, "context": {...}}
 * Expected response: {"output": string, "status": "success"|"error", "error_message"?: string}
 */
export async function executeToolCall(
  toolCall: ToolCall,
  toolConfigs: Map<string, ToolConfig>,
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = toolConfigs.get(toolCall.function.name);
  if (!tool) {
    return {
      tool_call_id: toolCall.id,
      content: `Tool not found: ${toolCall.function.name}`,
      isError: true
    };
  }

  let parsedArgs: Record<string, any> = {};
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch {
    parsedArgs = { input: toolCall.function.arguments };
  }

  const input = parsedArgs.input ?? parsedArgs.query ?? JSON.stringify(parsedArgs);

  const timeoutMs = (tool.timeout_seconds ?? 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(tool.headers ?? {})
    };

    // If the tool has a `request_body_mode: "passthrough"` config (or default),
    // send the LLM's parsed args directly as the request body.
    // This allows direct integration with external APIs like Serper, Brave, etc.
    // Legacy mode: wrap in {"input": ..., "context": {...}} for internal tool servers.
    const usePassthrough = (tool as any).request_body_mode !== 'legacy';
    const body = usePassthrough
      ? JSON.stringify(parsedArgs)
      : JSON.stringify({
          input,
          context: {
            tool_id: tool.id,
            tool_name: tool.name,
            call_mode: 'ai_tool_call'
          }
        });

    console.log(`[tool-exec] tool=${tool.id} endpoint=${tool.endpoint} body=${body.slice(0,200)}`);

    const resp = await fetch(tool.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log(`[tool-exec] HTTP error ${resp.status}: ${errText.slice(0,200)}`);
      return {
        tool_call_id: toolCall.id,
        content: `Tool HTTP error: ${resp.status} ${errText.slice(0,100)}`,
        isError: true
      };
    }

    const data = await resp.json() as any;
    console.log(`[tool-exec] result keys: ${Object.keys(data).join(',')}`);

    // Handle both internal protocol (output field) and external APIs (organic, results, etc.)
    let resultContent: string;
    if (data.output !== undefined) {
      // Internal protocol
      resultContent = data.output ?? data.error_message ?? JSON.stringify(data);
    } else {
      // External API — stringify the relevant parts
      // For search APIs: extract organic results
      if (data.organic) {
        const snippets = (data.organic as any[]).slice(0, 5).map((r: any) =>
          `[${r.position}] ${r.title}\n${r.snippet}\n${r.link}`
        ).join('\n\n');
        resultContent = snippets || JSON.stringify(data).slice(0, 2000);
      } else {
        resultContent = JSON.stringify(data).slice(0, 2000);
      }
    }
    const isError = data.status === 'error';
    return {
      tool_call_id: toolCall.id,
      content: resultContent,
      isError
    };
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err?.name === 'AbortError' ? 'Tool call timed out' : `Tool call failed: ${err?.message}`;
    return {
      tool_call_id: toolCall.id,
      content: msg,
      isError: true
    };
  }
}
