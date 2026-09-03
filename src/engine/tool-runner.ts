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
      // Prefer 'parameters' (standard JSON Schema), fall back to 'input_schema' (legacy), then default
      parameters: t.parameters ?? (t.input_schema ? {
        type: 'object',
        properties: t.input_schema,
        required: Object.keys(t.input_schema)
      } : {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'The input query or data for this tool' }
        },
        required: ['input']
      })
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
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>
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
      ...(tool.headers ?? {}),
      ...(extraHeaders ?? {})  // 动态 headers 优先级最高（如用户 memcore token）
    };

    // Support GET method: append params as query string, no body
    const httpMethod = ((tool as any).method ?? 'POST').toUpperCase();
    // 경로 파라미터 치환: endpoint의 {param} 플레이스홀더를 실제 값으로 교체
    let fetchUrl = tool.endpoint;
    if ((tool as any).path_params && typeof fetchUrl === 'string') {
      for (const [paramName] of Object.entries((tool as any).path_params as Record<string, unknown>)) {
        // LLM 可能将路径参数混入 body 参数，兜底：从 parameters 和 path_params 同时查找
        const paramValue = parsedArgs[paramName] ?? (typeof parsedArgs.parameters === 'object' && parsedArgs.parameters !== null ? (parsedArgs.parameters as Record<string, unknown>)[paramName] : undefined);
        if (paramValue !== undefined && paramValue !== null) {
          fetchUrl = fetchUrl.replace(`{${paramName}}`, encodeURIComponent(String(paramValue)));
          delete parsedArgs[paramName];
          if (typeof parsedArgs.parameters === 'object' && parsedArgs.parameters !== null) {
            delete (parsedArgs.parameters as Record<string, unknown>)[paramName];
          }
        }
      }
    }
    let body: string | undefined;

    if (httpMethod === 'GET') {
      // Append non-empty params as query string
      const qs = Object.entries(parsedArgs)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      if (qs) fetchUrl = `${fetchUrl}?${qs}`;
      delete headers['Content-Type'];
      body = undefined;
    } else {
      const usePassthrough = (tool as any).request_body_mode !== 'legacy';
      body = usePassthrough
        ? JSON.stringify(parsedArgs)
        : JSON.stringify({
            input,
            context: {
              tool_id: tool.id,
              tool_name: tool.name,
              call_mode: 'ai_tool_call'
            }
          });
    }

    console.log(`[tool-exec] tool=${tool.id} method=${httpMethod} endpoint=${fetchUrl} body=${body?.slice(0,200) ?? '(none)'}`);

    const resp = await fetch(fetchUrl, {
      method: httpMethod,
      headers,
      ...(body !== undefined ? { body } : {}),
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
