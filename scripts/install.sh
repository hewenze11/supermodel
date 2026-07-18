#!/usr/bin/env bash
# SuperModel install script — Linux/macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/hewenze11/supermodel/main/scripts/install.sh | bash
# Or: bash install.sh

set -euo pipefail

REPO="https://github.com/hewenze11/supermodel"
BRANCH="${SUPERMODEL_BRANCH:-main}"   # override with: SUPERMODEL_BRANCH=dev bash install.sh
INSTALL_DIR="$HOME/.supermodel"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.supermodel/app"
DATA_DIR="$HOME/.supermodel/data"
MODELS_DIR="$HOME/.supermodel/models"
CONFIG_FILE="$HOME/.supermodel/config.yaml"
NODE_MIN_VERSION=20

print_step() { echo -e "\n\033[1;34m==> $1\033[0m"; }
print_ok()   { echo -e "\033[1;32m✓ $1\033[0m"; }
print_err()  { echo -e "\033[1;31m✗ $1\033[0m" >&2; }
die()        { print_err "$1"; exit 1; }

# ── Install Node.js if missing ───────────────────────────────
install_node() {
  echo "Installing Node.js $NODE_MIN_VERSION via NodeSource..."
  if command -v curl &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_VERSION}.x | bash -
  elif command -v wget &>/dev/null; then
    wget -qO- https://deb.nodesource.com/setup_${NODE_MIN_VERSION}.x | bash -
  else
    die "curl/wget not found. Cannot auto-install Node.js."
  fi
  if command -v apt-get &>/dev/null; then
    apt-get install -y -qq nodejs
  elif command -v yum &>/dev/null; then
    yum install -y nodejs
  else
    die "Cannot auto-install Node.js. Install manually from https://nodejs.org (>= v$NODE_MIN_VERSION)"
  fi
}

# ── Check Node.js ────────────────────────────────────────────
print_step "Checking Node.js (>= $NODE_MIN_VERSION required)"
if ! command -v node &>/dev/null; then
  echo "Node.js not found. Auto-installing..."
  install_node
fi
NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_VER" -lt "$NODE_MIN_VERSION" ]; then
  echo "Node.js v$NODE_VER found, need >= v$NODE_MIN_VERSION. Upgrading..."
  install_node
fi
print_ok "Node.js v$(node --version) found"

# ── Check npm ────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  die "npm not found. Should come with Node.js."
fi

# ── Check git ────────────────────────────────────────────────
print_step "Checking git"
if ! command -v git &>/dev/null; then
  echo "git not found. Auto-installing..."
  if command -v apt-get &>/dev/null; then
    apt-get install -y -qq git
  elif command -v yum &>/dev/null; then
    yum install -y git
  elif command -v apk &>/dev/null; then
    apk add --no-cache git
  else
    die "Cannot auto-install git. Please install it manually."
  fi
fi
print_ok "git found"

# ── Check build tools (for better-sqlite3) ──────────────────
print_step "Checking build tools (needed for SQLite native addon)"
MISSING_TOOLS=""
for tool in python3 make g++ cc; do
  command -v $tool &>/dev/null || MISSING_TOOLS="$MISSING_TOOLS $tool"
done
if [ -n "$MISSING_TOOLS" ]; then
  echo "Missing build tools:$MISSING_TOOLS"
  if command -v apt-get &>/dev/null; then
    echo "Installing via apt-get..."
    sudo apt-get update -qq && sudo apt-get install -y -qq build-essential python3
  elif command -v yum &>/dev/null; then
    echo "Installing via yum..."
    sudo yum install -y -q gcc gcc-c++ make python3
  elif command -v apk &>/dev/null; then
    echo "Installing via apk..."
    sudo apk add --no-cache python3 make g++
  elif command -v brew &>/dev/null; then
    echo "Installing Xcode command line tools..."
    xcode-select --install 2>/dev/null || true
  else
    die "Cannot auto-install build tools. Please install: build-essential python3 manually."
  fi
fi
print_ok "Build tools available"

