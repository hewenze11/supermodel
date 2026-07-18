export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ============================================================
// Message List - flow-level 上下文管理
// 只存 user/assistant 两种角色，system 和 tool 不进 MessageList
// ============================================================

export interface MessageMetadata {
  source?: 'user_input' | 'node_output' | 'parallel_merge' | 'judge_feedback' | 'tool_result' | 'tool_error';
  node_id?: string;
  role_id?: string;
  tool_id?: string;
  round?: number;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  metadata?: MessageMetadata;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// RoleConfig subset needed by buildMessages
export interface RoleConfigForMessages {
  context_window?: number;
  system_token_budget?: number;
  system_prompt_extra?: string;
}

const SYSTEM_PREFIX = 'You are a helpful AI assistant.';

export class MessageList {
  private messages: Message[] = [];

  // 追加消息（只接受 user/assistant）
  appendMessage(message: Message): void {
    if (message.role === 'user' || message.role === 'assistant') {
      this.messages.push(message);
    }
  }

  // 兼容旧接口
  addMessage(message: { role: string; content: string; metadata?: MessageMetadata }): void {
    if (message.role === 'user' || message.role === 'assistant') {
      this.messages.push({ role: message.role, content: message.content, metadata: message.metadata });
    }
  }

  getMessages(): readonly Message[] {
    return [...this.messages];
  }

  getLastAssistantContent(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        return this.messages[i].content;
      }
    }
    return '';
  }

  clear(): void {
    this.messages = [];
  }

  // ──────────────────────────────────────────────────────────
  // buildMessages: 构建发给 LLM 的 messages
  // 接受 contextWindow 参数，内部调用 trimToTokenLimit
  // ──────────────────────────────────────────────────────────
  buildMessages(nodePrompt: string, role?: RoleConfigForMessages): LLMMessage[] {
    const contextWindow = role?.context_window ?? 32000;
    const systemBudget = role?.system_token_budget ?? 2000;

    // 1. 组装系统提示词
    const systemParts = [SYSTEM_PREFIX];
    if (role?.system_prompt_extra) systemParts.push(role.system_prompt_extra);
    if (nodePrompt) systemParts.push(nodePrompt);
    const systemContent = systemParts.filter(Boolean).join('\n\n');

    // 2. 过滤 metadata，只传 role/content
    const conversationMessages: LLMMessage[] = this.messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }));

    // 3. 按 context_window - system_budget 做截断
    const limit = contextWindow - systemBudget;
    const trimmed = this.trimToTokenLimit(conversationMessages, limit);

    // 4. 防御性检查：合并连续 user，末尾必须是 user
    const fixed = this.fixRoleAlternation(trimmed);

    return [
      { role: 'system', content: systemContent },
      ...fixed
    ];
  }

  // ──────────────────────────────────────────────────────────
  // token 估算
  // ──────────────────────────────────────────────────────────
  estimateTokenCount(text: string): number {
    let chinese = 0;
    let other = 0;
    for (const char of text) {
      const code = char.charCodeAt(0);
      if ((code >= 0x4e00 && code <= 0x9fff) ||
          (code >= 0x3400 && code <= 0x4dbf) ||
          (code >= 0xf900 && code <= 0xfaff)) {
        chinese++;
      } else {
        other++;
      }
    }
    return Math.ceil(chinese * 1.2 + other * 0.3);
  }

  // ──────────────────────────────────────────────────────────
  // trimToTokenLimit: 截断 messages 到 token 上限
  // 策略（架构书 M3.6）：
  //   1. 成对删除旧 user-assistant 对（保留第一条 user 作锚点）
  //   2. 删除后在保留区开头插入断层标记 [N turns omitted]
  //   3. 单条尾部超限，按剩余 token 比例截断
  // ──────────────────────────────────────────────────────────
  trimToTokenLimit(messages: LLMMessage[], limit: number): LLMMessage[] {
    if (messages.length === 0) return [];

    const countTokens = (msgs: LLMMessage[]) => msgs.reduce((s, m) => s + this.estimateTokenCount(m.content), 0);

    if (countTokens(messages) <= limit) return [...messages];

    // Work on a mutable copy, keep index 0 as anchor (original user input)
    const result: LLMMessage[] = [...messages];
    let omitted = 0;

    // Remove pairs (user+assistant) from index 1 onward
    while (result.length > 1 && countTokens(result) > limit) {
      // Find first user+assistant pair starting from index 1
      let pairStart = -1;
      for (let i = 1; i < result.length - 1; i++) {
        if (result[i].role === 'user' && result[i + 1].role === 'assistant') {
          pairStart = i;
          break;
        }
      }
      if (pairStart !== -1) {
        result.splice(pairStart, 2);
        omitted += 2;
      } else {
        // No clean pair found; remove single oldest (index 1)
        result.splice(1, 1);
        omitted += 1;
      }
    }

    // Insert omission marker after the anchor (index 0) if anything was removed
    if (omitted > 0 && result.length > 1) {
      result.splice(1, 0, {
        role: 'user',
        content: `[${omitted} earlier message(s) omitted due to context limit]`
      });
    }

    // If the last message alone still exceeds limit, truncate it proportionally
    const last = result[result.length - 1];
    const lastTokens = this.estimateTokenCount(last.content);
    const remaining = limit - countTokens(result.slice(0, -1));
    if (remaining > 0 && lastTokens > remaining) {
      const ratio = remaining / lastTokens;
      const maxChars = Math.floor(last.content.length * ratio * 0.9);
      result[result.length - 1] = { ...last, content: last.content.slice(0, maxChars) + '...[truncated]' };
    }

    return result;
  }

  // ──────────────────────────────────────────────────────────
  // fixRoleAlternation: 合并连续 user，末尾加 user 占位
  // ──────────────────────────────────────────────────────────
  private fixRoleAlternation(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    // 合并连续 user
    const result: LLMMessage[] = [];
    for (const msg of messages) {
      if (result.length > 0 && result[result.length - 1].role === 'user' && msg.role === 'user') {
        result[result.length - 1] = {
          role: 'user',
          content: result[result.length - 1].content + '\n\n---\n\n' + msg.content
        };
      } else {
        result.push({ ...msg });
      }
    }

    // 末尾必须是 user（某些 API 要求）
    if (result[result.length - 1]?.role === 'assistant') {
      result.push({ role: 'user', content: '(please continue)' });
    }

    return result;
  }

  // ──────────────────────────────────────────────────────────
  // 旧版 trimToTokenLimit (公开兼容接口，修改 this.messages)
  // ──────────────────────────────────────────────────────────
  trimToTokenLimitInPlace(maxTokens: number): void {
    let total = 0;
    for (const m of this.messages) total += this.estimateTokenCount(m.content);
    while (this.messages.length > 1 && total > maxTokens) {
      const removed = this.messages.splice(1, 1)[0];
      total -= this.estimateTokenCount(removed.content);
    }
  }

  // ──────────────────────────────────────────────────────────
  // getInputMessagesSnapshot: 存库前快照，每条 content 截断到 2000 字符
  // ──────────────────────────────────────────────────────────
  getInputMessagesSnapshot(): string {
    const copy = this.messages.map(m => ({
      role: m.role,
      content: m.content.length > 2000 ? m.content.slice(0, 2000) + '...' : m.content
    }));
    return JSON.stringify(copy);
  }
}




