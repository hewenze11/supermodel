import { FastifyInstance } from 'fastify';
import crypto from 'crypto';

import { ConfigRegistry } from '../config/types';
import { ConfigLoader } from '../config/loader';
import { FlowEngine } from '../engine/flow';
import { db } from '../db';

interface AdminRoutesOptions {
  configRegistry: ConfigRegistry;
  flowEngine: FlowEngine;
  updateRegistry: (newRegistry: ConfigRegistry) => void;
  adminPassword: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Admin authentication middleware
async function authenticateAdminRequest(req: any, reply: any, adminPassword: string) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({
      error: {
        message: 'Invalid password',
        type: 'authentication_error'
      }
    });
    return false;
  }
  
  const token = authHeader.substring(7);
  
  if (!timingSafeEqual(token, adminPassword)) {
    reply.status(401).send({
      error: {
        message: 'Invalid password',
        type: 'authentication_error'
      }
    });
    return false;
  }
  
  return true;
}
export async function adminRoutes(fastify: FastifyInstance, options: AdminRoutesOptions) {
  const { configRegistry, flowEngine, updateRegistry, adminPassword } = options;

  // Admin authentication hook
  fastify.addHook('preHandler', async (req, reply) => {
    // Only apply to admin routes
    if (req.url && req.url.startsWith('/admin/')) {
      const isAuthenticated = await authenticateAdminRequest(req, reply, adminPassword);
      if (!isAuthenticated) {
        return reply;
      }
    }
  });

  // Health check
  fastify.get('/admin/status', async (req, reply) => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      config_instances: configRegistry.instances.length,
      config_roles: configRegistry.roles.size,
      config_flows: configRegistry.flows.size
    };
  });

  // Authentication test endpoint
  fastify.post('/admin/auth', async (req, reply) => {
    return { status: 'ok' };
  });

  // Reload configurations
  fastify.post('/admin/reload', async (req, reply) => {
    try {
      console.log('Reloading configurations...');
      const newRegistry = await ConfigLoader.getInstance().loadConfigs();
      updateRegistry(newRegistry);
      console.log('Configuration reloaded successfully');
      return { success: true, message: 'Configuration reloaded successfully' };
    } catch (error) {
      console.error('Error reloading configuration:', error);
      return reply.status(500).send({ 
        success: false, 
        error: (error as Error).message 
      });
    }
  });

  // Shutdown server
  fastify.post('/admin/shutdown', async (req, reply) => {
    console.log('Shutting down server...');
    // Allow some time for response to be sent before graceful shutdown
    setImmediate(async () => {
      // Emit SIGTERM to trigger graceful shutdown handler in the main process
      process.emit('SIGTERM' as any);
    });
    return { success: true, message: 'Shutdown initiated' };
  });

  // Test configuration
  fastify.post('/admin/test', async (req, reply) => {
    const { instance_name, role_id } = req.body as any;
    
    try {
      const roleConfig = configRegistry.roles.get(role_id);
      if (!roleConfig) {
        return reply.status(404).send({ 
          success: false, 
          error: `Role ${role_id} not found` 
        });
      }
      
      // Simple test by attempting to create an LLM client and make a minimal call
      // For now, we'll just verify the configuration is structurally valid
      return {
        success: true,
        message: `Configuration for role ${role_id} is valid`,
        model: roleConfig.provider_model,
        provider: roleConfig.provider_type
      };
    } catch (error) {
      return reply.status(500).send({ 
        success: false, 
        error: (error as Error).message 
      });
    }
  });

  // List all flows
  fastify.get('/admin/flows', async (req, reply) => {
    const flows = Array.from(configRegistry.flows.entries()).map(([name, flow]) => ({
      name,
      node_count: flow.nodes.length,
      nodes: flow.nodes.map(n => ({
        id: n.id,
        type: n.type
      }))
    }));

    return {
      flows,
      total: flows.length
    };
  });

  // Get specific flow details
  fastify.get('/admin/flows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    
    const flow = configRegistry.flows.get(id);
    if (!flow) {
      return reply.status(404).send({ 
        error: `Flow ${id} not found` 
      });
    }

    // Get recent executions for this flow
    const recentExecutions = db.prepare(`
      SELECT id, instance_name, status, started_at, finished_at, total_rounds, finish_reason, created_at
      FROM flow_executions 
      WHERE flow_name = ?
      ORDER BY started_at DESC
      LIMIT 20
    `).all(id);

    return {
      name: flow.name,
      nodes: flow.nodes.map(n => ({
        id: n.id,
        type: n.type,
        next: (n as any).next,
        role_id: (n as any).role_id,
        roles: (n as any).roles
      })),
      recent_executions: recentExecutions
    };
  });

  // Get flow execution details
  fastify.get('/admin/executions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    
    // Get flow execution info
    const flowExecution = db.prepare(`
      SELECT * FROM flow_executions WHERE id = ?
    `).get(id) as any;

    if (!flowExecution) {
      return reply.status(404).send({ 
        error: `Flow execution ${id} not found` 
      });
    }

    // Get associated node executions
    const nodeExecutions = db.prepare(`
      SELECT * FROM node_executions WHERE flow_execution_id = ?
      ORDER BY started_at ASC
    `).all(id) as any[];

    // Get usage records
    const usageRecords = db.prepare(`
      SELECT * FROM usage_records WHERE flow_execution_id = ?
    `).all(id) as any[];

    return {
      flow_execution: flowExecution,
      node_executions: nodeExecutions,
      usage_records: usageRecords
    };
  });

  // Cancel a running flow execution
  fastify.post('/admin/executions/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    
    const success = flowEngine.cancelExecution(id);
    
    if (success) {
      return { 
        success: true, 
        message: `Execution ${id} cancelled` 
      };
    } else {
      return reply.status(404).send({ 
        success: false, 
        error: `Execution ${id} not found or already completed` 
      });
    }
  });
}