# ── Clone / update repo ──────────────────────────────────────
print_step "Installing SuperModel"
mkdir -p "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing installation..."
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  echo "Cloning $REPO (branch: $BRANCH)..."
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
print_ok "Source code ready at $APP_DIR"

# ── Install dependencies ─────────────────────────────────────
print_step "Installing npm dependencies"
cd "$APP_DIR"
npm install --no-fund --no-audit
print_ok "Dependencies installed"

# ── Build TypeScript ─────────────────────────────────────────
print_step "Building backend"
npm run build
print_ok "Backend build complete"

# ── Build Admin UI ───────────────────────────────────────────
if [ -d "$APP_DIR/ui" ]; then
  print_step "Building admin UI (this may take a minute...)"
  cd "$APP_DIR/ui"
  npm install --no-fund --no-audit
  npm run build
  cd "$APP_DIR"
  print_ok "Admin UI built"
fi

# ── Create directories ───────────────────────────────────────
print_step "Setting up directories"
mkdir -p "$DATA_DIR" "$MODELS_DIR"

# ── Generate admin password if not set ──────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  ADMIN_PASS=$(node -e "console.log(require('crypto').randomBytes(20).toString('hex'))")
  INFER_KEY=$(node -e "console.log('sm-' + require('crypto').randomBytes(16).toString('hex'))")
  cat > "$CONFIG_FILE" <<EOF
# SuperModel global config
port: 11451
admin_port: 11435
admin_bind: "127.0.0.1"
admin_password: "$ADMIN_PASS"
api_keys:
  - "$INFER_KEY"
log_level: info
flow_timeout_seconds: 300
max_concurrent_flows: 10
debug_full_payload: false
EOF
  echo ""
  echo "  ┌────────────────────────────────────────────────────────┐"
  echo "  │  Save these credentials:                               │"
  echo "  │                                                        │"
  printf "  │  Inference API Key: %-38s│\n" "$INFER_KEY"
  printf "  │  Admin password:    %-38s│\n" "$ADMIN_PASS"
  echo "  │                                                        │"
  echo "  │  Config: $CONFIG_FILE"
  echo "  └────────────────────────────────────────────────────────┘"
  echo ""
fi
print_ok "Config at $CONFIG_FILE"

# ── Create demo instance (first-time only) ───────────────────
DEMO_DIR="$MODELS_DIR/demo-instance"
if [ ! -d "$DEMO_DIR" ]; then
  print_step "Creating demo instance"
  mkdir -p "$DEMO_DIR/roles" "$DEMO_DIR/flows" "$DEMO_DIR/prompts" "$DEMO_DIR/tools"

  cat > "$DEMO_DIR/roles/assistant.yaml" <<'YAML'
id: assistant
primary: true
# Replace with your own API key and base_url
# Any OpenAI-compatible endpoint works (OpenAI, APImart, OpenRouter, etc.)
provider_model: gpt-4o-mini
api_key: YOUR_API_KEY_HERE
base_url: https://api.openai.com/v1
provider_type: openai
context_window: 32000
system_token_budget: 2000
YAML

  # For review/debate flows, create two reviewer roles
  cat > "$DEMO_DIR/roles/reviewer_a.yaml" <<'YAML'
id: reviewer_a
primary: false
provider_model: gpt-4o-mini
api_key: YOUR_API_KEY_HERE
base_url: https://api.openai.com/v1
provider_type: openai
context_window: 32000
system_token_budget: 2000
system_prompt_extra: "You tend to focus on logical consistency and factual accuracy. You are direct and concise."
YAML

  cat > "$DEMO_DIR/roles/reviewer_b.yaml" <<'YAML'
id: reviewer_b
primary: false
provider_model: gpt-4o-mini
api_key: YOUR_API_KEY_HERE
base_url: https://api.openai.com/v1
provider_type: openai
context_window: 32000
system_token_budget: 2000
system_prompt_extra: "You tend to focus on practical implications and edge cases. You play devil's advocate."
YAML

  # Flow 1: Direct — single shot, no collaboration
  cat > "$DEMO_DIR/flows/direct.yaml" <<'YAML'
