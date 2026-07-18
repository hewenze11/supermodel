'use client';
import { useState, useEffect } from 'react';
import Nav from '@/components/Nav';
import { apiStatus, apiShutdown, getToken } from '@/lib/api';
import { useRouter } from 'next/navigation';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={copy} className="text-xs text-gray-400 hover:text-gray-700 ml-2 transition-colors">
      {copied ? '✓ copied' : 'copy'}
    </button>
  );
}

function Row({ label, value, mono = false, secret = false }: { label: string; value: string; mono?: boolean; secret?: boolean }) {
  const [show, setShow] = useState(false);
  const display = secret && !show ? '•'.repeat(Math.min(value.length, 12)) : value;
  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500 w-40 shrink-0">{label}</span>
      <div className="flex items-center flex-1 min-w-0">
        <span className={`text-sm truncate ${mono ? 'font-mono text-gray-700' : 'text-gray-800'}`}>{display}</span>
        {secret && (
          <button onClick={() => setShow(s => !s)} className="text-xs text-gray-400 hover:text-gray-700 ml-2">
            {show ? 'hide' : 'show'}
          </button>
        )}
        <CopyButton text={value} />
      </div>
    </div>
  );
}

export default function ConfigPage() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [shutdownConfirm, setShutdownConfirm] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!getToken()) { router.replace('/login/'); return; }
    apiStatus()
      .then(d => { setStatus(d); setLoading(false); })
      .catch(() => router.replace('/login/'));
  }, []);

  async function doShutdown() {
    if (!shutdownConfirm) { setShutdownConfirm(true); return; }
    await apiShutdown();
    setShutdownConfirm(false);
  }

  const cfg = status?.config ?? {};
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const inferPort = cfg.port ?? 11451;

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 overflow-y-auto max-w-3xl mx-auto w-full px-4 py-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Config</h1>
          <p className="text-sm text-gray-500 mt-0.5">Connection info and server settings</p>
        </div>

        {loading ? (
          <div className="text-center text-gray-400 py-16 text-sm">Loading…</div>
        ) : (
          <>
            {/* Connection info */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h2 className="font-semibold text-gray-800 mb-4">Connect your tools</h2>
              <Row label="Base URL" value={`http://${host}:${inferPort}/v1`} mono />
              <Row label="API Keys" value={(cfg.api_keys ?? []).join(', ') || '(none set)'} mono secret />
              <p className="text-xs text-amber-600 mt-1">⚠ Keys above are masked. The real values are in ~/.supermodel/config.yaml → api_keys. Copy here gives masked form only.</p>
              <p className="text-xs text-gray-400 mt-3">
                Use these with any OpenAI-compatible client (Cursor, Cherry Studio, LM Studio, etc.)
              </p>
            </div>

            {/* Server status */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h2 className="font-semibold text-gray-800 mb-4">Server</h2>
              <Row label="Inference port" value={String(cfg.port ?? 11451)} mono />
              <Row label="Admin port" value={String(cfg.admin_port ?? 11435)} mono />
              <Row label="Log level" value={cfg.log_level ?? 'info'} />
              <Row label="Flow timeout" value={`${cfg.flow_timeout_seconds ?? 300}s`} />
              <Row label="Max concurrent" value={String(cfg.max_concurrent_flows ?? 10)} />
              <Row label="Debug payload" value={cfg.debug_full_payload ? 'enabled' : 'disabled'} />
            </div>

            {/* Instances summary */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h2 className="font-semibold text-gray-800 mb-4">Loaded instances</h2>
              {Object.keys(status?.instances ?? {}).length === 0 ? (
                <p className="text-sm text-gray-400">No instances. Add configs to ~/.supermodel/models/</p>
              ) : (
                <div className="space-y-1">
                  {Object.entries(status?.instances ?? {}).map(([name, inst]: any) => (
                    <div key={name} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-100 last:border-0">
                      <span className="font-medium text-gray-800">{name}</span>
                      <span className="text-gray-400 text-xs">
                        {Object.keys(inst.roles ?? {}).length}r · {Object.keys(inst.flows ?? {}).length}f
                        {inst.tools ? ` · ${Object.keys(inst.tools).length}t` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Danger zone */}
            <div className="bg-white border border-red-200 rounded-xl p-5">
              <h2 className="font-semibold text-red-700 mb-3">Danger zone</h2>
              <p className="text-sm text-gray-500 mb-4">
                Shutdown gracefully waits for running flows to finish (up to 30s) then exits.
              </p>
              <button
                onClick={doShutdown}
                className={`text-sm px-4 py-2 rounded-lg font-medium transition-colors ${
                  shutdownConfirm
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'border border-red-300 text-red-600 hover:bg-red-50'
                }`}
              >
                {shutdownConfirm ? '⚠ Click again to confirm shutdown' : 'Shutdown server'}
              </button>
              {shutdownConfirm && (
                <button
                  onClick={() => setShutdownConfirm(false)}
                  className="ml-3 text-sm text-gray-400 hover:text-gray-700"
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
