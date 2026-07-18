// API client — all calls go through the admin port (same origin)
// Auth: Bearer token stored in sessionStorage

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  return sessionStorage.getItem('sm_token') ?? '';
}

export function setToken(t: string) {
  sessionStorage.setItem('sm_token', t);
}

export function clearToken() {
  sessionStorage.removeItem('sm_token');
}

async function adminFetch(path: string, init: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`/admin${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = '/login/';
    throw new Error('Unauthorized');
  }
  return res;
}

export async function apiLogin(password: string): Promise<string> {
  const res = await fetch('/admin/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error('Wrong password');
  const data = await res.json();
  return data.token as string;
}

export async function apiStatus() {
  const res = await adminFetch('/status');
  return res.json();
}

export async function apiReload() {
  const res = await adminFetch('/reload', { method: 'POST' });
  return res.json();
}

export async function apiShutdown() {
  const res = await adminFetch('/shutdown', { method: 'POST' });
  return res.json();
}

export async function apiFlows(page = 1, pageSize = 20) {
  const res = await adminFetch(`/flows?page=${page}&page_size=${pageSize}`);
  return res.json();
}

export async function apiFlowDetail(id: string) {
  const res = await adminFetch(`/flows/${id}`);
  return res.json();
}

// SSE streaming test — POST /admin/test
// Returns a cancel function. Calling it aborts the request.
// SSE end condition: data: [DONE] or finish_reason set in choices[0]
// usage field is ONLY collected for stats, does NOT trigger onDone alone.
export function apiTestStream(
  model: string,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void,
  onDone: (usage?: any) => void,
  onError: (e: string) => void
): () => void {
  const controller = new AbortController();
  const token = getToken();
  let doneCalled = false;

  function safeDone(usage?: any) {
    if (doneCalled) return;
    doneCalled = true;
    onDone(usage);
  }

  fetch('/admin/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: controller.signal,
  }).then(async (res) => {
    if (!res.ok) {
      if (res.status === 401) { clearToken(); window.location.href = '/login/'; return; }
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      onError(err?.error?.message ?? 'Request failed');
      return;
    }

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lastUsage: any = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { safeDone(lastUsage); break; }
        buf += dec.decode(value, { stream: true });

        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') { safeDone(lastUsage); return; }

          try {
            const chunk = JSON.parse(data);
            // Collect usage for stats but do NOT end stream here
            if (chunk.usage) lastUsage = chunk;
            if (chunk.x_supermodel_usage) lastUsage = chunk;

            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content;
            if (delta) onChunk(delta);

            // End on finish_reason (non-null means LLM is done generating)
            if (choice?.finish_reason != null) {
              safeDone(lastUsage ?? chunk);
              return;
            }
          } catch { /* ignore JSON parse errors on partial chunks */ }
        }
      }
    } finally {
      try { reader.cancel(); } catch { /* ignore */ }
    }
  }).catch((e) => {
    if (e.name === 'AbortError') return;
    onError(e.message);
  });

  return () => {
    controller.abort();
    safeDone(); // ensure UI resets even if stream is mid-flight
  };
}
