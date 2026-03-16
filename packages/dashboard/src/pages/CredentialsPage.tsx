import { useState } from 'react';
import { useCredentials, useRevokeCredential } from '../hooks/useCredentials';
import { useAgents } from '../hooks/useAgents';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { Credential } from '../api/types';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

export function CredentialsPage() {
  const { data: agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('');
  const { data: credentials, isLoading } = useCredentials(agentFilter || undefined);
  const revoke = useRevokeCredential();
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const agentName = (id: string) => agents?.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  const displayHint = (cred: Credential) => {
    const hint = (cred.metadata as Record<string, unknown> | null)?._displayHint;
    return typeof hint === 'string' ? hint : '-';
  };

  const columns: Column<Credential>[] = [
    { header: 'Name', accessor: (c) => <span className="font-medium">{c.name}</span> },
    { header: 'Type', accessor: (c) => <StatusBadge variant={c.type} /> },
    {
      header: 'Hint',
      accessor: (c) => <span className="font-mono text-xs text-gray-500">{displayHint(c)}</span>,
    },
    { header: 'Agent', accessor: (c) => agentName(c.agentId) },
    {
      header: 'Scopes',
      accessor: (c) =>
        c.scopes.length > 0 ? (
          <span className="text-xs text-gray-500">{c.scopes.join(', ')}</span>
        ) : (
          <span className="text-gray-400">-</span>
        ),
    },
    {
      header: 'Expires',
      accessor: (c) =>
        c.expiresAt ? formatDate(c.expiresAt) : <span className="text-gray-400">Never</span>,
    },
    {
      header: 'Status',
      accessor: (c) => <StatusBadge variant={c.isRevoked ? 'revoked' : 'active'} />,
    },
    {
      header: '',
      accessor: (c) =>
        !c.isRevoked ? (
          <button
            onClick={() => setRevokeTarget(c.id)}
            className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            Revoke
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Credentials</h2>
        <p className="text-sm text-gray-500">
          Encrypted credentials stored in the vault. Raw values are never exposed.
        </p>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-gray-700">Filter by Agent</label>
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All agents</option>
          {agents?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        columns={columns}
        data={credentials ?? []}
        keyFn={(c) => c.id}
        loading={isLoading}
        emptyMessage="No credentials stored"
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke Credential"
        confirmLabel="Revoke"
        confirmVariant="danger"
        onConfirm={() => {
          if (revokeTarget) {
            revoke.mutate(revokeTarget, {
              onSuccess: () => setRevokeTarget(null),
            });
          }
        }}
        onCancel={() => setRevokeTarget(null)}
        loading={revoke.isPending}
      >
        <p>
          Are you sure you want to revoke this credential? This cannot be undone. Any agent using
          this credential will be denied access.
        </p>
      </ConfirmDialog>
    </div>
  );
}
