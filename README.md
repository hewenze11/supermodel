# SuperModel

A Node.js single-process service for AI inference with OpenAI-compatible API, featuring flow-based processing and management capabilities.

## Features

- OpenAI-compatible API for seamless integration
- Flow-based AI processing with multiple nodes
- Support for multiple LLM providers (OpenAI, Anthropic)
- Built-in management and monitoring interface
- Configuration hot-reload
- Streaming responses via Server-Sent Events (SSE)
- SQLite-based persistence for execution tracking
- Kubernetes-ready deployment

## Architecture

SuperModel implements a flow-based processing engine where AI interactions are organized into configurable "flows" consisting of multiple "nodes". Each node represents a step in the AI processing pipeline and can use different models or configurations.

### Core Components

1. **Configuration System**: Loads model configurations from `~/.supermodel/models/*/config.yaml`
2. **Flow Engine**: Executes multi-step AI flows with configurable nodes
3. **LLM Clients**: Supports OpenAI and Anthropic APIs with unified interface
4. **Database Layer**: SQLite-based persistence for tracking executions
5. **API Layer**: OpenAI-compatible inference API and management endpoints

### Ports

- **11451**: Inference API (OpenAI-compatible)
- **11435**: Management API and UI (bound to 127.0.0.1)

## Installation

```bash
npm install
npm run build
```

## Usage

### Starting the Server

```bash
npm start
# or
node dist/index.js
```

### CLI Commands

```bash
# Start the server
npx supermodel start

# Check server status
npx supermodel status

# Reload configurations
npx supermodel reload

# Stop the server
npx supermodel stop

# List flows
npx supermodel flows list

# Get flow details
npx supermodel flows get <flow-name>
```

### Configuration

Create your model configuration in `~/.supermodel/models/<model-name>/config.yaml`:

```yaml
instance_name: my-instance
primary: true
roles:
  - id: gpt-4
    provider_type: openai
    model: gpt-4
    api_key: sk-your-openai-api-key
    base_url: https://api.openai.com/v1
  - id: claude-3
    provider_type: anthropic
    model: claude-3-opus-20240229
    api_key: your-anthropic-api-key
    base_url: https://api.anthropic.com/v1
flows:
  - name: content-review
    nodes:
      - id: writer
        role_id: gpt-4
        system_prompt: "You are a creative content writer..."
        max_rounds: 1
      - id: reviewer
        role_id: claude-3
        system_prompt: "You are a meticulous content reviewer..."
        max_rounds: 1
dispatch:
  - flow_name: content-review
    instance_name: my-instance
    priority: 1
```

## API Endpoints

### Inference API

- `POST /v1/chat/completions` - OpenAI-compatible chat completions
- `GET /v1/models` - List available models

### Management API

- `GET /admin/status` - Server health status
- `POST /admin/reload` - Reload configurations
- `POST /admin/shutdown` - Shutdown server
- `POST /admin/test` - Test configuration
- `GET /admin/flows` - List all flows
- `GET /admin/flows/:id` - Get flow details
- `GET /admin/executions/:id` - Get execution details
- `POST /admin/executions/:id/cancel` - Cancel execution

## Development

```bash
# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Run tests
npm test
```

## Deployment

SuperModel includes Kubernetes manifests for both development and production environments in the `k8s/` directory. The service is designed to work with Harbor container registry and includes automated CI/CD workflows.

## License

MIT