import { useState } from 'react';
import { useAuditRecords, useVerifyChain } from '../hooks/useAudit';
import { useAgents } from '../hooks/useAgents';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import type { AuditRecord, AuditQueryParams } from '../api/types';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

type Decision = 'ALLOW' | 'DENY' | 'ESCALATE';

export function AuditPage() {
  const { data: agents } = useAgents();
  const [agentId, setAgentId] = useState('');
  const [action, setAction] = useState('');
  const [decision, setDecision] = useState<Decision | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();

  const params: AuditQueryParams | null = agentId
    ? {
        agentId,
        action: action || undefined,
        policyDecision: (decision as Decision) || undefined,
        from: from || undefined,
        to: to || undefined,
        cursor,
        limit: 50,
      }
    : null;

  const { data, isLoading } = useAuditRecords(params);
  const verify = useVerifyChain(agentId || null);

  const columns: Column<AuditRecord>[] = [
    { header: 'Time', accessor: (r) => formatDate(r.recordJson.timestamp) },
    {
      header: 'Action',
      accessor: (r) => <span className="font-mono text-xs">{r.recordJson.action}</span>,
    },
    {
      header: 'Decision',
      accessor: (r) => <StatusBadge variant={r.recordJson.policyDecision} />,
    },
    {
      header: 'Target',
      accessor: (r) => (
        <span className="text-xs text-gray-500">
          {r.recordJson.targetMethod} {r.recordJson.targetUrl}
        </span>
      ),
    },
    {
      header: 'Amount',
      accessor: (r) =>
        r.recordJson.params?.amount != null ? (
          <span className="font-mono">${r.recordJson.params.amount.toLocaleString()}</span>
        ) : (
          <span className="text-gray-400">-</span>
        ),
    },
    {
      header: 'Outcome',
      accessor: (r) => <span className="text-xs text-gray-500">{r.recordJson.outcome ?? '-'}</span>,
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Audit Log</h2>
        <p className="text-sm text-gray-500">
          Cryptographically signed, tamper-evident audit records.
        </p>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Agent</label>
          <select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setCursor(undefined);
            }}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Select agent...</option>
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Action</label>
          <input
            type="text"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setCursor(undefined);
            }}
            placeholder="e.g. charges.create"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Decision</label>
          <select
            value={decision}
            onChange={(e) => {
              setDecision(e.target.value as Decision | '');
              setCursor(undefined);
            }}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All</option>
            <option value="ALLOW">ALLOW</option>
            <option value="DENY">DENY</option>
            <option value="ESCALATE">ESCALATE</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">From</label>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setCursor(undefined);
            }}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">To</label>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setCursor(undefined);
            }}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        {agentId && (
          <button
            onClick={() => verify.refetch()}
            disabled={verify.isFetching}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {verify.isFetching ? 'Verifying...' : 'Verify Chain'}
          </button>
        )}
      </div>

      {/* Verification result */}
      {verify.data && (
        <div
          className={`mb-4 rounded-md border p-3 text-sm ${
            verify.data.valid
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {verify.data.valid
            ? `Chain verified: ${verify.data.recordCount} records, integrity intact.`
            : `Chain broken at record ${verify.data.brokenAt}: ${verify.data.reason}`}
        </div>
      )}

      {!agentId ? (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
          Select an agent to view audit records.
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={data?.records ?? []}
            keyFn={(r) => r.id}
            loading={isLoading}
            emptyMessage="No audit records found"
          />
          {data?.nextCursor && (
            <div className="mt-4 text-center">
              <button
                onClick={() => setCursor(data.nextCursor!)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Load More
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
