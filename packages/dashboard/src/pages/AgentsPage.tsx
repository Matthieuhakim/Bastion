import { useAgents, useToggleAgent } from '../hooks/useAgents';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import type { Agent } from '../api/types';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function AgentsPage() {
  const { data: agents, isLoading } = useAgents();
  const toggleAgent = useToggleAgent();

  const columns: Column<Agent>[] = [
    { header: 'Name', accessor: (a) => <span className="font-medium">{a.name}</span> },
    {
      header: 'Status',
      accessor: (a) => <StatusBadge variant={a.isActive ? 'active' : 'inactive'} />,
    },
    {
      header: 'Key Fingerprint',
      accessor: (a) => (
        <span className="font-mono text-xs text-gray-500">{a.keyFingerprint.slice(0, 16)}...</span>
      ),
    },
    {
      header: 'Callback URL',
      accessor: (a) => <span className="text-xs text-gray-500">{a.callbackUrl ?? '-'}</span>,
    },
    { header: 'Created', accessor: (a) => formatDate(a.createdAt) },
    {
      header: 'Kill Switch',
      accessor: (a) => (
        <button
          onClick={() => toggleAgent.mutate({ id: a.id, isActive: !a.isActive })}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
            a.isActive ? 'bg-green-500' : 'bg-gray-300'
          }`}
          role="switch"
          aria-checked={a.isActive}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition duration-200 ${
              a.isActive ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Agents</h2>
        <p className="text-sm text-gray-500">
          Manage registered agents. Toggle the kill switch to deactivate an agent immediately.
        </p>
      </div>
      <DataTable
        columns={columns}
        data={agents ?? []}
        keyFn={(a) => a.id}
        loading={isLoading}
        emptyMessage="No agents registered"
      />
    </div>
  );
}
