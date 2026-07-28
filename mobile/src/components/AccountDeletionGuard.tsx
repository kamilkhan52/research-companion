import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { getAccountDeletion, startAccountDeletion } from '@/api/endpoints';
import type { AccountDeletion } from '@/api/types';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Card, Icon, Screen, Text } from '@/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export const accountDeletionQueryKey = (userId: string | null) =>
  ['account-deletion', userId ?? 'unknown'] as const;

const COPY: Record<AccountDeletion['status'], string> = {
  pending: 'Your request is queued.',
  draining: 'Finishing active requests and background work safely.',
  deleting_data: 'Permanently removing your projects, papers, notes, and settings.',
  deleting_identity: 'Removing your sign-in identity.',
  error: 'Deletion paused before it could finish.',
  completed: 'Deletion is complete. Clearing this device…',
};

/**
 * Checks the deletion tombstone before mounting any ordinary API consumer. This makes a deletion
 * resumable after an app restart: the backend blocks all other routes once deletion starts, while
 * this one polling route remains available until the local session is cleared.
 */
export function AccountDeletionGuard({ children }: { children: ReactNode }) {
  const t = useTheme();
  const queryClient = useQueryClient();
  const { userId, finishAccountDeletion } = useAuth();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const finishing = useRef(false);
  const queryKey = accountDeletionQueryKey(userId);
  const query = useQuery({
    queryKey,
    queryFn: getAccountDeletion,
    enabled: Boolean(userId),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: ({ state }) => {
      const status = state.data?.deletion?.status;
      if (!status) return 30_000;
      return status !== 'completed' && status !== 'error' ? 1000 : false;
    },
  });
  const deletion = query.data?.deletion ?? null;

  useEffect(() => {
    if (deletion?.status !== 'completed' || finishing.current) return;
    finishing.current = true;
    void finishAccountDeletion();
  }, [deletion?.status, finishAccountDeletion]);

  async function retryDeletion() {
    setRetrying(true);
    setRetryError(null);
    try {
      // The initial request required a freshly minted JWT. Once the server has a durable
      // tombstone, retry is already authorized and must also work when Auth identity deletion
      // succeeded but its response was lost—at which point refresh is impossible.
      const next = await startAccountDeletion();
      queryClient.setQueryData(queryKey, next);
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : 'Could not retry deletion.');
    } finally {
      setRetrying(false);
    }
  }

  if (!userId || query.isPending || (query.isFetching && !deletion)) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={t.mint} />
        </View>
      </Screen>
    );
  }

  if (query.isError) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', padding: space.xl }}>
          <Card>
            <Icon name="wifi-off" size={24} color={t.danger} />
            <Text variant="title" style={{ marginTop: space.md }}>
              Couldn’t check your account
            </Text>
            <Text color={t.muted} style={{ marginTop: space.sm, marginBottom: space.lg }}>
              The server must confirm no deletion is already running before your research can load.
            </Text>
            <Button title="Try again" onPress={() => { void query.refetch(); }} />
          </Card>
        </View>
      </Screen>
    );
  }

  if (!deletion) return <>{children}</>;

  const failed = deletion.status === 'error';
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', padding: space.xl }}>
        <Card>
          {failed ? (
            <Icon name="alert-circle" size={28} color={t.danger} />
          ) : (
            <ActivityIndicator color={t.mint} />
          )}
          <Text variant="title" style={{ marginTop: space.lg }}>
            {failed ? 'Account deletion paused' : 'Deleting your account'}
          </Text>
          <Text color={t.muted} style={{ marginTop: space.sm }}>
            {COPY[deletion.status]}
          </Text>
          {!failed ? (
            <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
              Keep the app open if you can. You may also close it and return later—deletion
              continues safely on the server.
            </Text>
          ) : (
            <>
              <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
                No deleted data is restored. Retrying resumes from the last durable step.
              </Text>
              {retryError ? (
                <Text variant="caption" color={t.danger} style={{ marginTop: space.md }}>
                  {retryError}
                </Text>
              ) : null}
              <Button
                title="Retry deletion"
                variant="danger"
                loading={retrying}
                onPress={() => { void retryDeletion(); }}
                style={{ marginTop: space.lg }}
              />
            </>
          )}
        </Card>
      </View>
    </Screen>
  );
}