id: direct
output_node: node_answer
nodes:
  - id: node_answer
    type: serial
    role_id: assistant
    prompt: |
      You are a helpful, clear-thinking assistant.
      Answer the user's question directly and thoroughly.
      If the question is simple, be concise. If it's complex, break it down step by step.
YAML

  # Flow 2: Review — draft → parallel review → revise loop
  cat > "$DEMO_DIR/flows/review.yaml" <<'YAML'
id: review
output_node: node_final
max_rounds: 5
nodes:
  - id: node_draft
    type: serial
    role_id: assistant
    prompt: |
      You are writing an initial draft response to the user's question.
      Be thorough and accurate. This draft will be reviewed by peers before finalizing.
      Write your complete draft response now.
    next: node_review_group

  - id: node_review_group
    type: parallel
    roles:
      - reviewer_a
      - reviewer_b
    prompt: |
      Review the draft response above. Identify any issues using this severity scale:
      - P0: Critical error (factually wrong, logically flawed, misleading)
      - P1: Significant issue (incomplete, unclear, important nuance missing)
      - P2: Minor improvement (better phrasing, additional examples)

      Format your review as:
      P0 issues: [list or "none"]
      P1 issues: [list or "none"]
      P2 issues: [list or "none"]
      Summary: [brief overall assessment]
    next: node_judge

  - id: node_judge
    type: serial
    role_id: assistant
    prompt: |
      You have received peer reviews of your draft. Analyze the feedback:

      1. If both reviewers found NO P0 or P1 issues: output {"signal": "route", "target": "node_final"} to proceed to final answer.
      2. If there are P0 or P1 issues: revise your response addressing all critical feedback,
         then output {"signal": "route", "target": "node_review_group"} to send back for another review round.

      Always output the signal JSON on its own line at the end of your response.
    next: node_final

  - id: node_final
    type: serial
    role_id: assistant
    prompt: |
      Based on all the drafts and reviews above, write the final polished response to the user.
      This is the version the user will see — make it clear, accurate, and well-structured.
YAML

  # Flow 3: Debate — multi-perspective → find common ground → synthesize
  cat > "$DEMO_DIR/flows/debate.yaml" <<'YAML'
id: debate
output_node: node_synthesis
nodes:
  - id: node_perspectives
    type: parallel
    roles:
      - reviewer_a
      - reviewer_b
    prompt: |
      The user has raised a question that involves value judgments or multiple valid perspectives.
      Present your distinct viewpoint on this topic:
      - State your position clearly
      - Provide 2-3 strongest arguments supporting it
      - Acknowledge the strongest counterargument to your position
      Be intellectually honest — aim to find truth, not just win.
    next: node_common_ground

  - id: node_common_ground
    type: serial
    role_id: assistant
    prompt: |
      You have received arguments from multiple perspectives above.
      Your task: identify the deepest level of agreement.

      1. Find the core assumptions ALL perspectives share
      2. Identify exactly WHERE they diverge and WHY (values? facts? definitions?)
      3. If there's a factual dispute, note what evidence would resolve it
      4. If it's a values dispute, articulate the tradeoff clearly without taking sides

      Output a structured analysis of the convergence/divergence.
    next: node_synthesis

  - id: node_synthesis
    type: serial
    role_id: assistant
    prompt: |
      Based on all perspectives and the common ground analysis above,
      synthesize a final response for the user that:
      - Presents the strongest version of each key position fairly
      - Highlights genuine areas of consensus
      - Clarifies the exact nature of remaining disagreements
      - Helps the user form their own informed view
      Do NOT force a false consensus. Intellectual honesty over false balance.
YAML

  # ── prompts/ directory: dispatch and shared system prompts ──
  cat > "$DEMO_DIR/prompts/dispatch.yaml" <<'YAML'
