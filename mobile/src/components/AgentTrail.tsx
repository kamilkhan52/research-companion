// R6.8 — what the agent did before answering. On a finished message it's a small collapsed
// row ("Researched with N tool calls · M steps") that expands to the full tool/thought list;
// while streaming, ToolLine rows and thought lines render inline via the paper screen. The
// answer itself stays the whole bubble; the trail is context, not content.

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AgentTrailItem } from '@/api/types';
import { Icon, Text, type IconName } from '@/ui';
import { colors, space } from '@/theme/tokens';

// Friendly label + icon for each research tool the agent can call (agentic path).
export const TOOL_META: Record<string, { icon: IconName; label: string }> = {
  web_search: { icon: 'search', label: 'Searching the web' },
  web_fetch: { icon: 'globe', label: 'Reading a page' },
  read_paper_text: { icon: 'file-text', label: 'Reading a paper' },
  related_papers: { icon: 'share-2', label: 'Finding related papers' },
  list_project_papers: { icon: 'book-open', label: 'Scanning the project' },
  // retrieval (/start_stream) steps
  arxiv: { icon: 'book-open', label: 'Resolving on arXiv' },
  fetch_pdf: { icon: 'download', label: 'Trying a PDF' },
};

export function ToolLine({ name, detail }: { name: string; detail: string }) {
  const meta = TOOL_META[name] ?? { icon: 'tool' as IconName, label: name };
  return (
    <View style={styles.toolRow}>
      <Icon name={meta.icon} size={13} color={colors.mint} />
      <Text variant="caption" color={colors.mint}>{meta.label}</Text>
      {detail ? (
        <Text variant="caption" color={colors.muted} numberOfLines={1} style={styles.toolDetail}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function AgentTrail({ trail }: { trail: AgentTrailItem[] }) {
  const [open, setOpen] = useState(false);
  const tools = trail.filter((t) => t.kind === 'tool').length;
  const summary = tools > 0
    ? `Researched with ${tools} tool ${tools === 1 ? 'call' : 'calls'}`
    : 'Agent activity';
  return (
    <View style={styles.agentTrail}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={styles.agentTrailHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${summary}. ${open ? 'Hide' : 'Show'} what the agent did.`}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} color={colors.muted} />
        <Text variant="caption" color={colors.muted}>
          {summary} · {trail.length} {trail.length === 1 ? 'step' : 'steps'}
        </Text>
      </Pressable>
      {open
        ? trail.map((it, i) =>
            it.kind === 'tool' ? (
              <ToolLine key={i} name={it.name} detail={it.detail} />
            ) : (
              <Text key={i} variant="caption" color={colors.muted} style={styles.thoughtLine}>
                {it.text}
              </Text>
            ),
          )
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  agentTrail: {
    marginBottom: space.sm,
    paddingVertical: 2,
    gap: 4,
  },
  agentTrailHeader: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  thoughtLine: { fontStyle: 'italic', paddingLeft: space.sm },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toolDetail: { flex: 1 },
});
