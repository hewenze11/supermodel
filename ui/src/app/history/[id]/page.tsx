'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Nav from '@/components/Nav';
import { apiFlowDetail, getToken } from '@/lib/api';
import { useRouter, useParams } from 'next/navigation';

async function cancelExecution(id: string) {
  const token = getToken();
  await fetch(`/admin/executions/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
}

export default function FlowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();

  const load = useCallback(() => {
    if (!getToken()) { router.replace('/login/'); return; }
    apiFlowDetail(id).then(d => { setDetail(d); setLoading(false); })
      .catch(() => router.replace('/login/'));
  }, [id, router]);

  useEffect(() => { load(); }, [load]);

  async function handleCancel() {
    setCancelling(true);
    await cancelExecution(id);
    setTimeout(() => { load(); setCancelling(false); }, 800);
  }

  if (loading) return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="text-center text-gray-400 py-16 text-sm">Loading…</div>
    </div>
  );

  const exec = detail?.execution;
  const nodes = detail?.node_executions ?? [];

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 overflow-y-auto max-w-4xl mx-auto w-full px-4 py-6">
        <div className="mb-4">
          <Link href="/history" className="text-sm text-gray-500 hover:text-gray-800">← History</Link>
        </div>

        {exec && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="font-bold text-gray-900">{exec.instance_name}/{exec.flow_name}</h1>
                <p className="font-mono text-xs text-gray-400 mt-0.5">{exec.id}</p>
              </div>
              <div className="flex items-center gap-2">
                {exec.status === 'running' && (
                  <button
                    onClick={handleCancel}
                    disabled={cancelling}
                    className="text-xs bg-red-600 text-white px-3 py-1 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                  exec.status === 'completed' ? 'bg-green-100 text-green-700' :
                  exec.status === 'failed' ? 'bg-red-100 text-red-700' :
                  exec.status === 'running' ? 'bg-blue-100 text-blue-700' :
                  'bg-gray-100 text-gray-600'
                }`}>{exec.status}</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
              <div><p className="text-xs text-gray-400">Rounds</p><p className="font-medium">{exec.rounds ?? 0}</p></div>
              <div><p className="text-xs text-gray-400">Finish reason</p><p className="font-medium">{exec.finish_reason ?? '–'}</p></div>
              <div>
                <p className="text-xs text-gray-400">Duration</p>
                <p className="font-medium">
                  {exec.finished_at && exec.started_at
                    ? `${((exec.finished_at - exec.started_at) / 1000).toFixed(1)}s`
                    : '–'}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-800">Node executions ({nodes.length})</h2>
          <button
            onClick={load}
            className="text-xs text-gray-400 hover:text-gray-700 border border-gray-200 px-2 py-1 rounded transition-colors"
          >
            ↺ Refresh
          </button>
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
                  {n.round !== null && n.round !== undefined &&
                    <span className="text-xs text-gray-400">round {n.round}</span>}
                </div>
                <div className="flex items-center gap-3">
                  {(n.prompt_tokens || n.completion_tokens) &&
                    <span className="text-xs text-gray-400">{n.prompt_tokens}↑ {n.completion_tokens}↓</span>}
                  {n.started_at && (
                    <span className="text-xs text-gray-400">
                      {n.finished_at ? `${((n.finished_at - n.started_at) / 1000).toFixed(1)}s` : 'running…'}
                    </span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    n.status === 'completed' ? 'bg-green-100 text-green-700' :
                    n.status === 'failed' ? 'bg-red-100 text-red-700' :
                    n.status === 'running' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>{n.status}</span>
                </div>
              </div>
              {n.output_text && (
                <div className="px-4 py-3">
                  <p className="text-xs text-gray-400 mb-1">Output</p>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                    {n.output_text}
                  </div>
                </div>
              )}
              {n.error_message && (
                <div className="px-4 py-3 bg-red-50">
                  <p className="text-xs text-red-600 font-medium mb-0.5">Error</p>
                  <p className="text-xs text-red-500">{n.error_message}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
