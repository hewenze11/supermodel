import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { initDatabase } from './db';
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
    
    // Initialize database (PostgreSQL, creates tables + startup compensation)
    await initDatabase();
    
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

    // Health check endpoint (for K8s liveness/readiness probes)
    this.inferenceServer.get('/health', async () => {
      return { status: 'ok' };
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
      adminPassword: adminPassword,
      inferenceApiKeys: apiKeys
    });
    
    // Serve admin UI from Next.js static export (output: 'export' → ui/out)
    const uiPath = path.join(__dirname, '..', 'ui', 'out');
    const uiBuildFallback = path.join(__dirname, '..', 'ui', 'build');
    const resolvedUiPath = fs.existsSync(uiPath) ? uiPath : (fs.existsSync(uiBuildFallback) ? uiBuildFallback : null);
    if (resolvedUiPath) {
      this.adminServer.register(staticPlugin, {
        root: resolvedUiPath,
        prefix: '/',
      });
      
      // Fallback to index.html for SPA routing
      this.adminServer.setNotFoundHandler((req: any, reply: any) => {
        reply.sendFile('index.html', resolvedUiPath as string);
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
      
      // Start admin server on all interfaces (K8s exposes via Service)
      await this.adminServer.listen({
        port: ADMIN_PORT,
        host: '0.0.0.0'
      });
      
      console.log(`Inference server running on port ${INFERENCE_PORT}`);
      console.log(`Admin server running on port ${ADMIN_PORT}`);
      console.log('Servers are ready!');
    } catch (err) {
      console.error('Error starting server:', err);
      process.exit(1);
    }
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
