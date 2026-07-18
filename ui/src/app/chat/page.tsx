'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import Nav from '@/components/Nav';
import { apiStatus, apiTestStream, getToken } from '@/lib/api';
import { useRouter } from 'next/navigation';

interface Message { role: 'user' | 'assistant'; content: string; }
interface ModelOption { id: string; display_name: string; }

const CHAT_STORAGE_KEY = 'sm_chat_history_v1';
const CHAT_MODEL_KEY   = 'sm_chat_model_v1';

function loadHistory(model: string): Message[] {
  try {
    const raw = sessionStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, Message[]>;
    return all[model] ?? [];
  } catch { return []; }
}

function saveHistory(model: string, msgs: Message[]) {
  try {
    // Guard against prototype pollution from model name
    if (model === '__proto__' || model === 'constructor' || model === 'prototype') return;
    const raw = sessionStorage.getItem(CHAT_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) as Record<string, Message[]> : {};
    all[model] = msgs.slice(-60); // keep last 60 messages per model
    sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(all));
  } catch { /* storage full or unavailable */ }
}

export default function ChatPage() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [lastUsage, setLastUsage] = useState<any>(null);
  const [error, setError] = useState('');
  const stopRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Restore last selected model on mount
  useEffect(() => {
    if (!getToken()) { router.replace('/login/'); return; }
    apiStatus().then(d => {
      const opts: ModelOption[] = [];
      for (const [instName, inst] of Object.entries(d.instances ?? {})) {
        for (const flowName of Object.keys((inst as any).flows ?? {})) {
          opts.push({ id: `${instName}/${flowName}`, display_name: `${instName} / ${flowName}` });
        }
      }
      setModels(opts);
      // Restore last used model, fall back to first
      const savedModel = sessionStorage.getItem(CHAT_MODEL_KEY);
      const initial = savedModel && opts.find(o => o.id === savedModel) ? savedModel : (opts[0]?.id ?? '');
      setSelectedModel(initial);
      if (initial) setMessages(loadHistory(initial));
    }).catch(() => router.replace('/login/'));
  }, [router]);

  // When model changes: persist choice + load that model's history
  const handleModelChange = (newModel: string) => {
    // Persist current model selection
    sessionStorage.setItem(CHAT_MODEL_KEY, newModel);
    setSelectedModel(newModel);
    setMessages(loadHistory(newModel));
    setLastUsage(null);
    setError('');
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  const send = useCallback(() => {
    if (!input.trim() || streaming || !selectedModel) return;
    const modelAtSend = selectedModel; // capture to avoid closure race if model changes mid-stream
    const userMsg: Message = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    saveHistory(modelAtSend, newMessages);
    setInput('');
    setError('');
    setStreaming(true);
    setLastUsage(null);

    const assistantIdx = newMessages.length;
    setMessages(m => [...m, { role: 'assistant', content: '' }]);

    const stop = apiTestStream(
      modelAtSend,
      newMessages,
      (delta) => {
        setMessages(m => {
          const copy = [...m];
          copy[assistantIdx] = { role: 'assistant', content: copy[assistantIdx].content + delta };
          return copy;
        });
      },
      (finalChunk) => {
        setStreaming(false);
        stopRef.current = null;
        if (finalChunk?.usage) setLastUsage(finalChunk.usage);
        if (finalChunk?.x_supermodel_usage) setLastUsage(finalChunk.x_supermodel_usage);
        // Persist completed conversation under the model that was active when send() was called
        setMessages(m => {
          saveHistory(modelAtSend, m);
          return m;
        });
      },
      (e) => {
        setError(e);
        setStreaming(false);
        stopRef.current = null;
      }
    );
    stopRef.current = stop;
  }, [input, streaming, selectedModel, messages]);

  function abort() {
    stopRef.current?.();
    stopRef.current = null;
    setStreaming(false);
  }

  function clearChat() {
    setMessages([]);
    saveHistory(selectedModel, []);
    setLastUsage(null);
    setError('');
  }

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 flex flex-col overflow-hidden max-w-3xl mx-auto w-full px-4 py-4 gap-3">
        {/* Model selector + controls */}
        <div className="flex items-center gap-2">
          <select
            value={selectedModel}
            onChange={e => handleModelChange(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-gray-800"
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.display_name}</option>
            ))}
            {models.length === 0 && <option value="">No models — check Config</option>}
          </select>
          <button
            onClick={clearChat}
            className="text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors"
          >
            Clear
          </button>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {messages.length === 0 && (
            <div className="text-center text-gray-400 text-sm mt-16">
              <p className="text-2xl mb-2">⚡</p>
              <p>Select a model and start chatting</p>
              <p className="text-xs mt-1 text-gray-300">review / debate flows may take 30–60s</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                m.role === 'user'
                  ? 'bg-gray-900 text-white'
                  : 'bg-white border border-gray-200 text-gray-800'
              }`}>
                {m.content || (streaming && i === messages.length - 1
                  ? <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse rounded-sm" />
                  : '')}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Usage bar */}
        {lastUsage && (
          <div className="text-xs text-gray-400 flex flex-wrap gap-x-3">
            {typeof lastUsage.prompt_tokens === 'number'
              ? <>
                  <span>↑ {lastUsage.prompt_tokens} prompt</span>
                  <span>↓ {lastUsage.completion_tokens} completion</span>
                  <span>∑ {lastUsage.total_tokens} total</span>
                </>
              : Object.entries(lastUsage).map(([role, u]: any) => (
                  <span key={role}>{role}: {u.prompt_tokens}↑ {u.completion_tokens}↓</span>
                ))
            }
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{error}</div>
        )}

        {/* Input */}
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={streaming}
            className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-gray-800 disabled:opacity-50"
          />
          {streaming ? (
            <button
              onClick={abort}
              className="bg-red-600 text-white rounded-xl px-4 text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim() || !selectedModel}
              className="bg-gray-900 text-white rounded-xl px-4 text-sm font-medium hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