# dispatch.yaml — 调度提示词（当配置了 dispatch 规则时使用）
# SuperModel 会在调度阶段将此提示词附加给调度 AI，帮助它决定使用哪个发言流。
#
# 示例：根据用户意图路由到不同发言流
# - 需要深度分析 / 争议话题 → debate（辩论流）
# - 需要校对 / 代码审查    → review（审查流）
# - 普通问答 / 快速回复    → direct（直接回答）
#
# 注意：此文件仅在 config.yaml 中配置了 dispatch 时生效。
#       单实例单发言流场景无需配置 dispatch。
dispatch_prompt: |
  You are a routing assistant. Based on the user's message, choose the most appropriate flow:
  - "debate": for controversial topics, complex questions needing multiple perspectives
  - "review": for code review, fact-checking, or content that needs quality verification  
  - "direct": for straightforward questions, casual conversation, quick lookups
  Output only the flow name, nothing else.
YAML

  # ── tools/ directory: tool integration examples ──────────────
  cat > "$DEMO_DIR/tools/web_search.yaml.example" <<'YAML'
# web_search.yaml.example — Web 搜索工具示例（以 Serper 为例）
# 使用前：
#   1. 将本文件重命名为 web_search.yaml
#   2. 将 YOUR_SERPER_API_KEY 替换为真实的 Serper API Key（https://serper.dev）
#   3. 在需要搜索能力的发言流节点中加入 tools: [web_search]
#
# 重要：工具参数名 (q) 必须和目标 API 期望的字段名一致
id: web_search
name: web_search
description: "搜索互联网上的最新信息，获取实时新闻、价格、事件等"
endpoint: "https://google.serper.dev/search"
headers:
  X-API-KEY: "YOUR_SERPER_API_KEY"
parameters:
  type: object
  properties:
    q:
      type: string
      description: "搜索关键词"
  required: [q]
timeout_seconds: 15
YAML

  echo ""
  echo "  Demo instance created at: $DEMO_DIR"
  echo "  Directory structure:"
  echo "    roles/    — AI 角色配置（API key、模型、人设）"
  echo "    flows/    — 发言流配置（节点顺序、提示词）"
  echo "    prompts/  — 系统提示词（dispatch 路由提示词等）"
  echo "    tools/    — 工具集成（web search、code executor 等）"
  echo ""
  echo "  ⚠  Edit role files in $DEMO_DIR/roles/"
  echo "     Replace YOUR_API_KEY_HERE with your actual API key in all 3 role files"
  echo "     Then run: supermodel start"
  echo ""
  print_ok "Demo instance ready (direct / review / debate flows)"
fi

# ── Install supermodel CLI wrapper ───────────────────────────
print_step "Installing supermodel command"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/supermodel" <<WRAPPER
#!/usr/bin/env bash
exec node "$APP_DIR/dist/cli/index.js" "\$@"
WRAPPER
chmod +x "$BIN_DIR/supermodel"

# Add to PATH and set admin password env var
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if ! echo "$PATH" | grep -q "$BIN_DIR"; then
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
    echo "  Added $BIN_DIR to PATH in $SHELL_RC"
  fi
  # Write admin password to shell rc so 'supermodel status/reload/etc' work without extra setup
  if [ -f "$CONFIG_FILE" ]; then
    _PASS=$(grep 'admin_password' "$CONFIG_FILE" | sed 's/.*admin_password: *"\?\([^"]*\)"\?.*/\1/')
    # Remove old entry if present, then append
    grep -v 'SUPERMODEL_ADMIN_PASSWORD' "$SHELL_RC" > /tmp/_sm_rc_tmp && mv /tmp/_sm_rc_tmp "$SHELL_RC" 2>/dev/null || true
    echo "export SUPERMODEL_ADMIN_PASSWORD=\"$_PASS\"" >> "$SHELL_RC"
    export SUPERMODEL_ADMIN_PASSWORD="$_PASS"
    echo "  Set SUPERMODEL_ADMIN_PASSWORD in $SHELL_RC"
  fi
  echo "  Run: source $SHELL_RC  (or open a new terminal)"
fi
print_ok "supermodel command installed at $BIN_DIR/supermodel"

# ── Configure Nginx (expose Admin UI to network) ─────────────
print_step "Configuring Nginx for Admin UI access"
NGINX_CONF_DIR=""
if [ -d "/etc/nginx/sites-available" ]; then
  NGINX_CONF_DIR="/etc/nginx/sites-available"
