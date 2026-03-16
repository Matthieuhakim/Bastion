import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BastionApiClient } from '../api/client';
import { useAuth } from './useAuth';
import type { Agent } from '../api/types';

function useClient() {
  const { apiKey } = useAuth();
  return new BastionApiClient(apiKey!);
}

export function useAgents() {
  const client = useClient();
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => client.listAgents(),
  });
}

export function useToggleAgent() {
  const client = useClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      client.toggleAgent(id, isActive),
    onMutate: async ({ id, isActive }) => {
      await queryClient.cancelQueries({ queryKey: ['agents'] });
      const previous = queryClient.getQueryData<Agent[]>(['agents']);
      queryClient.setQueryData<Agent[]>(['agents'], (old) =>
        old?.map((a) => (a.id === id ? { ...a, isActive } : a)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['agents'], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
