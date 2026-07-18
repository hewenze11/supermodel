export interface ModelConfig {
  instance_name: string;
  primary: boolean;
  roles: RoleConfig[];
  flows: FlowConfig[];
  dispatch: DispatchRule[];
}

export interface RoleConfig {
  id: string;
  primary: boolean;
  provider_model: string;
  api_key: string;
  base_url: string;
  system_prompt_extra?: string;
  context_window?: number;
  system_token_budget?: number;
  provider_type?: 'openai' | 'anthropic';
  max_tokens?: number;
}

// 串行节点
export interface SerialNodeConfig {
  type: 'serial';
  id: string;
  role_id: string;
  prompt: string;
  next?: string;           // 下一节点 id，不填则为输出节点
  tools?: string[];        // 工具白名单
  force_tool_support?: boolean;
}

// 并行节点
export interface ParallelNodeConfig {
  type: 'parallel';
  id: string;
  roles: string[];         // 多个 role_id
  prompt: string;
  next?: string;
  timeout_seconds?: number;
  on_timeout?: 'continue' | 'abort';
}

// 工具节点
export interface ToolNodeConfig {
  type: 'tool';
  id: string;
  tool_ref: string;        // tools/ 下的 tool id
  next?: string;
}

export type NodeConfig = SerialNodeConfig | ParallelNodeConfig | ToolNodeConfig;

export interface FlowConfig {
  id: string;                       // 必填，流名（= 文件名，不含 .yaml）
  name?: string;                    // 可选，显示名
  max_rounds?: number;              // default: 10
  timeout_seconds?: number;         // 可选，flow 级别超时（秒），default 300
  output_node: string;              // 必填，指定对外返回哪个节点的输出
  nodes: NodeConfig[];              // 必填，至少一个节点
}

export interface ToolConfig {
  id: string;                       // 必填，在同一实例内唯一
  name: string;                     // 必填，工具显示名
  description: string;              // 必填，AI调用模式时读取（告知AI工具用途）
  endpoint: string;                 // 必填，工具HTTP服务地址
  input_schema?: Record<string, string>; // 可选，仅AI调用模式：字段名→类型描述字符串
  timeout_seconds?: number;         // default: 30；编排器侧强制超时，超时后直接判定失败
  headers?: Record<string, string>; // 可选，自定义 HTTP 请求头（如 Authorization、X-API-Key 等）
}

export interface DispatchRule {
  flow_name: string;
  instance_name: string;
  priority: number;
}

export interface LoadedInstance {
  instanceName: string;
  roles: Map<string, RoleConfig>;    // key = role_id
  flows: Map<string, FlowConfig>;    // key = 流名（不含 .yaml）
  tools: Map<string, ToolConfig>;    // key = tool_id；工具目录为空时为空 Map
  hasDispatch: boolean;
  dispatchPrompt?: string;
}

export interface ConfigRegistry {
  instances: ModelConfig[];
  roles: Map<string, RoleConfig>;
  flows: Map<string, FlowConfig>;
  dispatch: Map<string, DispatchRule[]>;
  primaries: ModelConfig[];
  adminPassword?: string;
  apiKeys?: string;
  /** Global config fields for /admin/status */
  port?: number;
  admin_port?: number;
  log_level?: string;
  flow_timeout_seconds?: number;
  max_concurrent_flows?: number;
  debug_full_payload?: boolean;
  /** LoadedInstance map: instanceName → LoadedInstance (authoritative source for routing) */
  loadedInstances?: Map<string, LoadedInstance>;
}