elif [ -d "/etc/nginx/conf.d" ]; then
  NGINX_CONF_DIR="/etc/nginx/conf.d"
fi

# Install nginx if not present
if ! command -v nginx &>/dev/null; then
  echo "  nginx not found, installing..."
  if command -v apt-get &>/dev/null; then
    apt-get install -y nginx -qq 2>/dev/null || true
  elif command -v yum &>/dev/null; then
    yum install -y nginx -q 2>/dev/null || true
  fi
  # Re-check conf dir after install
  if [ -d "/etc/nginx/sites-available" ]; then
    NGINX_CONF_DIR="/etc/nginx/sites-available"
  elif [ -d "/etc/nginx/conf.d" ]; then
    NGINX_CONF_DIR="/etc/nginx/conf.d"
  fi
fi

if command -v nginx &>/dev/null && [ -n "$NGINX_CONF_DIR" ]; then
  # Write supermodel nginx config
  # Port 11436: reverse proxy for admin UI (which binds 127.0.0.1:11435)
  cat > "$NGINX_CONF_DIR/supermodel.conf" <<'NGINX'
# SuperModel Admin UI — expose to network via port 11436
server {
    listen 11436;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:11435;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
NGINX

  # Enable site if using sites-available/sites-enabled pattern
  if [ -d "/etc/nginx/sites-enabled" ]; then
    ln -sf "$NGINX_CONF_DIR/supermodel.conf" /etc/nginx/sites-enabled/supermodel.conf 2>/dev/null || true
  fi

  # Test and reload
  if nginx -t 2>/dev/null; then
    if systemctl is-active nginx &>/dev/null; then
      systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
    else
      systemctl enable nginx 2>/dev/null || true
      systemctl start nginx 2>/dev/null || nginx 2>/dev/null || true
    fi
    NGINX_OK=true
  else
    echo "  ⚠ Nginx config test failed, skipping nginx setup"
    NGINX_OK=false
  fi
else
  echo "  ⚠ Nginx not available, skipping (Admin UI will be local-only)"
  NGINX_OK=false
fi
print_ok "Nginx configured"


SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP="your-server-ip"

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  SuperModel installed successfully!              ║"
echo "  ║                                                  ║"
echo "  ║  Next steps:                                     ║"
echo "  ║  1. Edit ~/.supermodel/models/demo-instance/     ║"
echo "  ║     roles/assistant.yaml (and reviewer_*.yaml)   ║"
echo "  ║     → replace YOUR_API_KEY_HERE                  ║"
echo "  ║  2. supermodel start                             ║"
echo "  ║  3. Open Admin UI in browser (see below)         ║"
echo "  ║                                                  ║"
echo "  ║  Commands:                                       ║"
echo "  ║    supermodel start / stop / status / reload     ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# Always show credentials from config so users can find them after re-install
if [ -f "$CONFIG_FILE" ]; then
  _PASS=$(grep 'admin_password' "$CONFIG_FILE" | sed 's/.*admin_password: *"\?\([^"]*\)"\?.*/\1/')
  _KEY=$(grep -A1 'api_keys:' "$CONFIG_FILE" | grep '^\s*-' | head -1 | sed 's/.*- *"\?\([^"]*\)"\?.*/\1/')
  echo "  Your credentials (also saved in $CONFIG_FILE):"
  echo ""
  echo "    Inference API Key : $_KEY"
  echo "    Admin password    : $_PASS"
  echo ""
  echo "  Access:"
  echo "    Inference API  : http://${SERVER_IP}:11451/v1"
  if [ "${NGINX_OK:-false}" = "true" ]; then
    echo "    Admin UI       : http://${SERVER_IP}:11436   ← open in browser"
  else
    echo "    Admin UI       : http://localhost:11435 (local only)"
    echo "    Remote access  : ssh -L 11435:localhost:11435 root@${SERVER_IP}"
    echo "                     then open http://localhost:11435"
  fi
  echo ""
fi

