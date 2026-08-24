// R6.8 — what the agent did before answering. On a finished message it's a small collapsed
// row ("Researched with N tool calls · M steps") that expands to the full tool/thought list;
// while streaming, ToolLine rows and thought lines render inline via the paper screen. The
// answer itself stays the whole bubble; the trail is context, not content.

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import type { AgentTrailItem } from '@/api/types';
import { Icon, Text, type IconName } from '@/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

// Friendly label + icon for each research tool the agent can call (agentic path).
export const TOOL_META: Record<string, { icon: IconName; label: string }> = {
  web_search: { icon: 'search', label: 'Searching the web' },
  web_fetch: { icon: 'globe', label: 'Reading a page' },
  read_paper_text: { icon: 'file-text', label: 'Reading a paper' },
  related_papers: { icon: 'share-2', label: 'Finding related papers' },
  list_project_papers: { icon: 'book-open', label: 'Scanning the project' },
  // retrieval-job steps
  arxiv: { icon: 'book-open', label: 'Resolving on arXiv' },
  fetch_pdf: { icon: 'download', label: 'Trying a PDF' },
  // DR-043's in-conversation tool — also rendered as an always-visible action row below,
  // since a job started this way (unlike the menu button) never navigates the reader to it.
  propose_notes_update: { icon: 'edit-3', label: 'Drafting a notes update' },
};

// The one tool name that starts something the reader needs a way BACK to (DR-043 reopened,
// 2026-08-11): the menu's "Update notes from discussion" starts the same server job and
// immediately navigates to the notes screen, but the agent calling this tool mid-conversation
// has no client-side hook to do that — the reader was told "it will appear for your review
// shortly" with nothing to tap. The notes screen already resumes whatever job is latest for
// this paper regardless of what started it, so a plain link there is a complete fix, not a
// workaround.
const NOTES_UPDATE_TOOL = 'propose_notes_update';

export function ToolLine({ name, detail }: { name: string; detail: string }) {
  const t = useTheme();
  const meta = TOOL_META[name] ?? { icon: 'tool' as IconName, label: name };
  return (
    <View style={styles.toolRow}>
      <Icon name={meta.icon} size={13} color={t.mint} />
      <Text variant="caption" color={t.mint}>{meta.label}</Text>
      {detail ? (
        <Text variant="caption" color={t.muted} numberOfLines={1} style={styles.toolDetail}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/** Did this turn start a notes update? The link that answers it lives BELOW the answer (DR-105),
 *  so the paper screen asks separately rather than the trail rendering it. */
export function startedNotesUpdate(items: { kind: string; name?: string }[]): boolean {
  return items.some((it) => it.kind === 'tool' && it.name === NOTES_UPDATE_TOOL);
}

/** The way back to a notes proposal the agent started mid-conversation.
 *
 * DR-105 (Kamil): "the notification to open it is at the top of the response, but I'm likely
 * looking at the bottom of the response." It used to render inside the agent trail, which sits
 * above the answer — on a long analysis that is several screens away from where the reader
 * finishes. It is now rendered after the message body by whoever owns the message.
 */
export function NotesUpdateLink({ slug, live = false }: { slug: string; live?: boolean }) {
  const t = useTheme();
  const router = useRouter();
  // Tense-neutral for a finished turn (Opus review, PR #371): a persisted trail carries no live
  // job status, so it renders identically for a turn from seconds ago and one from last week
  // whose proposal was reviewed and applied days ago. `live` is only set from the turn that is
  // streaming right now, where "preparing" is a fact rather than a claim.
  const label = live
    ? 'Preparing a notes update from this discussion — open notes'
    : 'Notes update requested from this discussion — open notes';
  return (
    <Pressable
      testID="notes-update-link"
      onPress={() => router.push(`/notes/${encodeURIComponent(slug)}`)}
      style={[styles.notesUpdateRow, { borderColor: t.mint }]}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Tap to open notes.`}
    >
      <Icon name="edit-3" size={13} color={t.mint} />
      <Text variant="caption" color={t.mint} style={styles.notesUpdateText}>{label}</Text>
      <Icon name="chevron-right" size={13} color={t.mint} />
    </Pressable>
  );
}

export function AgentTrail({ trail }: { trail: AgentTrailItem[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const tools = trail.filter((item) => item.kind === 'tool').length;
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
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} color={t.muted} />
        <Text variant="caption" color={t.muted}>
          {summary} · {trail.length} {trail.length === 1 ? 'step' : 'steps'}
        </Text>
      </Pressable>
      {open
        ? trail.map((it, i) =>
            it.kind === 'tool' ? (
              <ToolLine key={i} name={it.name} detail={it.detail} />
            ) : (
              <Text key={i} variant="caption" color={t.muted} style={styles.thoughtLine}>
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
  notesUpdateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: 4,
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    borderWidth: 1,
    borderRadius: 8,
  },
  notesUpdateText: { flex: 1 },
});
