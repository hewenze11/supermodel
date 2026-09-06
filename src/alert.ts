/**
 * Ops alerting — posts a plain-text message to a Feishu custom bot webhook.
 * Controlled by env ALERT_WEBHOOK_URL; no-op when unset.
 * Per-key cooldown (default 60s) to avoid alert storms; the number of suppressed
 * alerts during the cooldown is reported on the next send so scale is not lost.
 * Key map is bounded (MAX_KEYS, FIFO eviction) so long-running processes don't grow unbounded.
 */
const lastSentAt = new Map<string, { at: number; suppressed: number }>();
const MAX_KEYS = 500;
const DEFAULT_COOLDOWN_MS = 60_000;

export async function sendAlert(key: string, title: string, lines: string[], cooldownMs = DEFAULT_COOLDOWN_MS): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const now = Date.now();
  const entry = lastSentAt.get(key);
  if (entry && now - entry.at < cooldownMs) {
    entry.suppressed++;
    return;
  }
  const suppressed = entry?.suppressed ?? 0;
  if (!entry && lastSentAt.size >= MAX_KEYS) {
    const oldest = lastSentAt.keys().next().value;
    if (oldest !== undefined) lastSentAt.delete(oldest);
  }
  lastSentAt.set(key, { at: now, suppressed: 0 });

  const env = process.env.NODE_ENV ?? 'unknown';
  const header = `[supermodel/${env}] ${title}` + (suppressed > 0 ? `（冷却期内另有 ${suppressed} 次同类告警被抑制）` : '');
  const text = [header, ...lines].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: controller.signal
    });
  } catch (err: any) {
    console.error(`[alert] failed to send: ${err?.message}`);
  } finally {
    clearTimeout(timer);
  }
}
