# SuperModel

> 一个极简的 AI 推理路由引擎，兼容 OpenAI API 协议。

## 能做什么

- 把多个 AI 角色（role）组织成**发言流（flow）**，一次请求走完整个流程
- 完全兼容 OpenAI API，任何支持 OpenAI 的客户端无需改代码直接接入
- 支持流式（stream）和非流式两种模式
- 单进程，轻量，一个安装脚本搞定

---

## 快速安装

**Linux / macOS**（需要 Node.js 20+、git）：

```bash
curl -fsSL https://raw.githubusercontent.com/hewenze11/supermodel/main/scripts/install.sh | bash
```

安装完成后会输出：
- Admin 密码（保存好，后续管理用）
- 配置文件路径：`~/.supermodel/config.yaml`

---

## 启动 / 停止

```bash
supermodel start    # 启动服务（后台运行）
supermodel stop     # 停止服务
supermodel status   # 查看运行状态
supermodel reload   # 热重载配置（不停服）
```

服务启动后：
- **推理接口**：`http://localhost:11451`（对外）
- **管理接口**：`http://localhost:11435`（仅本机）

---

## 配置你的第一个实例

### 1. 创建实例目录

```bash
mkdir -p ~/.supermodel/models/my-instance/roles
mkdir -p ~/.supermodel/models/my-instance/flows
```

### 2. 配置角色（role）

`~/.supermodel/models/my-instance/roles/role_1.yaml`

```yaml
id: role_1
primary: true                          # 主力角色，有且只有一个
provider_model: gpt-4o-mini            # 上游模型名称
api_key: sk-xxxxx                      # 你的 API Key
base_url: https://api.openai.com/v1    # 任何 OpenAI 兼容接口均可
provider_type: openai                  # openai 或 anthropic
context_window: 32000                  # token 上限
system_token_budget: 2000              # 系统提示词预留 token
```

### 3. 配置发言流（flow）

`~/.supermodel/models/my-instance/flows/direct.yaml`

```yaml
id: direct
output_node: node_1
nodes:
  - id: node_1
    type: serial
    role_id: role_1
    prompt: "You are a helpful assistant. Answer clearly and concisely."
```

### 4. 重载配置

```bash
supermodel reload
```

### 5. 验证

```bash
# 查看可用模型
curl http://localhost:11451/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# 发一条消息
curl http://localhost:11451/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"my-instance/direct","messages":[{"role":"user","content":"hello"}]}'
```

---

## 全局配置

`~/.supermodel/config.yaml`

```yaml
port: 11451                  # 推理接口端口
admin_port: 11435            # 管理接口端口
admin_bind: "127.0.0.1"      # 管理接口只绑本机（安全）
admin_password: "xxx"        # 管理员密码（安装时自动生成）
api_keys:                    # 推理接口的 API Key 列表
  - "your-inference-key"
log_level: info
flow_timeout_seconds: 300    # 单次请求超时（秒）
max_concurrent_flows: 10     # 最大并发数
debug_full_payload: false    # 开启后落库完整请求，调试用
```

修改后执行 `supermodel reload` 生效。

---

## API 说明

完全兼容 OpenAI Chat Completions 协议。

### 鉴权

所有请求需要带 `Authorization: Bearer YOUR_API_KEY`（key 在 config.yaml 的 `api_keys` 里配置）。

### 模型名格式

```
{实例名}/{发言流名}
```

例如：`my-instance/direct`、`my-instance/review`

### 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 列出所有可用模型 |
| POST | `/v1/chat/completions` | 发起推理（支持 stream） |

### 响应扩展字段

非流式响应会额外返回 `x_supermodel_usage`，包含每个 role 的 token 用量：

```json
{
  "x_supermodel_usage": {
    "role_1": {
      "prompt_tokens": 38,
      "completion_tokens": 5
    }
  }
}
```

---

## 发言流节点类型

### serial（串行节点）

一个 role 依次执行，结果传给下一个节点。

```yaml
- id: node_1
  type: serial
  role_id: role_1
  prompt: "你的任务提示词"
```

### parallel（并行节点）

多个 role 同时执行，结果合并后传给下一个节点。

```yaml
- id: node_review
  type: parallel
  roles:
    - role_2
    - role_3
  prompt: "请对上面的内容提出审查意见"
  next: node_judge
```

### tool（工具节点）

调用外部 HTTP 接口。

```yaml
- id: node_search
  type: tool
  tool_ref: web_search
  next: node_1
```

---

## 目录结构

```
~/.supermodel/
├── config.yaml              # 全局配置
├── data.db                  # SQLite 数据库（执行记录）
├── server.log               # 服务日志
└── models/
    └── my-instance/
        ├── roles/
        │   └── role_1.yaml
        └── flows/
            └── direct.yaml
```

---

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/hewenze11/supermodel/main/scripts/uninstall.sh | bash
```

只删除 SuperModel 自身（`~/.supermodel/`、CLI binary），**不会动 Node.js、git 或任何其他系统依赖**。

---

## 环境要求

- Node.js 20+
- git
- Linux / macOS（Windows 暂不支持安装脚本，可手动 clone + npm install + npm run build）

---

## License

MIT
