import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { 
  ModelConfig, 
  RoleConfig, 
  FlowConfig, 
  DispatchRule, 
  ConfigRegistry,
  LoadedInstance,
  SerialNodeConfig,
  ParallelNodeConfig,
  ToolNodeConfig,
  ToolConfig,
  NodeConfig
} from './types';

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.supermodel');

export class ConfigLoader {
  private static instance: ConfigLoader;
  
  private constructor() {}
  
  public static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  public async loadConfigs(): Promise<ConfigRegistry> {
    const configs: ModelConfig[] = [];
    
    // Check if config directory exists
    if (!fs.existsSync(CONFIG_DIR)) {
      console.log(`Config directory ${CONFIG_DIR} does not exist`);
      return this.buildRegistry([]);
    }
    
    // Load global config
    const globalConfigPath = path.join(CONFIG_DIR, 'config.yaml');
    let adminPassword: string | undefined;
    let apiKeys: string | undefined;
    let globalConfigRaw: any = {};
    
    if (fs.existsSync(globalConfigPath)) {
      try {
        const rawGlobalConfig = fs.readFileSync(globalConfigPath, 'utf8');
        globalConfigRaw = yaml.load(rawGlobalConfig) as any;
        adminPassword = globalConfigRaw.admin_password;
        apiKeys = JSON.stringify(globalConfigRaw.api_keys || []);
      } catch (error) {
        console.error(`Error loading global config from ${globalConfigPath}:`, error);
      }
    }
    
    // Scan instances in models/ subdirectory
    const modelsDir = path.join(CONFIG_DIR, 'models');
    if (!fs.existsSync(modelsDir)) {
      console.log(`Models directory ${modelsDir} does not exist`);
      return this.buildRegistry([], adminPassword, apiKeys);
    }
    
    const instanceDirs = fs.readdirSync(modelsDir);
    const loadedInstancesMap = new Map<string, any>();
    
    for (const instanceDir of instanceDirs) {
      const instancePath = path.join(modelsDir, instanceDir);
      if (!fs.statSync(instancePath).isDirectory()) {
        continue;
      }
      
      try {
        const loadedInstance = await this.loadInstance(instanceDir, instancePath);
        // P1-2 Fix: 调用 validateLoadedInstance，校验规则真正生效
        const validation = this.validateLoadedInstance(loadedInstance);
        if (!validation.isValid) {
          console.error(`[${instanceDir}] ❌ 验证失败，跳过该实例：`);
          for (const err of validation.errors) console.error(`  FATAL ${err}`);
          for (const warn of validation.warnings) console.warn(`  WARN  ${warn}`);
          continue; // 跳过无效实例，不加入 configs
        }
        if (validation.warnings.length > 0) {
          for (const warn of validation.warnings) console.warn(`[${instanceDir}] WARN  ${warn}`);
        }
        console.log(`[${instanceDir}] ✅ 验证通过（${loadedInstance.roles.size} 个 role，${loadedInstance.flows.size} 个发言流）`);
        loadedInstancesMap.set(instanceDir, loadedInstance);
        configs.push(this.convertLoadedInstanceToModelConfig(loadedInstance));
      } catch (error) {
        console.error(`Error loading instance from ${instancePath}:`, error);
      }
    }
    
    if (configs.length === 0) {
      console.error('No valid configurations found. Exiting.');
      process.exit(1);
    }
    
    return this.buildRegistry(configs, adminPassword, apiKeys, loadedInstancesMap, globalConfigRaw);
  }

  private async loadInstance(instanceName: string, instancePath: string): Promise<LoadedInstance> {
    const roles: Map<string, RoleConfig> = new Map();
    const flows: Map<string, FlowConfig> = new Map();
    const tools: Map<string, ToolConfig> = new Map();
    
    // Load roles
    const rolesDir = path.join(instancePath, 'roles');
    if (fs.existsSync(rolesDir)) {
      const roleFiles = fs.readdirSync(rolesDir);
      for (const file of roleFiles) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          const rolePath = path.join(rolesDir, file);
          const rawRoleConfig = fs.readFileSync(rolePath, 'utf8')
            .replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] ?? '');
          const roleConfig: RoleConfig = yaml.load(rawRoleConfig) as RoleConfig;
          
