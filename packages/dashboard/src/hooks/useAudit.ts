import { useQuery } from '@tanstack/react-query';
import { BastionApiClient } from '../api/client';
import { useAuth } from './useAuth';
import type { AuditQueryParams } from '../api/types';

function useClient() {
  const { apiKey } = useAuth();
  return new BastionApiClient(apiKey!);
}

export function useAuditRecords(params: AuditQueryParams | null) {
  const client = useClient();
  return useQuery({
    queryKey: ['audit', params],
    queryFn: () => client.queryAudit(params!),
    enabled: params !== null,
  });
}

export function useVerifyChain(agentId: string | null) {
  const client = useClient();
  return useQuery({
    queryKey: ['audit', 'verify', agentId],
    queryFn: () => client.verifyChain(agentId!),
    enabled: false, // only runs on manual refetch
  });
}
