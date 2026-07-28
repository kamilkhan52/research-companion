import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { ApiError } from '@/api/client';
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
  const { userId, finishAccountDeletion, signOut } = useAuth();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const finishing = useRef(false);
  const queryKey = accountDeletionQueryKey(userId);
  const query = useQuery({
    queryKey,
    queryFn: getAccountDeletion,
    enabled: Boolean(userId),
    // Retries left at the client default (2, with backoff). `retry: false` turned a single
    // dropped packet on the 30s poll into a terminal error for the whole app — see the render
    // guards below, which now also refuse to act on a failure while a known-good answer is held.
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
      // Once the server has a durable tombstone, retry is already authorized and must also work
      // when Auth identity deletion succeeded but its response was lost.
      const next = await startAccountDeletion();
      // request() returns the durable row it read BEFORE starting the worker. For a retry that can
      // still say "error", which would disable the interval below and strand the client on stale
      // failure UI while deletion succeeds. POST acceptance means the worker is queued, so adopt a
      // pending projection until the next authoritative poll observes draining/error/completion.
      queryClient.setQueryData(queryKey, {
        ...next,
        deletion: next.deletion?.status === 'error'
          ? { ...next.deletion, status: 'pending', error_code: null }
          : next.deletion,
      });
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : 'Could not retry deletion.');
    } finally {
      setRetrying(false);
    }
  }

  // FIRST load only. `query.isFetching && !deletion` also matched every BACKGROUND poll — and
  // since `refetchInterval` returns 30s whenever there is no deletion, that is every signed-in
  // user, every 30 seconds, forever. Returning a different element unmounts `children`, and
  // everything under `AuthGate` is provider state: the router stack resets to the root route,
  // open sheets and composer drafts are destroyed, and `AudioProvider`'s mount effect pauses
  // playback. `isPending` is false once any answer is held, so a revalidation now happens behind
  // the app rather than in front of it.
  if (!userId || query.isPending) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={t.mint} />
        </View>
      </Screen>
    );
  }

  // 403 is not a failure to reach the server — it is the server saying this account may not use
  // this instance (`RC_ALLOWED_USERS`). Reported as a network problem it is actively misleading:
  // the card below offers "Try again", which can never succeed, and the user is stuck with no way
  // out and no way to reach Settings. Found on a real device pass, and it will recur for every one
  // of M2.5's twelve testers, because each has to be allowlisted by hand before they can sign in.
  //
  // Sign out is the one action that helps: it returns to the welcome screen, from which another
  // account — or another server — is reachable.
  if (query.error instanceof ApiError && query.error.status === 403) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', padding: space.xl }}>
          <Card>
            <Icon name="lock" size={24} color={t.danger} />
            <Text variant="title" style={{ marginTop: space.md }}>
              This account doesn’t have access
            </Text>
            <Text color={t.muted} style={{ marginTop: space.sm, marginBottom: space.lg }}>
              You’re signed in, but this server hasn’t granted this account access yet. Ask the
              person who runs it to add you, or sign in with a different account.
            </Text>
            <Button title="Sign out" onPress={() => { void signOut(); }} />
          </Card>
        </View>
      </Screen>
    );
  }

  // Only when there is NO answer to fall back on. Refusing to mount until the server has confirmed
  // no deletion is running is a deliberate fail-closed choice on first load, and the copy below
  // says so. Applying it to a later poll is not the same thing: the guard is holding a successful
  // answer from seconds ago, the backend 423s every other route the moment a tombstone exists, and
  // tearing the app down instead means one blip on a train ends the session.
  if (query.isError && !query.data) {
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
