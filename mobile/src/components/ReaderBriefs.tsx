// DR-140 — reading assistants for project papers cited by a response. Four surfaces, in the
// order the reader meets them:
//
//   ReaderOfferLink    — the little indicator under the response that earned the offer, the way
//                        back into it once the window is closed (DR-145, the NotesUpdateLink
//                        shape Kamil named).
//   ReaderOfferSheet   — a concise offer with a check mark per paper (Kamil's design). DR-145
//                        makes it a window over the discussion rather than a card inside the
//                        transcript.
//   ReaderProgressCard — the detailed pass state: one status row per paper, then the hand-off
//                        to the agent's follow-up turn. DR-146 opens it from a header icon.
//   ReaderBriefsTrail  — on the follow-up response, the briefs it was written from: collapsed
//                        by default (one quiet row, like the agent trail), each brief expanding
//                        to its markdown. Context, not content — the answer stays the bubble.

import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type {
  ReaderBrief,
  ReaderCandidate,
  ReaderJob,
  ReaderTargetStatus,
} from '@/api/types';
import type { ReaderFetchState } from '@/hooks/useReaderBriefing';
import { BottomSheet } from '@/components/BottomSheet';
import { Markdown } from '@/components/Markdown';
import { Button, Icon, IconButton, makeTextStyles, Text, ToneSurface, type IconName } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, space } from '@/theme/tokens';

function yearSuffix(year: number | null | undefined): string {
  return year ? ` (${year})` : '';
}

/** The discussion's own prose face at the caption scale, honouring the reader's text-size
 *  setting. DR-145/146: these surfaces are supporting status beside an answer, so they follow
 *  the chat font rather than inventing a second, larger type scale on top of it. */
function useChatTextStyle(textScale: number) {
  const textStyles = useThemedStyles(makeTextStyles);
  const caption = StyleSheet.flatten(textStyles.caption);
  return {
    fontFamily: fonts.serif,
    fontSize: caption.fontSize * textScale,
    lineHeight: caption.lineHeight * textScale,
  };
}

/** How far a candidate's text has got, when the app is fetching it for the reader (DR-145). */
function fetchNote(state: ReaderFetchState | undefined): string | null {
  if (!state) return null;
  if (state.status === 'running') return 'Fetching its text…';
  if (state.status === 'needs_choice') return 'Needs a source chosen — open the paper to pick one';
  return state.error ?? 'Could not fetch its text';
}

