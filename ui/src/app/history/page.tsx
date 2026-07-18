'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Nav from '@/components/Nav';
import { apiFlows, getToken } from '@/lib/api';
import { useRouter } from 'next/navigation';

const STATUS_COLOR: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  running: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-gray-100 text-gray-600',
  aborted: 'bg-gray-100 text-gray-600',
  timeout: 'bg-yellow-100 text-yellow-700',
};

export default function HistoryPage() {
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
    } catch {
      router.replace('/login/');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(page); }, [page]);

  function fmt(ts: number) {
    if (!ts) return '–';
    return new Date(ts).toLocaleString();
  }
  function dur(start: number, end: number) {
    if (!end || !start) return '–';
    const ms = end - start;
    return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 overflow-y-auto max-w-5xl mx-auto w-full px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900">History</h1>
            <p className="text-sm text-gray-500 mt-0.5">{total} executions total</p>
          </div>
          <button
            onClick={() => load(page)}
            className="text-sm text-gray-600 hover:text-gray-900 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors"
          >
            ↺ Refresh
          </button>
        </div>

        {loading ? (
          <div className="text-center text-gray-400 py-16 text-sm">Loading…</div>
        ) : execs.length === 0 ? (
          <div className="text-center text-gray-400 py-16 text-sm">
            No executions yet. Send a message from the Chat tab.
          </div>
        ) : (
          <>
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">ID</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Flow</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Rounds</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Duration</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {execs.map((e: any) => (
                    <tr key={e.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <Link
                          href={`/history/${e.id}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {e.id.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{e.instance_name}/{e.flow_name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[e.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {e.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{e.rounds ?? 0}</td>
                      <td className="px-4 py-3 text-gray-500">{dur(e.created_at, e.finished_at)}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{fmt(e.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="text-sm px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  ← Prev
                </button>
                <span className="text-sm text-gray-500">Page {page} / {Math.ceil(total / PAGE_SIZE)}</span>
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={page * PAGE_SIZE >= total}
                  className="text-sm px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
