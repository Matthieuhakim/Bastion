import { useState } from 'react';
import { usePendingRequests, useApprove, useDeny } from '../hooks/useHitl';
import { useAgents } from '../hooks/useAgents';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { HitlRequest } from '../api/types';

const timeAgo = (iso: string) => {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};

export function HitlPage() {
  const { data: pending, isLoading } = usePendingRequests();
  const { data: agents } = useAgents();
  const approve = useApprove();
  const deny = useDeny();

  const [denyTarget, setDenyTarget] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');

  const agentName = (id: string) => agents?.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  const handleDeny = () => {
    if (!denyTarget) return;
    deny.mutate(
      { requestId: denyTarget, reason: denyReason || undefined },
      {
        onSuccess: () => {
          setDenyTarget(null);
          setDenyReason('');
        },
      },
    );
  };

  const columns: Column<HitlRequest>[] = [
    {
      header: 'Agent',
      accessor: (r) => <span className="font-medium">{agentName(r.agentId)}</span>,
    },
    { header: 'Action', accessor: (r) => <span className="font-mono text-xs">{r.action}</span> },
    {
      header: 'Target',
      accessor: (r) => (
        <span className="text-xs text-gray-500">
          {r.target.method} {r.target.url}
        </span>
      ),
    },
    {
      header: 'Amount',
      accessor: (r) =>
        r.params?.amount != null ? (
          <span className="font-mono">${r.params.amount.toLocaleString()}</span>
        ) : (
          <span className="text-gray-400">-</span>
        ),
    },
    {
      header: 'Reason',
      accessor: (r) => <span className="text-xs text-gray-600">{r.reason}</span>,
    },
    { header: 'Pending', accessor: (r) => timeAgo(r.createdAt) },
    {
      header: 'Actions',
      accessor: (r) => (
        <div className="flex gap-2">
          <button
            onClick={() => approve.mutate(r.requestId)}
            disabled={approve.isPending}
            className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => setDenyTarget(r.requestId)}
            className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            Deny
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">HITL Queue</h2>
          <p className="text-sm text-gray-500">
            Requests awaiting human approval. Auto-refreshes every 5 seconds.
          </p>
        </div>
        {pending && pending.length > 0 && (
          <StatusBadge variant="pending" label={`${pending.length} pending`} />
        )}
      </div>
      <DataTable
        columns={columns}
        data={pending ?? []}
        keyFn={(r) => r.requestId}
        loading={isLoading}
        emptyMessage="No pending requests"
      />
      <ConfirmDialog
        open={denyTarget !== null}
        title="Deny Request"
        confirmLabel="Deny"
        confirmVariant="danger"
        onConfirm={handleDeny}
        onCancel={() => {
          setDenyTarget(null);
          setDenyReason('');
        }}
        loading={deny.isPending}
      >
        <div className="space-y-3">
          <p>Are you sure you want to deny this request?</p>
          <input
            type="text"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            placeholder="Optional reason for denial"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
