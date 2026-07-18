'use client';
import { useState, useEffect } from 'react';
import Nav from '@/components/Nav';
import { apiStatus, apiReload, getToken } from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function ModelsPage() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [reloadMsg, setReloadMsg] = useState('');
  const router = useRouter();

  async function load() {
    if (!getToken()) { router.replace('/login/'); return; }
    try {
      const d = await apiStatus();
      setStatus(d);
    } catch {
      router.replace('/login/');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleReload() {
    setReloading(true);
    setReloadMsg('');
    try {
      const d = await apiReload();
      setReloadMsg(d.message ?? 'Reloaded');
      await load();
    } catch (e: any) {
      setReloadMsg('Reload failed: ' + e.message);
    } finally {
      setReloading(false);
    }
  }

  const instances = status?.instances ?? {};

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 overflow-y-auto max-w-4xl mx-auto w-full px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Models</h1>
            <p className="text-sm text-gray-500 mt-0.5">Loaded instances and their flows</p>
          </div>
          <div className="flex items-center gap-3">
            {reloadMsg && <span className="text-xs text-green-700 bg-green-50 px-2 py-1 rounded">{reloadMsg}</span>}
            <button
              onClick={handleReload}
              disabled={reloading}
              className="text-sm bg-gray-900 text-white px-4 py-1.5 rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              {reloading ? 'Reloading…' : '↺ Reload config'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center text-gray-400 py-16 text-sm">Loading…</div>
        ) : Object.keys(instances).length === 0 ? (
          <div className="text-center text-gray-400 py-16 text-sm">
            No instances loaded. Add configs to ~/.supermodel/models/ and reload.
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(instances).map(([instName, inst]: any) => (
              <div key={instName} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
                  <h2 className="font-semibold text-gray-900">{instName}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {Object.keys(inst.roles ?? {}).length} roles · {Object.keys(inst.flows ?? {}).length} flows
                    {inst.tools && Object.keys(inst.tools).length > 0 &&
                      ` · ${Object.keys(inst.tools).length} tools`}
                  </p>
                </div>

                <div className="divide-y divide-gray-100">
                  {Object.entries(inst.flows ?? {}).map(([flowName, flow]: any) => (
                    <div key={flowName} className="px-5 py-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-sm text-gray-800">{flowName}</span>
                        <span className="font-mono text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                          {instName}/{flowName}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {(flow.nodes ?? []).map((node: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-xs text-gray-500">
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              node.type === 'serial' ? 'bg-blue-400' :
                              node.type === 'parallel' ? 'bg-purple-400' :
                              'bg-orange-400'
                            }`} />
                            <span className="font-mono text-gray-700">{node.id}</span>
                            <span className="text-gray-400">{node.type}</span>
                            {node.role_id && <span>→ {node.role_id}</span>}
                            {node.roles && <span>→ [{node.roles.join(', ')}]</span>}
                            {node.tools && node.tools.length > 0 &&
                              <span className="text-orange-600">🔧 {node.tools.join(', ')}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Roles */}
                {inst.roles && Object.keys(inst.roles).length > 0 && (
                  <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
                    <p className="text-xs font-medium text-gray-500 mb-2">Roles</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(inst.roles).map(([roleId, role]: any) => (
                        <div key={roleId} className="text-xs bg-white border border-gray-200 rounded-lg px-2.5 py-1.5">
                          <span className="font-medium text-gray-800">{roleId}</span>
                          {role.primary && <span className="ml-1 text-blue-600">★</span>}
                          <span className="text-gray-400 ml-1.5">{role.provider_model}</span>
                          {role.api_key_hint && (
                            <span className="text-gray-300 font-mono ml-1.5">{role.api_key_hint}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