          // Validate required fields for RoleConfig according to architecture
          if (!roleConfig.id) {
            throw new Error(`Role config ${rolePath} missing required field: id`);
          }
          if (roleConfig.primary === undefined) {
            throw new Error(`Role config ${rolePath} missing required field: primary`);
          }
          if (!roleConfig.provider_model) {
            throw new Error(`Role config ${rolePath} missing required field: provider_model`);
          }
          if (!roleConfig.api_key) {
            throw new Error(`Role config ${rolePath} missing required field: api_key`);
          }
          if (!roleConfig.base_url) {
            throw new Error(`Role config ${rolePath} missing required field: base_url`);
          }
          
          roles.set(roleConfig.id, roleConfig);
        }
      }
    }
    
    // Load flows
    const flowsDir = path.join(instancePath, 'flows');
    if (fs.existsSync(flowsDir)) {
      const flowFiles = fs.readdirSync(flowsDir);
      for (const file of flowFiles) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          const flowPath = path.join(flowsDir, file);
          const rawFlowConfig = fs.readFileSync(flowPath, 'utf8')
            .replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] ?? '');
          const flowConfig: FlowConfig = yaml.load(rawFlowConfig) as FlowConfig;
          
          // Set flow id to filename without extension
          flowConfig.id = path.basename(file, path.extname(file));
          
          // Validate required fields for FlowConfig
          if (!flowConfig.id) {
            throw new Error(`Flow config ${flowPath} missing required field: id`);
          }
          if (!flowConfig.output_node) {
            throw new Error(`Flow config ${flowPath} missing required field: output_node`);
          }
          if (!flowConfig.nodes || flowConfig.nodes.length === 0) {
            throw new Error(`Flow config ${flowPath} missing required field: nodes (must have at least one node)`);
          }
          
          flows.set(flowConfig.id, flowConfig);
        }
      }
    }
    
    // Load tools
    const toolsDir = path.join(instancePath, 'tools');
    if (fs.existsSync(toolsDir)) {
      const toolFiles = fs.readdirSync(toolsDir);
      for (const file of toolFiles) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          const toolPath = path.join(toolsDir, file);
          const rawToolConfig = fs.readFileSync(toolPath, 'utf8')
          .replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] ?? '');
          const toolConfig: ToolConfig = yaml.load(rawToolConfig) as ToolConfig;
          
          // Validate required fields for ToolConfig
          if (!toolConfig.id) {
            throw new Error(`Tool config ${toolPath} missing required field: id`);
          }
          if (!toolConfig.name) {
            throw new Error(`Tool config ${toolPath} missing required field: name`);
          }
          if (!toolConfig.description) {
            throw new Error(`Tool config ${toolPath} missing required field: description`);
          }
          if (!toolConfig.endpoint) {
            throw new Error(`Tool config ${toolPath} missing required field: endpoint`);
          }
          
          tools.set(toolConfig.id, toolConfig);
        }
      }
    }
    
    // Check if dispatch exists
    const hasDispatch = fs.existsSync(path.join(instancePath, 'prompts', 'dispatch.yaml'));
    let dispatchPrompt: string | undefined;
    if (hasDispatch) {
      const dispatchPath = path.join(instancePath, 'prompts', 'dispatch.yaml');
      dispatchPrompt = fs.readFileSync(dispatchPath, 'utf8');
    }
    
    return {
      instanceName,
      roles,
      flows,
      tools,
      hasDispatch,
      dispatchPrompt
    };
  }

  private validateLoadedInstance(instance: LoadedInstance): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // V-R1: roles/ directory exists and contains at least one .yaml file
    if (instance.roles.size === 0) {
      errors.push(`V-R1: Instance ${instance.instanceName} has no roles defined`);
    }
    
    // V-R2: All role yaml required fields are present
    for (const [roleId, role] of instance.roles) {
      if (!role.id) errors.push(`V-R2: Role ${roleId} missing required field id`);
      if (role.primary === undefined) errors.push(`V-R2: Role ${roleId} missing required field primary`);
      if (!role.provider_model) errors.push(`V-R2: Role ${roleId} missing required field provider_model`);
      if (!role.api_key) errors.push(`V-R2: Role ${roleId} missing required field api_key`);
      if (!role.base_url) errors.push(`V-R2: Role ${roleId} missing required field base_url`);
    }
    
    // V-R3: Exactly one role has primary: true
    const primaryRoles = Array.from(instance.roles.values()).filter(r => r.primary);
    if (primaryRoles.length !== 1) {
      errors.push(`V-R3: Instance ${instance.instanceName} must have exactly one primary role, found ${primaryRoles.length}`);
    }
    
    // V-R4: api_key field is non-empty (warning for placeholders)
    for (const [roleId, role] of instance.roles) {
      if (!role.api_key || role.api_key.trim() === '' || role.api_key.startsWith('sk-') && role.api_key.length < 10) {
        warnings.push(`V-R4: Role ${roleId} has placeholder or empty api_key`);
      }
    }
    
    // V-F1: flows/ directory exists and contains at least one .yaml file
    if (instance.flows.size === 0) {
      errors.push(`V-F1: Instance ${instance.instanceName} has no flows defined`);
    }
    
    // V-F2: All flow yaml required fields are present
    for (const [flowId, flow] of instance.flows) {
      if (!flow.output_node) errors.push(`V-F2: Flow ${flowId} missing required field output_node`);
      if (!flow.nodes || flow.nodes.length === 0) errors.push(`V-F2: Flow ${flowId} has no nodes defined`);
    }
    
    // V-F3: All nodes' role references exist in roles/
    for (const [flowId, flow] of instance.flows) {
      for (const node of flow.nodes) {
        if (node.type === 'serial' || node.type === 'tool') {
          if ('role_id' in node && node.role_id && !instance.roles.has(node.role_id)) {
            errors.push(`V-F3: Flow ${flowId} node ${node.id} references non-existent role ${node.role_id}`);
          }
        } else if (node.type === 'parallel') {
          for (const roleId of node.roles) {
            if (!instance.roles.has(roleId)) {
              errors.push(`V-F3: Flow ${flowId} parallel node ${node.id} references non-existent role ${roleId}`);
            }
          }
        }
      }
    }
    
    // V-F4: All nodes' next references exist in the same flow's nodes
    for (const [flowId, flow] of instance.flows) {
      for (const node of flow.nodes) {
        if (node.next && !flow.nodes.some(n => n.id === node.next)) {
          errors.push(`V-F4: Flow ${flowId} node ${node.id} references non-existent next node ${node.next}`);
        }
      }
    }
    
    // V-F5: No circular references (check using DFS)
    for (const [flowId, flow] of instance.flows) {
      const visited = new Set<string>();
      const recStack = new Set<string>();
      
      const hasCycle = (nodeId: string): boolean => {
        if (!recStack.has(nodeId)) {
          if (visited.has(nodeId)) return false;
          
          visited.add(nodeId);
          recStack.add(nodeId);
          
          const node = flow.nodes.find(n => n.id === nodeId);
          if (node && node.next) {
            if (recStack.has(node.next) || hasCycle(node.next)) {
              return true;
            }
          }
          
          recStack.delete(nodeId);
        }
        return false;
      };
      
      // Start cycle detection from the first node
      if (flow.nodes.length > 0) {
        if (hasCycle(flow.nodes[0].id)) {
          errors.push(`V-F5: Flow ${flowId} has circular reference in execution path`);
        }
      }
    }
    
    // V-F7: If no dispatch, direct.yaml must exist
    if (!instance.hasDispatch && !instance.flows.has('direct')) {
      errors.push(`V-F7: Instance ${instance.instanceName} has no dispatch.yaml and no direct.yaml flow`);
    }
    
    // V-T1: Tool references in nodes exist in tools/
    for (const [flowId, flow] of instance.flows) {
      for (const node of flow.nodes) {
        if (node.type === 'tool') {
          if (!instance.tools.has((node as ToolNodeConfig).tool_ref)) {
            errors.push(`V-T1: Flow ${flowId} tool node ${node.id} references non-existent tool ${(node as ToolNodeConfig).tool_ref}`);
          }
        }
      }
    }
    
    // V-T2: All tool yaml required fields are present
    for (const [toolId, tool] of instance.tools) {
      if (!tool.id) errors.push(`V-T2: Tool ${toolId} missing required field id`);
      if (!tool.name) errors.push(`V-T2: Tool ${toolId} missing required field name`);
      if (!tool.description) errors.push(`V-T2: Tool ${toolId} missing required field description`);
      if (!tool.endpoint) errors.push(`V-T2: Tool ${toolId} missing required field endpoint`);
    }
    
    // V-D1: If has dispatch, referenced flow IDs must exist
    if (instance.hasDispatch) {
      // We would parse the dispatch prompt to extract flow references here
      // For now, just note that validation should happen if we had the dispatch prompt content
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  private convertLoadedInstanceToModelConfig(instance: LoadedInstance): ModelConfig {
    // Convert the loaded instance to the old format for compatibility with existing code
    // This is a temporary bridge until the code is fully updated to use the new format
    return {
      instance_name: instance.instanceName,
      primary: false, // Placeholder - this should be determined based on actual configuration
      roles: Array.from(instance.roles.values()),
      flows: Array.from(instance.flows.values()),
      dispatch: [] // Placeholder - this should be populated based on actual configuration
    };
  }

  private buildRegistry(configs: ModelConfig[], adminPassword?: string, apiKeys?: string, loadedInstancesMap?: Map<string, any>, globalConfig?: any): ConfigRegistry {
    const registry: ConfigRegistry = {
      instances: [],
      roles: new Map(),
      flows: new Map(),
      dispatch: new Map(),
      primaries: [],
      adminPassword,
      apiKeys,
      port: globalConfig?.port ?? 11451,
      admin_port: globalConfig?.admin_port ?? 11435,
      log_level: globalConfig?.log_level ?? 'info',
      flow_timeout_seconds: globalConfig?.flow_timeout_seconds ?? 300,
      max_concurrent_flows: globalConfig?.max_concurrent_flows ?? 10,
      debug_full_payload: globalConfig?.debug_full_payload ?? false,
      loadedInstances: loadedInstancesMap ?? new Map()
    };
    
    // Validation for R1 and P1
    const instanceNames = new Set<string>();
    let primaryCount = 0;
    
    for (const config of configs) {
      // R1: Check for duplicate instance names
      if (instanceNames.has(config.instance_name)) {
        console.error(`Duplicate instance name '${config.instance_name}'. Skipping this config.`);
        continue;
      }
      instanceNames.add(config.instance_name);
      
      // P1: Count primaries
      if (config.primary) {
        primaryCount++;
        if (primaryCount > 1) {
          console.error(`More than one primary instance detected. Only one instance should have primary=true. Skipping this config.`);
          continue;
        }
      }
      
      registry.instances.push(config);
      
      // Add roles to global map
      for (const role of config.roles) {
        if (registry.roles.has(role.id)) {
          console.warn(`Duplicate role id '${role.id}' across instances. Using first occurrence.`);
        } else {
          registry.roles.set(role.id, role);
        }
      }
      
      // Add flows to global map
      for (const flow of config.flows) {
        if (registry.flows.has(flow.id)) {
          console.warn(`Duplicate flow name '${flow.name}' across instances. Using first occurrence.`);
        } else {
          registry.flows.set(flow.id, flow);
        }
      }
      
      // Add dispatch rules to global map
      for (const dispatch of config.dispatch) {
        if (!registry.dispatch.has(dispatch.flow_name)) {
          registry.dispatch.set(dispatch.flow_name, []);
        }
        registry.dispatch.get(dispatch.flow_name)!.push(dispatch);
      }
      
      if (config.primary) {
        registry.primaries.push(config);
      }
    }
    
    return registry;
  }
}



