# SuperModel

> 把多个 AI 模型组成**审查流水线**——一条请求，多个模型协作，最终返回高质量答案。完全兼容 OpenAI API，任何支持 OpenAI 的客户端无需改代码直接接入。

---

## 能解决什么问题

你有没有遇到过：

- 单个模型给了一个答案，但你不确定它对不对
- 想让 A 模型写、B 模型审、C 模型拍板，但串联起来太麻烦
- 某些任务需要联网搜索，某些只需要直接回答

SuperModel 就是干这个的。你定义好"谁写、谁审、谁决策"，后面每次请求都自动跑完整条流水线，结果通过标准 OpenAI 接口返回。

---

## 使用场景（示例）

> **注意：以下场景正在整理中，将在后续版本加入完整的配置示例和演示视频。**

| 场景 | 描述 | 适用 Flow |
|------|------|-----------|
| 高精度问答 | 起草 → 双盲审查 → 评委裁判 → 定稿 | review |
| 多视角辩论 | 正反方各自论述 → 主持人总结 | debate |
| 联网搜索 | 先搜索 → 再回答 | 自定义（serial + 工具） |
| 普通对话 | 直接由主力模型回答 | direct |

---

## 30 秒快速上手

**第一步：安装**（需要 Node.js 20+ 和 git）

```bash
curl -fsSL https://raw.githubusercontent.com/hewenze11/supermodel/main/scripts/install.sh | bash
```

安装完自动输出：
```
✓ SuperModel installed

  Inference:  http://your-server-ip:11451
  Admin UI:   http://your-server-ip:11435   (本机访问)
  API Key:    sm-xxxxxxxxxxxxxxxx
  Admin Pass: xxxxxxxx

  下一步：
    编辑 ~/.supermodel/models/demo-instance/roles/ 里的 yaml 文件
    把 YOUR_API_KEY_HERE 替换成你自己的 API Key
    然后运行：supermodel start
```

> **忘记密码？** 直接看 `~/.supermodel/config.yaml` 里的 `admin_password` 字段，那就是你的登录密码。

**第二步：填入 API Key**

```bash
# 编辑 role 配置，把 YOUR_API_KEY_HERE 替换成真实 key
nano ~/.supermodel/models/demo-instance/roles/assistant.yaml
```

**第三步：启动**

```bash
supermodel start
```

**第四步：试一试**

```bash
curl http://localhost:11451/v1/chat/completions \
  -H "Authorization: Bearer YOUR_SM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "demo-instance/direct",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

---

## 管理界面

服务启动后，用浏览器打开：

```
http://localhost:11435
```

输入安装时生成的 Admin 密码登录，可以：

- **Chat**：直接在界面里和不同 flow 对话
- **Models**：查看所有实例、角色、工具配置
- **History**：每次请求的完整执行记录（每个节点的输出、耗时、token 用量）
- **Config**：查看服务配置和连接信息

> **管理界面只绑定本机（127.0.0.1）**，从外部无法直接访问。如果服务器是远程机器，用 SSH 隧道转发：
> ```bash
> ssh -L 11435:127.0.0.1:11435 root@your-server-ip
> ```
> 然后在本地浏览器打开 `http://localhost:11435`。

---

## 接入你的工具

SuperModel 完全兼容 OpenAI API，在任何支持 OpenAI 的工具里填入以下信息即可：

| 字段 | 值 |
|------|----|
| Base URL | `http://your-server-ip:11451/v1` |
| API Key | 安装时生成的 `sm-xxx` key |
| 模型名 | `{实例名}/{flow名}`，如 `demo-instance/review` |

**支持的客户端**：Cursor、Cherry Studio、Open WebUI、LM Studio、任何 OpenAI 兼容应用。

---

## 常用命令

```bash
supermodel start    # 启动（后台运行）
supermodel stop     # 停止
supermodel status   # 查看运行状态
supermodel reload   # 热重载配置（不停服，修改配置后执行）
supermodel logs     # 查看日志
```

---

## 配置详解

### 目录结构

