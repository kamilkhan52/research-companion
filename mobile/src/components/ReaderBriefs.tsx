// DR-140 — reading assistants for the project papers a response cited without anyone here
// having read them. Three surfaces, in the order the reader meets them:
//
//   ReaderOfferCard    — "the agent described these from their abstracts alone; read them in
//                        full?" with a check mark per paper (Kamil's design), in the chat footer
//                        under the response that earned it.
//   ReaderProgressCard — the same card while the pass runs: one status row per paper, then the
//                        hand-off to the agent's follow-up turn, which streams as a normal turn.
//   ReaderBriefsTrail  — on the follow-up response, the briefs it was written from: collapsed
//                        by default (one quiet row, like the agent trail), each brief expanding
//                        to its markdown. Context, not content — the answer stays the bubble.

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { ReaderBrief, ReaderCandidate, ReaderJob, ReaderTargetStatus } from '@/api/types';
import { Markdown } from '@/components/Markdown';
import { Button, Icon, Text, ToneSurface, type IconName } from '@/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

function yearSuffix(year: number | null | undefined): string {
  return year ? ` (${year})` : '';
}

export function ReaderOfferCard({
  candidates,
  selected,
  onToggle,
  onStart,
  onDismiss,
  starting,
  error,
}: {
  candidates: ReaderCandidate[];
  /** Slugs currently checked. Papers without cached text are never selectable. */
  selected: ReadonlySet<string>;
  onToggle: (slug: string) => void;
  onStart: () => void;
  onDismiss: () => void;
  starting: boolean;
  /** A start that failed for a non-spend reason (spend refusals open their own sheet). */
  error?: string | null;
}) {
  const t = useTheme();
  const readable = candidates.filter((c) => c.has_text);
  const count = readable.filter((c) => selected.has(c.slug)).length;
  return (
    <ToneSurface tone="mint" style={styles.card} testID="reader-offer">
      <View style={styles.headerRow}>
        <Icon name="users" size={15} color={t.mint} />
        <Text variant="heading" style={styles.headerText}>
          Read the papers this response cites but nobody here has read?
        </Text>
      </View>
      <Text variant="caption" color={t.muted}>
        The agent described {candidates.length === 1 ? 'this paper' : `these ${candidates.length} papers`} from
        {candidates.length === 1 ? ' its abstract' : ' their abstracts'} alone. A reading assistant can read
        each one in full against this response, and the agent will then revise what it said about them.
      </Text>
      <View style={styles.list}>
        {candidates.map((c) => {
          const checked = c.has_text && selected.has(c.slug);
          const label = `${c.title}${yearSuffix(c.year)}`;
          return (
            <Pressable
              key={c.slug}
              onPress={() => onToggle(c.slug)}
              disabled={!c.has_text || starting}
              style={[styles.row, !c.has_text && styles.rowDisabled]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled: !c.has_text }}
              accessibilityLabel={c.has_text ? label : `${label}. Not fetched yet; open it once to fetch its text.`}
              testID={`reader-candidate-${c.slug}`}
            >
              <Icon
                name={checked ? 'check-square' : 'square'}
                size={18}
                color={checked ? t.mint : t.muted}
              />
              <View style={styles.rowText}>
                <Text variant="body" numberOfLines={2}>{label}</Text>
                {!c.has_text ? (
                  <Text variant="caption" color={t.muted}>Not fetched yet — open it once to fetch its text</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text variant="caption" color={t.danger}>{error}</Text>
      ) : null}
      <View style={styles.actions}>
        <Button title="Not now" variant="ghost" onPress={onDismiss} disabled={starting} />
        <Button
          title={count === 1 ? 'Read 1 paper' : `Read ${count} papers`}
          onPress={onStart}
          disabled={count === 0}
          loading={starting}
          icon="book-open"
          testID="reader-start"
        />
      </View>
    </ToneSurface>
  );
}

const STATUS_META: Record<ReaderTargetStatus, { icon: IconName; label: string }> = {
  queued: { icon: 'circle', label: 'Waiting' },
  reading: { icon: 'loader', label: 'Reading' },
  done: { icon: 'check', label: 'Read' },
  error: { icon: 'x', label: 'Failed' },
  skipped: { icon: 'minus', label: 'Skipped' },
};

/** The one-line account of where the pass is, used as the card's title. */
export function readerProgressTitle(job: ReaderJob): string {
  const total = job.targets.length;
  const done = job.targets.filter((r) => r.status === 'done').length;
  const noun = total === 1 ? 'paper' : 'papers';
  if (job.status === 'running') {
    return `Reading ${total} ${noun}… ${done} of ${total} read`;
  }
  if (job.status === 'cancelled') return `Stopped after ${done} of ${total} ${noun}`;
  if (job.status === 'error') return `Could not read the ${noun}`;
  return done === total ? `Read ${total} ${noun}` : `Read ${done} of ${total} ${noun}`;
}

/** What happens next, once the assistants are finished. */
export function readerHandoffLine(job: ReaderJob): string | null {
  if (job.status === 'running') {
    // A reply sent while the assistants read is being answered first; the briefs follow it.
    return job.waiting ? 'Waiting for the current response to finish before handing over the briefs.' : null;
  }
  if (job.analysis_job_id) return 'Handing the briefs to the agent — its revised account is on its way.';
  if (job.status === 'error') return job.error;
  if (job.analysis_error) return `The briefs were recorded but the follow-up did not start: ${job.analysis_error}`;
  if (job.stopped_reason) return job.stopped_reason;
  return null;
}

export function ReaderProgressCard({
  job,
  onCancel,
  onDismiss,
}: {
  job: ReaderJob;
  /** Stop after the paper being read now (running only). */
  onCancel?: () => void;
  /** Clear a finished card the reader has seen (terminal only). */
  onDismiss?: () => void;
}) {
  const t = useTheme();
  const running = job.status === 'running';
  const handoff = readerHandoffLine(job);
  const tone = job.status === 'error' ? 'danger' : 'mint';
  return (
    <ToneSurface tone={tone} style={styles.card} testID="reader-progress">
      <View style={styles.headerRow}>
        {running ? (
          <ActivityIndicator size="small" color={t.mint} />
        ) : (
          <Icon name={job.status === 'error' ? 'alert-circle' : 'users'} size={15} color={job.status === 'error' ? t.danger : t.mint} />
        )}
        <Text variant="heading" style={styles.headerText}>{readerProgressTitle(job)}</Text>
      </View>
      <View style={styles.list}>
        {job.targets.map((row) => {
          const meta = STATUS_META[row.status];
          const color = row.status === 'done' ? t.mint : row.status === 'error' ? t.danger : t.muted;
          return (
            <View key={row.slug} style={styles.row} accessibilityLabel={`${row.title}: ${meta.label}`}>
              {row.status === 'reading' ? (
                <ActivityIndicator size="small" color={t.mint} />
              ) : (
                <Icon name={meta.icon} size={16} color={color} />
              )}
              <View style={styles.rowText}>
                <Text variant="body" numberOfLines={2}>{row.title}</Text>
                <Text variant="caption" color={color}>
                  {meta.label}{row.error ? ` — ${row.error}` : ''}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      {handoff ? (
        <Text variant="caption" color={job.status === 'error' ? t.danger : t.muted}>{handoff}</Text>
      ) : null}
      {/* Paid briefs that never reached the agent (the follow-up did not start, or a wait
          timed out) stay readable here rather than vanishing with the card. */}
      {!running && !job.analysis_job_id && job.briefs.length > 0 ? (
        <ReaderBriefsTrail briefs={job.briefs} />
      ) : null}
      {running && onCancel ? (
        <View style={styles.actions}>
          <Button title="Stop after this paper" variant="ghost" onPress={onCancel} />
        </View>
      ) : null}
      {!running && !job.analysis_job_id && onDismiss ? (
        <View style={styles.actions}>
          <Button title="Dismiss" variant="ghost" onPress={onDismiss} />
        </View>
      ) : null}
    </ToneSurface>
  );
}

function BriefItem({ brief, textScale }: { brief: ReaderBrief; textScale?: number }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.brief}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={styles.briefHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Brief on ${brief.title}. ${open ? 'Hide' : 'Show'} it.`}
        testID={`reader-brief-${brief.slug}`}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} color={t.muted} />
        <Icon name="file-text" size={13} color={t.mint} />
        <Text variant="caption" color={t.text} numberOfLines={open ? undefined : 1} style={styles.briefTitle}>
          {brief.title}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.briefBody}>
          <Markdown text={brief.text} textScale={textScale} />
        </View>
      ) : null}
    </View>
  );
}

export function ReaderBriefsTrail({ briefs, textScale }: { briefs: ReaderBrief[]; textScale?: number }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const summary = briefs.length === 1
    ? 'Read 1 paper for this response'
    : `Read ${briefs.length} papers for this response`;
  return (
    <View style={styles.trail} testID="reader-briefs-trail">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={styles.trailHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${summary}. ${open ? 'Hide' : 'Show'} the briefs.`}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} color={t.muted} />
        <Icon name="users" size={13} color={t.mint} />
        <Text variant="caption" color={t.muted}>{summary}</Text>
      </Pressable>
      {open ? briefs.map((b) => <BriefItem key={b.slug} brief={b} textScale={textScale} />) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    margin: space.md,
    padding: space.md,
    gap: space.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headerText: { flex: 1 },
  list: { gap: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 6,
  },
  rowDisabled: { opacity: 0.55 },
  rowText: { flex: 1, gap: 2 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
    marginTop: space.xs,
  },
  trail: {
    marginBottom: space.sm,
    paddingVertical: 2,
    gap: 4,
  },
  trailHeader: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  brief: { paddingLeft: space.sm, gap: 4 },
  briefHeader: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  briefTitle: { flex: 1 },
  briefBody: { paddingLeft: space.md, paddingBottom: space.xs },
});
