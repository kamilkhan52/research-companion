import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { PromptStatus } from '@/api/types';
import { Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

export function PromptStatusPanel({
  prompts,
  loading,
  error,
  refreshing,
  onRefresh,
}: {
  prompts: PromptStatus[] | undefined;
  loading: boolean;
  error: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <View>
      <Text variant="caption" color={colors.muted}>
        Edit these Markdown files in Obsidian. This screen is read-only and reports the exact
        server path and the version currently active in the backend.
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={refreshing}
        onPress={onRefresh}
        style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}>
        <Text variant="heading" color={colors.mint}>
          {refreshing ? 'Refreshing…' : 'Refresh prompt status'}
        </Text>
      </Pressable>

      {loading ? <ActivityIndicator testID="prompt-status-loading" color={colors.mint} /> : null}
      {error ? (
        <Text variant="caption" color={colors.danger}>
          Prompt status unavailable. Check the server connection and try again.
        </Text>
      ) : null}
      {!loading && !error && prompts?.length === 0 ? (
        <Text variant="caption" color={colors.muted}>No prompts reported by the server.</Text>
      ) : null}

      {prompts?.map((prompt) => (
        <View key={prompt.key} style={styles.row}>
          <View style={styles.header}>
            <Text variant="heading" style={styles.label}>{prompt.label}</Text>
            <Text
              variant="caption"
              color={prompt.valid ? colors.mint : colors.danger}
              accessibilityLabel={`${prompt.label}: ${prompt.valid ? 'valid' : 'invalid'}`}>
              {prompt.valid ? 'VALID' : 'INVALID'}
            </Text>
          </View>
          <Text variant="caption" color={colors.muted}>
            Active source: {prompt.source.replace(/_/g, ' ')}
          </Text>
          <Text variant="caption" selectable style={styles.path}>
            {prompt.path ?? `Bundled in server · ${prompt.relative_path}`}
          </Text>
          {prompt.error ? (
            <Text variant="caption" color={colors.danger} style={styles.error}>
              {prompt.error}
            </Text>
          ) : null}
          <Text variant="caption" color={colors.muted} style={styles.hash}>
            SHA-256 {prompt.effective_hash.slice(0, 12)}
            {prompt.modified_at ? ` · modified ${prompt.modified_at}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  refresh: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.elevated,
  },
  pressed: { opacity: 0.82 },
  row: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: space.md,
    marginTop: space.md,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  label: { flex: 1 },
  path: { marginTop: space.sm, fontSize: 11.5 },
  error: { marginTop: space.sm },
  hash: { marginTop: space.sm, fontSize: 11 },
});
