'use client';

import { useState, useEffect } from 'react';

interface Flow {
  name: string;
  node_count: number;
  nodes: Array<{
    id: string;
    role_id: string;
    system_prompt: boolean;
    max_rounds: number | null;
  }>;
}

export default function FlowsPage() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchFlows = async () => {
      try {
        const response = await fetch('/admin/flows');
        if (!response.ok) {
          throw new Error('Failed to fetch flows');
        }
        const data = await response.json();
        setFlows(data.flows || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    // In a real implementation, we would fetch from the actual API
    // For now, we'll simulate the data
    setTimeout(() => {
      setFlows([
        {
          name: 'content-generation',
          node_count: 2,
          nodes: [
            { id: 'writer', role_id: 'gpt-4', system_prompt: true, max_rounds: 1 },
            { id: 'reviewer', role_id: 'claude-3', system_prompt: true, max_rounds: 1 }
          ]
        },
        {
          name: 'qa-assistant',
          node_count: 1,
          nodes: [
            { id: 'answerer', role_id: 'gpt-3.5-turbo', system_prompt: true, max_rounds: 3 }
          ]
        }
      ]);
      setLoading(false);
    }, 500);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-6">Flows</h1>
          <p>Loading flows...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-6">Flows</h1>
          <div className="bg-red-50 border border-red-200 rounded-md p-4">
            <p className="text-red-800">Error: {error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">Flows</h1>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {flows.map((flow) => (
            <div key={flow.name} className="bg-white overflow-hidden shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <h3 className="text-lg leading-6 font-medium text-gray-900">{flow.name}</h3>
                <p className="mt-2 text-sm text-gray-500">
                  {flow.node_count} node{flow.node_count !== 1 ? 's' : ''}
                </p>
                
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-gray-700">Nodes:</h4>
                  <ul className="mt-2 space-y-2">
                    {flow.nodes.map((node, idx) => (
                      <li key={idx} className="flex justify-between text-sm text-gray-600">
                        <span>{node.id}</span>
                        <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">
                          {node.role_id}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
        
        {flows.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">No flows configured yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}