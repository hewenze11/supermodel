import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { initDatabase, db } from './db';
import { ConfigLoader } from './config/loader';
import { ConfigRegistry } from './config/types';
import { FlowEngine } from './engine/flow';
import { inferenceRoutes } from './routes/inference';
import { adminRoutes } from './routes/admin';

class SuperModelServer {
  private configRegistry!: ConfigRegistry;
  private flowEngine: FlowEngine;
  private inferenceServer: any;
  private adminServer: any;

  constructor() {
    this.flowEngine = new FlowEngine();
  }

  async start() {
    console.log('Initializing SuperModel server...');
    
    // Initialize database
    initDatabase();
    
    // Perform startup compensation: update any 'running' executions to 'failed'
    this.performStartupCompensation();
    
    // Load configurations
    this.configRegistry = await ConfigLoader.getInstance().loadConfigs();
    
    // Get admin password from config or environment variable
    const adminPassword = process.env.SUPERMODEL_ADMIN_PASSWORD || this.configRegistry.adminPassword || '';
    
    // Get API keys from config or environment variable
    const apiKeysString = process.env.SUPERMODEL_API_KEYS || this.configRegistry.apiKeys || '[]';
    const apiKeys: string[] = JSON.parse(apiKeysString);
    
    // Create inference server (public API)
    this.inferenceServer = Fastify({
      logger: true,
    });
    
    // Create admin server (private, bound to localhost)
    this.adminServer = Fastify({
      logger: true,
    });
    
    // Register routes
    await inferenceRoutes(this.inferenceServer, {
      configRegistry: this.configRegistry,
      flowEngine: this.flowEngine,
      apiKeys: apiKeys
    });
    
    await adminRoutes(this.adminServer, {
      configRegistry: this.configRegistry,
      flowEngine: this.flowEngine,
      updateRegistry: (newRegistry: ConfigRegistry) => {
        this.configRegistry = newRegistry;
      },
      adminPassword: adminPassword
    });
    
    // Serve admin UI from UI build directory
    const uiPath = path.join(__dirname, '..', 'ui', 'build');
    if (fs.existsSync(uiPath)) {
      this.adminServer.register(staticPlugin, {
        root: uiPath,
        prefix: '/',
      });
      
      // Fallback to index.html for SPA routing
      this.adminServer.setNotFoundHandler((req: any, reply: any) => {
        reply.sendFile('index.html', uiPath);
      });
    }
    
    // Start servers
    const INFERENCE_PORT = 11451;
    const ADMIN_PORT = 11435;
    
    try {
      // Start inference server on all interfaces
      await this.inferenceServer.listen({
        port: INFERENCE_PORT,
        host: '0.0.0.0'
      });
      
      // Start admin server only on localhost
      await this.adminServer.listen({
        port: ADMIN_PORT,
        host: '127.0.0.1'
      });
      
      console.log(`Inference server running on port ${INFERENCE_PORT}`);
      console.log(`Admin server running on port ${ADMIN_PORT}`);
      console.log('Servers are ready!');
    } catch (err) {
      console.error('Error starting server:', err);
      process.exit(1);
    }
  }

  performStartupCompensation() {
    console.log('Performing startup compensation...');
    
    // Update flow_executions with running status to failed (no error_message column)
    const updateFlowStmt = db.prepare(`
      UPDATE flow_executions 
      SET status = 'failed', finished_at = ?, finish_reason = 'process_restarted'
      WHERE status = 'running'
    `);
    const flowResult = updateFlowStmt.run(Date.now());
    
    // Update node_executions with running status to failed
    const updateNodeStmt = db.prepare(`
      UPDATE node_executions 
      SET status = 'failed', finished_at = ?, error_message = 'Process restarted unexpectedly'
      WHERE status = 'running'
    `);
    const nodeResult = updateNodeStmt.run(Date.now());
    
    console.log(`Compensated ${flowResult.changes} flow executions and ${nodeResult.changes} node executions`);
  }
  
  async stop() {
    console.log('Shutting down servers...');
    await this.inferenceServer.close();
    await this.adminServer.close();
  }
}

// Global server instance for graceful shutdown
let globalServer: SuperModelServer;

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully');
  if (globalServer) {
    await globalServer.stop();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully');
  if (globalServer) {
    await globalServer.stop();
  }
  process.exit(0);
});

// Start the server
globalServer = new SuperModelServer();
globalServer.start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
