'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Nav from '@/components/Nav';
import { apiFlows, apiFlowDetail, getToken } from '@/lib/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const STATUS_COLOR: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  running: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-gray-100 text-gray-600',
  aborted: 'bg-gray-100 text-gray-600',
  timeout: 'bg-yellow-100 text-yellow-700',
};

async function cancelExecution(id: string) {
  const token = getToken();
  await fetch(`/admin/executions/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
}

// ─────────── Detail Panel ───────────
function DetailPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFlowDetail(id).then(d => { setDetail(d); setLoading(false); }).catch(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function handleCancel() {
    setCancelling(true);
    await cancelExecution(id);
    setTimeout(() => { load(); setCancelling(false); }, 800);
  }

  if (loading) return <div className="text-gray-400 text-sm py-8 text-center">Loading…</div>;

  const exec = detail?.execution;
  const nodes = detail?.node_executions ?? [];

  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-800 mb-4 inline-block">← Back to list</button>

      {exec && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-bold text-gray-900">{exec.instance_name}/{exec.flow_name}</h2>
              <p className="font-mono text-xs text-gray-400 mt-0.5">{exec.id}</p>
            </div>
            <div className="flex items-center gap-2">
              {exec.status === 'running' && (
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="text-xs bg-red-600 text-white px-3 py-1 rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[exec.status] ?? 'bg-gray-100 text-gray-600'}`}>
                {exec.status}
              </span>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
            <div><p className="text-xs text-gray-400">Rounds</p><p className="font-medium">{exec.rounds ?? 0}</p></div>
            <div><p className="text-xs text-gray-400">Finish reason</p><p className="font-medium">{exec.finish_reason ?? '–'}</p></div>
            <div>
              <p className="text-xs text-gray-400">Duration</p>
              <p className="font-medium">
                {exec.finished_at && exec.started_at
                  ? `${((exec.finished_at - exec.started_at) / 1000).toFixed(1)}s` : '–'}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-800">Node executions ({nodes.length})</h3>
        <button onClick={load} className="text-xs text-gray-400 hover:text-gray-700 border border-gray-200 px-2 py-1 rounded">↺ Refresh</button>
      </div>
      <div className="space-y-3">
        {nodes.map((n: any) => (
          <div key={n.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-gray-800">{n.node_id}</span>
                {n.role_id && <span className="text-xs text-gray-400">role: {n.role_id}</span>}
                {n.parallel_index !== null && n.parallel_index !== undefined &&
                  <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">parallel #{n.parallel_index}</span>}
                {n.round != null && <span className="text-xs text-gray-400">round {n.round}</span>}
              </div>
              <div className="flex items-center gap-2">
                {(n.prompt_tokens || n.completion_tokens) &&
                  <span className="text-xs text-gray-400">{n.prompt_tokens}↑ {n.completion_tokens}↓</span>}
                {n.started_at && (
                  <span className="text-xs text-gray-400">
                    {n.finished_at ? `${((n.finished_at - n.started_at) / 1000).toFixed(1)}s` : 'running…'}
                  </span>
                )}
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[n.status] ?? 'bg-gray-100 text-gray-600'}`}>
                  {n.status}
                </span>
              </div>
            </div>
            {n.output_text && (
              <div className="px-4 py-3">
                <p className="text-xs text-gray-400 mb-1">Output</p>
                <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">{n.output_text}</div>
              </div>
            )}
            {n.error_message && (
              <div className="px-4 py-3 bg-red-50">
                <p className="text-xs text-red-600 font-medium">Error</p>
                <p className="text-xs text-red-500 mt-0.5">{n.error_message}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────── List Panel ───────────
function ListPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [execs, setExecs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const router = useRouter();
  const PAGE_SIZE = 20;

  async function load(p: number) {
    if (!getToken()) { router.replace('/login/'); return; }
    setLoading(true);
    try {
      const d = await apiFlows(p, PAGE_SIZE);
      setExecs(d.executions ?? []);
      setTotal(d.total ?? 0);
    } catch { router.replace('/login/'); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(page); }, [page]);

  function fmt(ts: number) { if (!ts) return '–'; return new Date(ts).toLocaleString(); }
  function dur(s: number, e: number) {
    if (!e || !s) return '–';
    const ms = e - s; return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">History</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} executions total</p>
        </div>
        <button onClick={() => load(page)} className="text-sm text-gray-600 hover:text-gray-900 border border-gray-200 px-3 py-1.5 rounded-lg">↺ Refresh</button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-16 text-sm">Loading…</div>
      ) : execs.length === 0 ? (
        <div className="text-center text-gray-400 py-16 text-sm">No executions yet. Send a message from the Chat tab.</div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['ID', 'Flow', 'Status', 'Rounds', 'Duration', 'Started'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {execs.map((e: any) => (
                  <tr key={e.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => onSelect(e.id)}>
                    <td className="px-4 py-3 font-mono text-xs text-blue-600">{e.id.slice(0, 8)}…</td>
                    <td className="px-4 py-3 text-gray-700">{e.instance_name}/{e.flow_name}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[e.status] ?? 'bg-gray-100 text-gray-600'}`}>{e.status}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{e.rounds ?? 0}</td>
                    <td className="px-4 py-3 text-gray-500">{dur(e.started_at, e.finished_at)}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{fmt(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="text-sm px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50">← Prev</button>
              <span className="text-sm text-gray-500">Page {page} / {Math.ceil(total / PAGE_SIZE)}</span>
              <button onClick={() => setPage(p => p + 1)} disabled={page * PAGE_SIZE >= total}
                className="text-sm px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50">Next →</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ─────────── Page ───────────
function HistoryPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedId = searchParams.get('id');

  function select(id: string) {
    router.push(`/history/?id=${id}`);
  }
  function back() {
    router.push('/history/');
  }

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 overflow-y-auto max-w-5xl mx-auto w-full px-4 py-6">
        {selectedId
          ? <DetailPanel id={selectedId} onBack={back} />
          : <ListPanel onSelect={select} />
        }
      </div>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<div className="flex flex-col h-screen"><Nav /><div className="text-center text-gray-400 py-16 text-sm">Loading…</div></div>}>
      <HistoryPageInner />
    </Suspense>
  );
}