export function ReaderOfferCard({
  candidates,
  selected,
  maxTargets,
  onToggle,
  onStart,
  onDismiss,
  onFetch,
  fetching = {},
  starting,
  error,
  textScale = 1,
  embedded = false,
}: {
  candidates: ReaderCandidate[];
  /** Slugs currently checked. Papers without cached text are never selectable. */
  selected: ReadonlySet<string>;
  /** How many papers one pass may read. Shown whenever more are on offer than fit, so the
   *  limit is a fact on the card rather than a refusal after the tap (DR-155). */
  maxTargets: number;
  onToggle: (slug: string) => void;
  onStart: () => void;
  onDismiss: () => void;
  /** Fetch one candidate's text on demand (DR-145); absent in surfaces that cannot fetch. */
  onFetch?: (slug: string) => void;
  /** Per-slug state of the fetches the app started for unfetched candidates. */
  fetching?: Record<string, ReaderFetchState>;
  starting: boolean;
  /** A start that failed for a non-spend reason (spend refusals open their own sheet). */
  error?: string | null;
  /** Match the discussion's reader-controlled prose size. */
  textScale?: number;
  /** The shared sheet already supplies its own outer spacing. */
  embedded?: boolean;
}) {
  const t = useTheme();
  const chatTextStyle = useChatTextStyle(textScale);
  const readable = candidates.filter((c) => c.has_text);
  const count = readable.filter((c) => selected.has(c.slug)).length;
  // Only worth saying when it binds: with three candidates and a cap of eight, a line about
  // eight is noise. Kamil hit it with seventeen and had nothing to read until it failed.
  const capBinds = readable.length > maxTargets;
  const atCap = count >= maxTargets;
  return (
    <ToneSurface tone="mint" style={[styles.card, embedded && styles.embeddedCard]} testID="reader-offer">
      <View style={styles.headerRow}>
        <Icon name="users" size={15} color={t.mint} />
        <Text
          variant="caption"
          style={[styles.headerText, chatTextStyle, { fontFamily: fonts.serifMedium }]}
        >
          Seminar would like to read {candidates.length === 1
            ? 'this related work'
            : 'these related works'}.
        </Text>
      </View>
      {capBinds ? (
        <Text
          variant="caption"
          color={atCap ? t.text : t.muted}
          style={chatTextStyle}
          testID="reader-cap-note"
        >
          One pass reads up to {maxTargets} — {count} of {readable.length} chosen
          {atCap ? '. Untick one to choose another.' : '.'}
        </Text>
      ) : null}
      <View style={styles.list}>
        {candidates.map((c) => {
          const checked = c.has_text && selected.has(c.slug);
          // At the cap the unchosen rows go inert rather than accepting a tap that does
          // nothing. The cap line above says why, on screen at the same moment — the missing
          // half of DR-145's "I assumed I just couldn't select the unselected papers due to a
          // bug", where a row went dead with nothing next to it saying so.
          const capped = c.has_text && !checked && atCap;
          const label = `${c.title}${yearSuffix(c.year)}`;
          const state = fetching[c.slug];
          const note = c.has_text ? null : fetchNote(state);
          // A paper still being fetched is not "unavailable" — it is on its way, so the row says
          // so rather than reading as the bug Kamil took it for ("I assumed I just couldn't
          // select the unselected papers due to a bug").
          const a11y = c.has_text
            ? (capped ? `${label}. One pass reads up to ${maxTargets} papers — untick another to choose this one.` : label)
            : `${label}. ${note ?? 'Its text has not been fetched yet.'}`;
          return (
            <View key={c.slug} style={styles.candidateRow}>
              <Pressable
                onPress={() => onToggle(c.slug)}
                disabled={!c.has_text || capped || starting}
                style={[styles.row, styles.candidateMain, (!c.has_text || capped) && styles.rowDisabled]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: !c.has_text || capped }}
                accessibilityLabel={a11y}
                testID={`reader-candidate-${c.slug}`}
              >
                {!c.has_text && state?.status === 'running' ? (
                  <ActivityIndicator size="small" color={t.mint} />
                ) : (
                  <Icon
                    name={checked ? 'check-square' : 'square'}
                    size={18}
                    color={checked ? t.mint : t.muted}
                  />
                )}
                <View style={styles.rowText}>
                  <Text variant="caption" style={chatTextStyle} numberOfLines={2}>{label}</Text>
                  {note ? (
                    <Text
                      variant="caption"
                      color={state?.status === 'error' ? t.danger : t.muted}
                      style={chatTextStyle}
                    >
                      {note}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {/* The explicit way to ask, for a fetch that has failed or was never started.
                  The app tries on its own first (DR-145) — this is the retry, not the only door. */}
              {!c.has_text && onFetch && state?.status !== 'running' ? (
                <Pressable
                  onPress={() => onFetch(c.slug)}
                  disabled={starting}
                  hitSlop={8}
                  style={styles.fetchButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Fetch the text of ${label}`}
                  testID={`reader-fetch-${c.slug}`}
                >
                  <Icon name="download" size={13} color={t.mint} />
                  <Text variant="caption" color={t.mint} style={chatTextStyle}>
                    {state ? 'Try again' : 'Fetch'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </View>
      {error ? (
        <Text variant="caption" color={t.danger} style={chatTextStyle}>{error}</Text>
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

/**
 * DR-145 (Kamil): "I think the prompt should be a window on top instead of inside the chat."
 * The offer is a decision about the discussion, not part of it — as a card in the transcript it
 * pushed the response the reader was still reading, and every re-entry had to render it again.
 * Closing the window is not an answer: `ReaderOfferLink` keeps it one tap away.
 */
export function ReaderOfferSheet({
  visible,
  onClose,
  ...card
}: {
  visible: boolean;
  onClose: () => void;
} & React.ComponentProps<typeof ReaderOfferCard>) {
  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeightPct={75} scrollable>
      <ReaderOfferCard {...card} embedded />
    </BottomSheet>
  );
}

/**
 * The way back to an offer the reader closed, under the response that earned it — the same
 * shape as the notes-update link (DR-105), which is what Kamil asked this to be: "a little
 * indicator at the bottom of the message the same way we do for showing Notes when completed".
 */
export function ReaderOfferLink({
  count,
  onOpen,
  textScale = 1,
}: {
  /** How many cited-but-unread papers the offer covers. */
  count: number;
  onOpen: () => void;
  textScale?: number;
}) {
  const t = useTheme();
  const chatTextStyle = useChatTextStyle(textScale);
  const label = count === 1
    ? 'Seminar would like to read this related work.'
    : 'Seminar would like to read these related works.';
  return (
    <Pressable
      testID="reader-offer-link"
      onPress={onOpen}
      style={[styles.offerLink, { borderColor: t.mint }]}
      accessibilityRole="button"
      accessibilityLabel={`${label} Tap to open.`}
    >
      <Icon name="users" size={13} color={t.mint} />
      <Text variant="caption" color={t.mint} style={[styles.offerLinkText, chatTextStyle]}>
        {label}
      </Text>
      <Icon name="chevron-right" size={13} color={t.mint} />
    </Pressable>
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
  if (job.analysis_job_id) return 'Handing the briefs to the agent — its fuller comparison is on its way.';
  if (job.status === 'error') return job.error;
  if (job.analysis_error) return `The briefs were recorded but the follow-up did not start: ${job.analysis_error}`;
  if (job.stopped_reason) return job.stopped_reason;
  return null;
}

export function ReaderProgressCard({
  job,
  onCancel,
  onDismiss,
  textScale = 1,
  embedded = false,
}: {
  job: ReaderJob;
  /** Stop after the paper being read now (running only). */
  onCancel?: () => void;
  /** Clear a finished card the reader has seen (terminal only). */
  onDismiss?: () => void;
  /** Match the discussion's reader-controlled prose size. */
  textScale?: number;
  /** The shared sheet already supplies its own outer spacing. */
  embedded?: boolean;
}) {
  const t = useTheme();
  const running = job.status === 'running';
  const handoff = readerHandoffLine(job);
  const tone = job.status === 'error' ? 'danger' : 'mint';
  // The pass is supporting status, not another answer. Use the discussion's Newsreader face
  // and its reader-controlled multiplier at the caption scale so it stays quieter than prose.
  const chatTextStyle = useChatTextStyle(textScale);
  return (
    <ToneSurface tone={tone} style={[styles.card, embedded && styles.embeddedCard]} testID="reader-progress">
      <View style={styles.headerRow}>
        {running ? (
          <ActivityIndicator size="small" color={t.mint} />
        ) : (
          <Icon name={job.status === 'error' ? 'alert-circle' : 'users'} size={15} color={job.status === 'error' ? t.danger : t.mint} />
        )}
        <Text
          variant="caption"
          style={[styles.headerText, chatTextStyle, { fontFamily: fonts.serifMedium }]}
        >
          {readerProgressTitle(job)}
        </Text>
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
                <Text variant="caption" style={chatTextStyle} numberOfLines={2}>{row.title}</Text>
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

/**
 * The persistent progress surface is deliberately only a header icon. The detailed state is
 * opt-in in a sheet, so a minutes-long pass never covers the response somebody is reading.
 */
export function ReaderProgressIndicator({
  job,
  onCancel,
  onDismiss,
  textScale = 1,
}: {
  job: ReaderJob;
  onCancel: () => void;
  onDismiss: () => void;
  textScale?: number;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const running = job.status === 'running';
  const failed = job.status === 'error';
  const title = readerProgressTitle(job);
  const dismissJob = useCallback(() => {
    setOpen(false);
    onDismiss();
  }, [onDismiss]);

  return (
    <>
      <View style={styles.indicator} testID="reader-progress-indicator">
        <IconButton
          name="users"
          size={18}
          color={failed ? t.danger : t.mint}
          onPress={() => setOpen(true)}
          accessibilityLabel={`${title}. Open reading assistants.`}
          accessibilityHint="Shows the papers being read without leaving the discussion."
          accessibilityRole="button"
          testID="reader-progress-trigger"
        />
        <View
          pointerEvents="none"
          style={[
            styles.indicatorDot,
            { backgroundColor: failed ? t.danger : running ? t.mint : t.muted },
          ]}
        />
      </View>
      <BottomSheet visible={open} onClose={() => setOpen(false)} maxHeightPct={75} scrollable>
        <ReaderProgressCard
          job={job}
          onCancel={running ? onCancel : undefined}
          onDismiss={!running ? dismissJob : undefined}
          textScale={textScale}
          embedded
        />
      </BottomSheet>
    </>
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
  embeddedCard: { margin: 0 },
  indicator: { position: 'relative' },
  indicatorDot: {
    position: 'absolute',
    top: 6,
    right: 5,
    width: 7,
    height: 7,
    borderRadius: 4,
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
  candidateRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // The checkbox half must SHRINK so its sibling Fetch button stays on screen. A flex child in
  // Yoga defaults to `flexShrink: 0`, unlike on the web, so this row sized itself to the longest
  // title's intrinsic width and pushed Fetch past the right edge — on every candidate, which
  // defeats the "option to fetch" this change exists to add. `styles.row` is shared with the
  // progress card, where it is a child of a COLUMN and `flex: 1` would stretch its height, so
  // this goes on the candidate's own Pressable rather than into the shared style.
  candidateMain: { flex: 1 },
  fetchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    flexShrink: 0,
  },
  offerLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: space.sm,
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  offerLinkText: { flex: 1 },
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
