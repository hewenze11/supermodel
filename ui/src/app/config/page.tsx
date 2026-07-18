'use client';

import { useState, useEffect } from 'react';

export default function ConfigPage() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        // In a real implementation, we would fetch from the actual API
        // For demo purposes, we'll simulate the data
        setTimeout(() => {
          setConfig({
            instances: [
              {
                instance_name: 'primary-models',
                primary: true,
                roles: [
                  { id: 'gpt-4', provider_type: 'openai', model: 'gpt-4' },
                  { id: 'claude-3', provider_type: 'anthropic', model: 'claude-3-opus-20240229' }
                ],
                flows: [
                  { name: 'content-generation', nodes: 2 },
                  { name: 'qa-assistant', nodes: 1 }
                ]
              }
            ]
          });
          setLoading(false);
        }, 500);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    fetchConfig();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-6">Configuration</h1>
          <p>Loading configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">Configuration</h1>
        
        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-md p-4">
            <p className="text-red-800">Error: {error}</p>
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-semibold text-gray-800 mb-4">Instances</h2>
            
            {config?.instances.map((instance: any, idx: number) => (
              <div key={idx} className="bg-white shadow overflow-hidden sm:rounded-lg mb-6">
                <div className="px-4 py-5 sm:px-6">
                  <div className="flex justify-between items-center">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">
                      {instance.instance_name}
                      {instance.primary && (
                        <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          Primary
                        </span>
                      )}
                    </h3>
                  </div>
                </div>
                <div className="border-t border-gray-200">
                  <dl>
                    <div className="bg-gray-50 px-4 py-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
                      <dt className="text-sm font-medium text-gray-500">Roles</dt>
                      <dd className="mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2">
                        <ul className="space-y-2">
                          {instance.roles.map((role: any, roleIdx: number) => (
                            <li key={roleIdx} className="flex items-center">
                              <span className="font-mono bg-gray-100 px-2 py-1 rounded mr-2">{role.id}</span>
                              <span className="text-gray-600">({role.provider_type}) {role.model}</span>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                    <div className="bg-white px-4 py-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
                      <dt className="text-sm font-medium text-gray-500">Flows</dt>
                      <dd className="mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2">
                        <ul className="space-y-1">
                          {instance.flows.map((flow: any, flowIdx: number) => (
                            <li key={flowIdx} className="flex items-center">
                              <span className="font-medium">{flow.name}</span>
                              <span className="ml-2 text-gray-500">({flow.nodes} nodes)</span>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}