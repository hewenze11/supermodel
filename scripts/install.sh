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
print_step "Building"
npm run build
print_ok "Build complete"

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
  mkdir -p "$DEMO_DIR/roles" "$DEMO_DIR/flows"

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

  cat > "$DEMO_DIR/flows/direct.yaml" <<'YAML'
id: direct
output_node: node_1
nodes:
  - id: node_1
    type: serial
    role_id: assistant
    prompt: "You are a helpful assistant. Answer clearly and concisely."
YAML

  echo ""
  echo "  Demo instance created at: $DEMO_DIR"
  echo "  ⚠  Edit $DEMO_DIR/roles/assistant.yaml"
  echo "     and replace YOUR_API_KEY_HERE with your actual API key"
  echo "     then run: supermodel start"
  echo ""
  print_ok "Demo instance ready"
fi

# ── Install supermodel CLI wrapper ───────────────────────────
print_step "Installing supermodel command"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/supermodel" <<WRAPPER
#!/usr/bin/env bash
exec node "$APP_DIR/dist/cli/index.js" "\$@"
WRAPPER
chmod +x "$BIN_DIR/supermodel"

# Add to PATH if needed
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
  fi
  if [ -n "$SHELL_RC" ]; then
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
    echo "  Added $BIN_DIR to PATH in $SHELL_RC"
    echo "  Run: source $SHELL_RC  (or open a new terminal)"
  fi
fi
print_ok "supermodel command installed at $BIN_DIR/supermodel"

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  SuperModel installed successfully!              ║"
echo "  ║                                                  ║"
echo "  ║  Next steps:                                     ║"
echo "  ║  1. Edit ~/.supermodel/models/demo-instance/     ║"
echo "  ║     roles/assistant.yaml                         ║"
echo "  ║     → replace YOUR_API_KEY_HERE                  ║"
echo "  ║  2. supermodel start                             ║"
echo "  ║  3. curl http://localhost:11451/v1/models \\      ║"
echo "  ║       -H 'Authorization: Bearer <your-key>'      ║"
echo "  ║                                                  ║"
echo "  ║  Commands:                                       ║"
echo "  ║    supermodel start   / stop / status / reload   ║"
echo "  ║                                                  ║"
echo "  ║  Inference:  http://localhost:11451              ║"
echo "  ║  Admin:      http://localhost:11435 (local only) ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
