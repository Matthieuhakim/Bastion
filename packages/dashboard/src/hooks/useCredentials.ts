import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BastionApiClient } from '../api/client';
import { useAuth } from './useAuth';

function useClient() {
  const { apiKey } = useAuth();
  return new BastionApiClient(apiKey!);
}

export function useCredentials(agentId?: string) {
  const client = useClient();
  return useQuery({
    queryKey: ['credentials', agentId],
    queryFn: () => client.listCredentials(agentId),
  });
}

export function useRevokeCredential() {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.revokeCredential(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
  });
}
