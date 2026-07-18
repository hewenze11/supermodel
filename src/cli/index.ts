#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Define the state file path
const STATE_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '', '.supermodel', 'state.json');

interface State {
  pid?: number;
  admin_url?: string;
  started_at?: number;
}

function getState(): State {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error reading state file:', error);
  }
  return {};
}

function setState(state: State): void {
  const configDir = path.dirname(STATE_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function checkPid(pid: number): boolean {
  try {
    process.kill(pid, 0); // This doesn't kill the process, just checks if it exists
    return true;
  } catch (error) {
    return false;
  }
}

async function startServer(): Promise<void> {
  const state = getState();
  
  if (state.pid && checkPid(state.pid)) {
    console.log(`Server is already running with PID ${state.pid}`);
    return;
  }

  // Spawn the server process using spawn (not execSync) for background execution
  const child = spawn('node', ['../dist/index.js'], { 
    cwd: __dirname,
    detached: true, 
    stdio: 'ignore' 
  });

  // Store the PID and admin URL in the state file
  const newState = {
    pid: child.pid,
    admin_url: 'http://localhost:11435',
    started_at: Date.now()
  };
  
  setState(newState);
  
  console.log(`Server started with PID ${child.pid}`);
  child.unref(); // Unreference the child process so the parent can exit
}

async function stopServer(): Promise<void> {
  const state = getState();
  
  if (!state.pid) {
    console.log('Server is not running (no PID in state file)');
    return;
  }
  
  if (!checkPid(state.pid)) {
    console.log('Server is not running (PID not found)');
    // Clean up stale state file
    setState({});
    return;
  }

  try {
    // Try to stop the server gracefully via HTTP
    const response = await fetch(`${state.admin_url}/admin/shutdown`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPERMODEL_ADMIN_PASSWORD || ''}`
      }
    });
    
    if (response.ok) {
      console.log('Server stopped gracefully');
      setState({}); // Clear state file
    } else {
      console.error('Failed to stop server via HTTP, trying to kill process...');
      process.kill(state.pid, 'SIGTERM');
      setState({}); // Clear state file
      console.log('Server process killed');
    }
  } catch (error) {
    console.error('Error communicating with server:', error);
    // As a fallback, kill the process directly
    try {
      process.kill(state.pid, 'SIGTERM');
      setState({}); // Clear state file
      console.log('Server process killed');
    } catch (killError) {
      console.error('Could not kill server process:', killError);
    }
  }
}

async function reloadServer(): Promise<void> {
  const state = getState();
  const adminUrl = state.admin_url || 'http://localhost:11435';
  
  try {
    const response = await fetch(`${adminUrl}/admin/reload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPERMODEL_ADMIN_PASSWORD || ''}`
      }
    });
    
    if (response.ok) {
      console.log('Server configuration reloaded');
    } else {
      console.error('Failed to reload server configuration');
    }
  } catch (error) {
    console.error('Error communicating with server:', error);
  }
}

async function getServerStatus(): Promise<void> {
  const state = getState();
  const adminUrl = state.admin_url || 'http://localhost:11435';
  const password = process.env.SUPERMODEL_ADMIN_PASSWORD || '';
  
  try {
    const response = await fetch(`${adminUrl}/admin/status`, {
      headers: {
        'Authorization': `Bearer ${password}`
      }
    });
    if (response.ok) {
      const status = await response.json();
      console.log('Server Status:', status);
    } else {
      console.log('Server is not responding');
    }
  } catch (error) {
    console.log('Server is not running');
  }
}

async function listFlows(): Promise<void> {
  const state = getState();
  const adminUrl = state.admin_url || 'http://localhost:11435';
  const password = process.env.SUPERMODEL_ADMIN_PASSWORD || '';
  
  try {
    const response = await fetch(`${adminUrl}/admin/flows`, {
      headers: {
        'Authorization': `Bearer ${password}`
      }
    });
    if (response.ok) {
      const data = await response.json();
      console.log('Available Flows:');
      data.flows.forEach((flow: any) => {
        console.log(`- ${flow.name} (${flow.node_count} nodes)`);
      });
    } else {
      console.error('Failed to fetch flows');
    }
  } catch (error) {
    console.error('Error communicating with server:', error);
  }
}

async function getFlowDetails(flowName: string): Promise<void> {
  const state = getState();
  const adminUrl = state.admin_url || 'http://localhost:11435';
  const password = process.env.SUPERMODEL_ADMIN_PASSWORD || '';
  
  try {
    const response = await fetch(`${adminUrl}/admin/flows/${flowName}`, {
      headers: {
        'Authorization': `Bearer ${password}`
      }
    });
    if (response.ok) {
      const data = await response.json();
      console.log(`Flow Details for ${flowName}:`);
      console.log(JSON.stringify(data, null, 2));
    } else if (response.status === 404) {
      console.error(`Flow ${flowName} not found`);
    } else {
      console.error('Failed to fetch flow details');
    }
  } catch (error) {
    console.error('Error communicating with server:', error);
  }
}

function showVersion(): void {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  console.log(`SuperModel v${packageJson.version}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'start':
      await startServer();
      break;
    case 'stop':
      stopServer();
      break;
    case 'reload':
      reloadServer();
      break;
    case 'status':
      getServerStatus();
      break;
    case 'flows':
      const subCommand = args[1];
      if (subCommand === 'list') {
        await listFlows();
      } else if (subCommand === 'get' && args[2]) {
        await getFlowDetails(args[2]);
      } else {
        console.log('Usage: supermodel flows [list|get <flow-name>]');
      }
      break;
    case 'version':
    case '--version':
    case '-v':
      showVersion();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
SuperModel CLI

Usage: supermodel <command>

Commands:
  start                 Start the SuperModel server
  stop                  Stop the SuperModel server
  reload                Reload server configurations
  status                Check server status
  flows list            List all available flows
  flows get <name>      Get details for a specific flow
  version, -v, --version  Show version information
  help, -h, --help      Show this help message
      `);
  }
}

// Handle missing fetch in Node.js
global.fetch = require('node-fetch');

main().catch(error => {
  console.error('Error running CLI:', error);
  process.exit(1);
});