```
~/.supermodel/
├── config.yaml                    # 全局配置（端口、密码、API Key）
├── data.db                        # 执行记录（SQLite）
├── server.log                     # 日志
└── models/
    └── {实例名}/
        ├── roles/                 # 角色配置（每个 yaml = 一个 AI 角色）
        │   ├── assistant.yaml
        │   └── reviewer.yaml
        ├── flows/                 # 发言流配置（每个 yaml = 一个 flow）
        │   ├── direct.yaml
        │   └── review.yaml
        └── tools/                 # 工具配置（可选，HTTP 接口调用）
            └── web_search.yaml
```

### 角色配置（roles/）

```yaml
# roles/assistant.yaml
id: assistant
primary: true                           # 主力角色，每个实例有且只有一个
provider_model: gpt-4o-mini             # 上游模型名称
api_key: sk-xxxxx                       # 你的 API Key
base_url: https://api.openai.com/v1     # 任何 OpenAI 兼容接口
provider_type: openai                   # openai 或 anthropic
context_window: 32000                   # 上下文 token 上限
```

### 发言流配置（flows/）

**最简单的 direct 流**（单个模型直接回答）：

```yaml
# flows/direct.yaml
id: direct
output_node: node_answer
nodes:
  - id: node_answer
    type: serial
    role_id: assistant
    prompt: "You are a helpful assistant. Answer clearly and concisely."
```

**review 流**（起草 → 并行审查 → 评委裁判 → 定稿）：

```yaml
# flows/review.yaml
id: review
output_node: node_final
max_rounds: 5
nodes:
  - id: node_draft
    type: serial
    role_id: assistant
    prompt: "写出你对用户问题的初稿。"
    next: node_reviewers

  - id: node_reviewers
    type: parallel
    roles: [reviewer_a, reviewer_b]
    prompt: "对上面的内容提出审查意见，列出问题。"
    next: node_judge

  - id: node_judge
    type: serial
    role_id: assistant
    prompt: |
      看到初稿和审查意见后，做出决定：
      - 如果内容已经足够好，用 {"signal":"route","target":"node_final"} 路由到终稿节点
      - 如果需要修改，用 {"signal":"route","target":"node_draft"} 返回起草节点

  - id: node_final
    type: serial
    role_id: assistant
    prompt: "综合所有讨论，写出最终答案。"
```

### 工具配置（tools/，可选）

```yaml
# tools/web_search.yaml
id: web_search
name: web_search
description: "搜索互联网上的最新信息"
endpoint: "https://your-search-api/search"
parameters:
  type: object
  properties:
    query:
      type: string
      description: "搜索关键词"
  required: [query]
```

配置好工具后，在 flow 的节点里加 `tools: [web_search]`，对应节点就能调用工具了。

### 全局配置（config.yaml）

```yaml
port: 11451                    # 推理接口端口（对外）
admin_port: 11435              # 管理界面端口（本机访问）
admin_bind: "127.0.0.1"        # 管理界面只绑本机（安全）
admin_password: "xxx"          # 管理员密码
api_keys:
  - "sm-your-key"              # 推理接口鉴权 key（可配多个）
log_level: info                # debug / info / warn / error
flow_timeout_seconds: 300      # 单次请求超时（秒）
max_concurrent_flows: 10       # 最大并发数
```

修改后执行 `supermodel reload` 立即生效，无需重启。

---

## 节点类型速查

| 类型 | 说明 | 关键字段 |
|------|------|---------|
| `serial` | 单个 role 串行执行 | `role_id`, `prompt`, `tools`（可选）, `next` |
| `parallel` | 多个 role 并行执行，结果合并 | `roles: [...]`, `prompt`, `next` |

`output_node`：flow 中哪个节点的输出作为最终返回给用户的答案（必须指定）。

---

## 响应格式

完全兼容 OpenAI，额外返回 `x_supermodel_usage`（各角色 token 用量）：

```json
{
  "choices": [{"message": {"role": "assistant", "content": "..."}}],
  "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
  "x_supermodel_usage": {
    "assistant": {"prompt_tokens": 65, "completion_tokens": 26},
    "reviewer_a": {"prompt_tokens": 20, "completion_tokens": 10}
  }
}
```

---

## 环境要求

- Node.js 20+
- git
- Linux / macOS

---

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/hewenze11/supermodel/main/scripts/uninstall.sh | bash
```

只删除 `~/.supermodel/` 和 CLI binary，不影响系统环境。

---

## License

MIT
