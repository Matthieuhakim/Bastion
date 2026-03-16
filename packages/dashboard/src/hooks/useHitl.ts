import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BastionApiClient } from '../api/client';
import { useAuth } from './useAuth';

function useClient() {
  const { apiKey } = useAuth();
  return new BastionApiClient(apiKey!);
}

export function usePendingRequests() {
  const client = useClient();
  return useQuery({
    queryKey: ['hitl', 'pending'],
    queryFn: () => client.listPending(),
    refetchInterval: 5000,
  });
}

export function useApprove() {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => client.approve(requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hitl', 'pending'] });
    },
  });
}

export function useDeny() {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, reason }: { requestId: string; reason?: string }) =>
      client.deny(requestId, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hitl', 'pending'] });
    },
  });
}
