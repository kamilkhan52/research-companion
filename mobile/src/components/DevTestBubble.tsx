// The in-app device-test companion (DR-060) — dev builds only. A floating bubble, openable
// from anywhere, listing the device-review ledger's items with what-to-test instructions;
// pass/fail/remark verdicts (text optional on a verdict, required for a bare remark unless a
// screenshot is attached), a screenshot of the screen BENEATH the bubble, and new-issue capture.
// Everything lands in the server's `.dev-feedback/` inbox for the /device-feedback skill to
// triage into the ledger — the app never writes the ledger itself.
//
// `remark` is the WIRE word — the API, the inbox and the triage skill all speak it — and it is
// deliberately not what the sheet says. DR-123: he asked "I don't know what Notes here are. Is
// note a comment? A reply?", and the answer was that three words named two things. On screen his
// entries are COMMENTS, the agent's are REPLIES, and the two together are the CONVERSATION;
// nothing here says "note" or "agent" any more.
//
// Gating is server-truth: the parent renders this only when useDevMode() is true, and every
// route 404s outside RC_DEV, so a production build cannot expose it even if the JS shipped.
//
// The screenshot deliberately excludes this UI: capture happens on bubble TAP, before the
// sheet renders, with the bubble itself hidden for the frame. `react-native-view-shot` is a
// native module the current dev client may predate — the require is guarded, and without it
// the feature degrades to text-only feedback with an explanatory chip.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePathname } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, NativeModules, Pressable, ScrollView, StyleSheet, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as api from '@/api/endpoints';
import { DISPATCH_MODELS } from '@/api/dispatch';
import type { DispatchModel } from '@/api/dispatch';
import type {
  DevTestItem, DevTestFeedbackEntry, DispatchStatus, DeployState,
} from '@/api/endpoints';
import { Markdown, MarkdownRuns } from '@/components/Markdown';
// DR-118 reuses the corpus-neighbourhood line's coarse age formatter rather than growing a second
// one — "2h ago" here means what it means there.
import { relativeAge } from '@/components/NeighbourhoodLine';
// DR-120: the collapsed description preview is a single `<Text>` (numberOfLines), so it shows
// the prose with the markdown syntax removed rather than the raw cell.
import { markdownToPlain } from '@/lib/markdownPlain';
import { showToast } from '@/ui/Toast';
import { impactTap } from '@/lib/haptics';
import { Chip, Icon, IconButton, Text, type IconName } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { control, fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';

// Guarded: the JS package resolves as soon as it's `npm install`ed and Metro serves it —
// that says nothing about whether a SPECIFIC installed dev-client APK has the native module
// compiled in (DR-062: `require()` succeeding made canScreenshot() report true on an old
// client, so a real capture failure showed the wrong, less actionable message). The library
// itself gates every call on `NativeModules.RNViewShot`, so that's the real availability
// check — same signal, checked once, instead of inferred from whether a call happened to throw.
let captureScreen: ((opts: object) => Promise<string>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  captureScreen = require('react-native-view-shot').captureScreen;
} catch {
  captureScreen = null;
}

export const canScreenshot = () => captureScreen !== null && NativeModules.RNViewShot != null;

// DR-078 — "Dev test bubble hides under menus." Native `Modal`s (OptionsSheet,
// NotesReviewSheet) open in their own OS window ABOVE the app hierarchy, so nothing in the
// base layer — whatever its zIndex — can float over them. The fix is inverted: those modal
// hosts render their own copy of the trigger (`DevTestFloatingTrigger`, via the lazy
// `DevTestModalTrigger` wrapper) inside their window, and it opens the ONE sheet owned by the
// root `DevTestBubble` through this module-level opener. The devtest sheet is itself a native
// Modal, and Android stacks dialogs by presentation order, so it appears above the menu it
// was opened from. One registration only — there is exactly one DevTestBubble mount.
let sheetOpener: (() => void) | null = null;
export function requestDevTestOpen() {
  sheetOpener?.();
}

// Whether a root DevTestBubble is currently mounted — the modal-hosted triggers subscribe
// to this instead of re-running the RC_DEV health query themselves, so they carry no
// react-query context requirement into their host components (or those components' tests).
// A COUNTER, not a boolean (Opus review, PR #402): with last-writer-wins, a transient second
// mount's cleanup would de-register the survivor and every modal trigger would vanish with
// no signal.
const activeListeners = new Set<() => void>();
let bubbleMounts = 0;
function adjustBubbleMounts(delta: number) {
  const wasActive = bubbleMounts > 0;
  bubbleMounts += delta;
  if (bubbleMounts > 0 !== wasActive) activeListeners.forEach((l) => l());
}
// Module-scope subscribe: an inline closure would re-subscribe on every render of every
// trigger copy (Opus review, PR #402).
function subscribeToBubbleMounts(cb: () => void) {
  activeListeners.add(cb);
  return () => activeListeners.delete(cb);
}
const bubbleIsMounted = () => bubbleMounts > 0;

/** The modal-layer trigger: renders nothing unless the root bubble is live (dev builds
 *  against a dev server), so Modal hosts can mount it unconditionally. */
export function DevTestFloatingTriggerIfActive() {
  const active = useSyncExternalStore(subscribeToBubbleMounts, bubbleIsMounted);
  if (!active) return null;
  return <DevTestFloatingTrigger />;
}

/** The floating clipboard trigger — rendered by the root bubble in the base layer, and by
 *  native-Modal hosts INSIDE their own window. Keyboard-aware in both places: the review
 *  surfaces hosting it (NotesReviewSheet's edit mode especially) put a keyboard over the
 *  default position (DR-072's lesson, re-found in PR #402's review).
 *
 *  Known limits, deliberate: on Android, react-native-view-shot captures the app's main
 *  window only (dialogs are separate OS windows), so feedback filed from a native menu
 *  arrives without the menu in the shot — still strictly better than closing the menu to
 *  reach the bubble. On iOS the same call grabs the key window INCLUDING presented
 *  view-controllers, so a modal-hosted copy could appear in its own screenshot; Android-only
 *  today, revisit self-hiding if iOS ever ships. */
export function DevTestFloatingTrigger() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardState((s) => (s.isVisible ? s.height : 0));
  return (
    <Pressable
      onPress={requestDevTestOpen}
      accessibilityRole="button"
      accessibilityLabel="Open device-test companion"
      style={[
        styles.bubble,
        { bottom: keyboardHeight > 0 ? keyboardHeight + space.md : insets.bottom + 96 },
      ]}
    >
      <Icon name="clipboard" size={20} color={t.mintInk} />
    </Pressable>
  );
}

/** Tester-facing ordering: verify first (that queue is why the feature exists), then open
 *  work, then everything else collapsed. Exported for tests. */
export function sectionItems(items: DevTestItem[]): {
  verify: DevTestItem[]; open: DevTestItem[]; rest: DevTestItem[];
} {
  const verify: DevTestItem[] = [];
  const open: DevTestItem[] = [];
  const rest: DevTestItem[] = [];
  for (const item of items) {
    if (item.state === 'implemented — verify') verify.push(item);
    else if (['open', 'partial', 'planned', 'new — untriaged'].includes(item.state)) open.push(item);
    else rest.push(item);
  }
  return { verify, open, rest };
}

// DR-077 — Kamil: "Add sorting and filtering options to the dev test bubble list... the idea is
// to be easily able to jump back into whatever I was working on and then find the next one to
// work on." Filtering needs to know which items already carry a pass/fail verdict; sorting by
// recency needs to know WHEN. Both live in the DR-075 per-item persisted draft already.
export type ReviewFilter = 'all' | 'needsreply' | 'unreviewed' | 'reviewed' | 'passed' | 'failed' | 'closed';
export type SortMode = 'default' | 'activity' | 'recent' | 'az';
export type VerdictInfo = { verdict: 'pass' | 'fail'; at: number };

export const REVIEW_FILTERS: { key: ReviewFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  // DR-134 — Kamil: "I made comments on Passed items expecting they'd be seen." They were not.
  // Every other filter here keys on the VERDICT, and recording a Pass drops the card out of the
  // default "Not reviewed" view — so a comment added afterwards lands somewhere he cannot see.
  // This one keys on whose word came last instead, which is why it can surface a passed item.
  { key: 'needsreply', label: 'Needs reply' },
  { key: 'unreviewed', label: 'Not reviewed' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'passed', label: 'Passed' },
  { key: 'failed', label: 'Failed' },
  // DR-132 — "Those closed should also move out of the way. There should be a filter so I don't
  // have to see closed issues when I'm not trying to." They are 42 of 137 and only grow, so they
  // are excluded from EVERY other view rather than being one more thing to filter out; this is
  // the way back to them.
  { key: 'closed', label: 'Closed' },
];
export const SORT_MODES: { key: SortMode; label: string }[] = [
  { key: 'default', label: 'Priority' },
  // DR-118 — Kamil: "I usually want to just find the last item I opened or dispatched or was
  // last worked on by Claude." Sits next to "Recently reviewed" rather than replacing it: that
  // one answers "what have I passed/failed lately", this one answers "where was I", and they
  // disagree exactly when the work moved without him (a reply, a dispatch).
  { key: 'activity', label: 'Last activity' },
  { key: 'recent', label: 'Recently reviewed' },
  { key: 'az', label: 'A–Z' },
];

const ITEM_DRAFT_PREFIX = `${draftKey('devtest-item')}:`;

/** What this phone knows about an item beyond what the server can see: the verdict given from
 *  here (DR-077) and when its card was last opened (DR-118 — "the last item I opened" is a
 *  purely local fact; the server never learns that a card was expanded). */
export type LocalItemState = { verdict?: VerdictInfo; openedAt?: number };

/** Reads every item's persisted local state straight from storage, not just currently-mounted
 *  cards — a card inside the collapsed "Everything else" section (or simply not yet scrolled
 *  to) never mounts, so its verdict would otherwise be invisible to filtering/sorting until
 *  that section is expanded. Exported for a direct test; a corrupt entry just contributes
 *  nothing rather than blocking the rest of the sheet. */
export async function loadLocalItemState(): Promise<Record<string, LocalItemState>> {
  const keys = await AsyncStorage.getAllKeys();
  const itemKeys = keys.filter((k) => k.startsWith(ITEM_DRAFT_PREFIX));
  if (!itemKeys.length) return {};
  const pairs = await AsyncStorage.multiGet(itemKeys);
  const out: Record<string, LocalItemState> = {};
  for (const [key, raw] of pairs) {
    if (!raw) continue;
    try {
      const stored = JSON.parse(raw) as { value?: Partial<ItemCardDraft> };
      const verdict = stored.value?.verdict;
      const openedAt = stored.value?.openedAt;
      const entry: LocalItemState = {};
      if (verdict === 'pass' || verdict === 'fail') {
        entry.verdict = { verdict, at: stored.value?.verdictAt ?? 0 };
      }
      if (typeof openedAt === 'number' && openedAt > 0) entry.openedAt = openedAt;
      if (entry.verdict || entry.openedAt) {
        out[decodeURIComponent(key.slice(ITEM_DRAFT_PREFIX.length))] = entry;
      }
    } catch {
      // ignore a corrupt entry — see doc comment above
    }
  }
  return out;
}

/** The verdict half of the read above, which is what filtering needs. */
export function verdictsOf(local: Record<string, LocalItemState>): Record<string, VerdictInfo> {
  const out: Record<string, VerdictInfo> = {};
  for (const [id, entry] of Object.entries(local)) if (entry.verdict) out[id] = entry.verdict;
  return out;
}

/** Milliseconds since the epoch of the newest thing that happened to `item`, from either side:
 *  the server's `last_activity` (a reply, a dispatch, a verdict recorded in the inbox — SECONDS,
 *  hence the conversion) and this phone's own local state. 0 means nothing ever did.
 *
 *  The local verdict counts as well as the local open: the server records his verdicts too, but
 *  only once they reach it, and a verdict given while the dev server was unreachable would
 *  otherwise not be activity at all. */
export function activityAt(item: DevTestItem, local: LocalItemState | undefined): number {
  return Math.max(
    item.last_activity ? item.last_activity * 1000 : 0,
    local?.openedAt ?? 0,
    local?.verdict?.at ?? 0,
  );
}

/** What the winning timestamp refers to, in Kamil's own vocabulary — "opened", "dispatched",
 *  "worked on by Claude". A bare age ("2h ago") would say the item moved but not who moved it,
 *  which is the whole reason this sort beats "Recently reviewed" for him. */
export function activityNote(item: DevTestItem, local: LocalItemState | undefined): string {
  const at = activityAt(item, local);
  if (!at) return '';
  const serverAt = item.last_activity ? item.last_activity * 1000 : 0;
  let what: string;
  if (at === (local?.openedAt ?? 0) && at >= serverAt) what = 'You opened it';
  else if (at === (local?.verdict?.at ?? 0) && at >= serverAt) what = 'You tested it';
  else if (item.last_activity_kind === 'claude') what = 'Claude replied';
  else if (item.last_activity_kind === 'dispatch') what = 'Dispatched to Claude';
  else if (item.last_activity_kind === 'raised') what = 'You raised it';
  else what = 'You tested it';
  return `${what} · ${relativeAge((Date.now() - at) / 1000)}`;
}

/** A Chip driven by its own Pressable rather than Chip's built-in `onPress` (same reasoning as
 *  the member chips in authors.tsx): gives it a real accessibilityRole/State as a toggle. */
function ToggleChip({ label, active, onPress, onLayout }: {
  label: string;
  active: boolean;
  onPress: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLayout={onLayout}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={({ pressed }) => pressed && { opacity: 0.7 }}
    >
      <Chip label={label} dot={false} selected={active} />
    </Pressable>
  );
}

/** DR-123 — Kamil: "The buttons for Show all, Dispatch all, Pass, Fail, Remark etc. are too big."
 *
 *  The shared `Button` is a 48–50px pill with 24px side padding and 15–16px `heading` text: right
 *  for a screen with three actions on it, wrong for a review sheet that puts three on every card.
 *  This is the sheet's own compact pill, and it is deliberately LOCAL rather than a new variant on
 *  the shared primitive — he bounded the ask himself ("Reduce those too for this screen and we
 *  might consider for the rest of the app later"), and this surface is dev-only, so the rest of the
 *  app must not move underneath him as a side effect.
 *
 *  What shrinks is the PILL, not the target. `control.minTouch` is the floor the density tokens
 *  state outright ("Density may tighten rhythm, but it must never make an interactive control
 *  harder to hit"), so the PRESSABLE stays that tall and the visible pill is a shorter child
 *  centred inside it.
 *
 *  That structure, and not a `hitSlop`, because a hitSlop would not have worked and would have
 *  been hard to notice: RN documents that "the touch area never extends past the parent view
 *  bounds" (`ViewPropTypes.d.ts`), and every row these sit in — the verdict row, the header
 *  actions, the banner rows — hugs its children's height. Slop of 8 around a 32px pill inside a
 *  32px row is clipped straight back to 32. The first version of this did exactly that, and the
 *  test written for it asserted `height + 2 * slop >= minTouch`, which is arithmetic on props and
 *  true regardless of what the app renders (Opus review, PR #479). The target is now a real
 *  laid-out box, and the test measures that box. */
const SMALL_BTN_HEIGHT = 32;

function SmallButton({ title, icon, variant = 'ghost', loading, disabled, onPress, style, ...rest }: {
  title: string;
  icon?: IconName;
  variant?: 'primary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  style?: object;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const isDisabled = disabled || loading;
  const fg = variant === 'primary' ? t.mintInk : t.text;
  return (
    <Pressable
      onPress={() => {
        // The shared `Button` fires this on its primary variant, and Pass / Create / the fail
        // prompt's Dispatch were primary Buttons before this — recording a verdict should still
        // feel like it landed (Opus review, PR #479).
        if (variant === 'primary') impactTap();
        onPress?.();
      }}
      disabled={isDisabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.smallBtnTarget,
        pressed && !isDisabled && { opacity: 0.82 },
        isDisabled && { opacity: 0.45 },
        style,
      ]}
      {...rest}>
      <View style={[
        styles.smallBtn,
        variant === 'primary' ? styles.smallBtnPrimary : styles.smallBtnGhost,
      ]}>
        {loading ? (
          <ActivityIndicator size="small" color={variant === 'primary' ? t.mintInk : t.mint} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={14} color={fg} /> : null}
            <Text variant="label" color={fg} numberOfLines={1}>{title}</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

/** DR-123 — Kamil: "'Implemented -- verify' is too big."
 *
 *  The ledger's lifecycle states are written for the ledger, where a row has a whole column; on a
 *  card they were a bordered chip wide enough to push everything else onto a second line. The
 *  short form is what the card shows; the FULL state still reaches a screen reader through the
 *  card header's own accessibility label, so nothing is actually lost.
 *
 *  Unknown states fall through unchanged rather than being mangled — the ledger may grow one, and
 *  showing it verbatim is the honest failure. */
const SHORT_STATES: Record<string, string> = {
  'implemented — verify': 'Verify',
  'new — untriaged': 'New',
  open: 'Open',
  partial: 'Partial',
  planned: 'Planned',
  deferred: 'Deferred',
  closed: 'Closed',
  superseded: 'Superseded',
};
export function shortState(state: string): string {
  return SHORT_STATES[state] ?? state;
}

/** The section tones, per item: mint = waiting on him, amber = work still open, muted = neither.
 *  Same three-way split `sectionItems` already makes, so a card's colour and the section it sits
 *  in cannot disagree. */
function stateTone(state: string, t: ThemePalette): string {
  if (state === 'implemented — verify') return t.mint;
  if (['open', 'partial', 'planned', 'new — untriaged'].includes(state)) return t.amber;
  return t.muted;
}

/** DR-123 — Kamil: "I don't know what Notes here are. Is note a comment? A reply? Be clear and
 *  consistent."
 *
 *  He was right that the word was unstable, and it was a real inconsistency rather than a wording
 *  preference: the chip said "notes" but counted only HIS entries, the agent's answers were
 *  counted separately as "replies", and the button labelled "Show earlier notes" opened BOTH. The
 *  word "note" is now gone from the sheet entirely. His entries are "from you" (they are not all
 *  comments — a bare Pass is one), the agent's are "replies", and the thing that holds both is the
 *  "conversation". */
/** The filter predicate, exported so tests drive the real one rather than a copy of it.
 *
 *  `needsreply` deliberately ignores the verdict, and that is the whole of DR-134: every other
 *  case here keys on it, so recording a Pass drops the card out of the default view and a
 *  comment added afterwards has nowhere to appear. */
export function matchesFilter(
  item: DevTestItem, filter: ReviewFilter, verdict: 'pass' | 'fail' | undefined,
): boolean {
  // DR-132 — "Those closed should also move out of the way. There should be a filter so I don't
  // have to see closed issues when I'm not trying to." They are 42 of 137 and only grow.
  //
  // Excluded from the WORKING views, not from `all`. Making "All" quietly mean "all except 42"
  // is the DR-116 failure — a list that is short for a reason nothing on screen states — and it
  // broke fourteen existing tests that were right to assume All means all.
  //
  // `needsreply` is the other exception, and it has to be: a closed row only carries
  // `awaiting_reply` when he came back to it AFTER a reply, which is him reopening something.
  // Hiding that would re-create DR-134's exact bug one state over. Settled is not answered.
  if (filter === 'closed') return item.state === 'closed';
  // Excluded from "Not reviewed" ONLY — the working queue, where 42 settled rows are the noise
  // he means. Every other view is either explicitly all of them, or an explicit selection of a
  // property the row has: a closed item he FAILED belongs under Failed, and a closed item he
  // came back to after a reply belongs under Needs reply (hiding that would re-create DR-134's
  // bug one state over — settled is not answered). Two earlier cuts of this were wrong: one made
  // "All" quietly mean "all except 42", which is DR-116's own complaint, and one hid a failed
  // closed item from Failed. Both were caught by tests that already encoded the right answer.
  switch (filter) {
    case 'needsreply': return !!item.awaiting_reply;
    case 'unreviewed': return !verdict && item.state !== 'closed';
    case 'reviewed': return !!verdict;
    case 'passed': return verdict === 'pass';
    case 'failed': return verdict === 'fail';
    default: return true;
  }
}

export function cardMeta(item: DevTestItem, verdict: 'pass' | 'fail' | undefined): string {
  const parts: string[] = [];
  // The verdict leads, and it is the one ordering decision here worth explaining. This line is
  // bounded, so whatever is last is what an OS font scale truncates away — and the verdict is
  // both the shortest token and the one DR-075 exists for ("this helps me see what next to
  // test"). Colour alone would not carry it: the line takes the verdict's colour, but colour is
  // not an accessible signal (Opus review, PR #479).
  if (verdict) parts.push(verdict === 'fail' ? 'Failed' : 'Passed');
  parts.push(shortState(item.state));
  if (item.feedback_count) parts.push(`${item.feedback_count} from you`);
  if (item.response_count) {
    parts.push(`${item.response_count} repl${item.response_count === 1 ? 'y' : 'ies'}`);
  }
  // DR-134's second half — "a way to track if other sessions have addressed some or are
  // addressing it". Only the LIVE state earns a word on a bounded line: `worked` is already
  // implied by a reply count, but "a session is on this right now" is knowable nowhere else and
  // is the difference between waiting and re-dispatching. Last, so an OS font scale truncates
  // it before the verdict (DR-075's ordering rule).
  if (item.agent_state === 'working') parts.push('Claude is on it');
  return parts.join(' · ');
}

/** DR-116 — Kamil: "Dev test bubble shows 11 of 117. I don't know how to view the rest. The
 *  Filter is set to All". Nothing was truncated: DR-077's search and filter persist across app
 *  launches, so a choice made days ago was still narrowing the list, and the sheet said only
 *  how MANY were hidden — never by what, and never offering a way back. This names each active
 *  narrowing in the tester's own vocabulary (the chip labels he tapped) for the caption and the
 *  reset button below it.
 *
 *  Sort is deliberately excluded: "A–Z"/"Recently reviewed" reorder the matched set, they never
 *  hide a row, so resetting them would undo a choice that is not part of the complaint. */
export function narrowingReasons(query: string, filter: ReviewFilter): string[] {
  const reasons: string[] = [];
  if (filter !== 'all') {
    reasons.push(`filter “${REVIEW_FILTERS.find((f) => f.key === filter)?.label ?? filter}”`);
  }
  if (query.trim()) reasons.push(`search “${query.trim()}”`);
  return reasons;
}

/** DR-123 — what the ⋮ says about the settings hidden behind it, or `''` when they are all at
 *  their defaults and the icon should stay quiet.
 *
 *  Sort is included HERE and still excluded from `narrowingReasons`, and the difference is the
 *  point. The count caption answers "why is this list short", which sort never causes; this
 *  answers "is anything set in there", which sort certainly is. Leaving sort out of both would
 *  make a restored "Recently reviewed" the one persisted choice with nothing on screen — the
 *  state DR-118's row warned about in advance, now that the chips are behind a menu. */
export function optionsNote(narrowedBy: string[], sort: SortMode): string {
  const parts: string[] = [];
  if (narrowedBy.length) parts.push('A filter or search is narrowing the list.');
  if (sort !== 'default') {
    parts.push(`Sorted by ${SORT_MODES.find((s) => s.key === sort)?.label ?? sort}.`);
  }
  return parts.join(' ');
}

/** DR-116, generalised by DR-118: keep the SELECTED chip of a horizontal chip row on screen.
 *
 *  Such a row always opens at offset 0, so a restored selection past the fold leaves every chip
 *  the tester can see looking unselected — indistinguishable from the leftmost (default) chip
 *  being on, which is exactly how "the Filter is set to All" got reported while a filter was
 *  narrowing the list. The restored selection is scrolled into view once per sheet open.
 *
 *  Two paths, because neither alone is sufficient (Opus review, PR #469): a chip's `x` is only
 *  known once it has laid out, and the persisted selection only once AsyncStorage answers — either
 *  can land first. `rememberX` covers "selection known, chip measured later"; the effect covers
 *  "chip measured, selection hydrated later". Neither spends the once-per-open token while `x` is
 *  still unknown, or a sheet that lays out before hydration would silently never scroll at all.
 *
 *  `visible` drives the reset: RN's Modal returns null while hidden, so children unmount and every
 *  chip lays out again on the next open. The MEASUREMENTS are dropped with the token — kept, they
 *  would let the next open scroll from the previous open's cache before this open's ScrollView has
 *  been laid out natively (which on Android clamps to 0) and then spend the token, discarding the
 *  real measurement that arrives a moment later.
 */
function useChipReveal<K extends string>(
  selected: K, leftmost: K, ready: boolean, visible: boolean,
) {
  const scrollRef = useRef<ScrollView>(null);
  const chipX = useRef<Partial<Record<K, number>>>({});
  const revealedRef = useRef(false);
  const reveal = useCallback(() => {
    // The leftmost chip is already at offset 0, so revealing it would be motion for nothing.
    if (!ready || revealedRef.current || selected === leftmost) return;
    const x = chipX.current[selected];
    if (x == null) return;
    revealedRef.current = true;
    scrollRef.current?.scrollTo({ x: Math.max(0, x - space.md), animated: false });
  }, [leftmost, ready, selected]);
  const rememberX = useCallback((key: K, e: LayoutChangeEvent) => {
    chipX.current[key] = e.nativeEvent.layout.x;
    reveal();
  }, [reveal]);
  useEffect(() => {
    if (!visible) {
      revealedRef.current = false;
      chipX.current = {};
      return;
    }
    reveal();
  }, [visible, reveal]);
  /** The tester chose this himself: the chip is on screen by definition, so spend the token
   *  rather than let the re-measure a selection triggers snap the row under his finger. */
  const markChosen = useCallback(() => { revealedRef.current = true; }, []);
  return { scrollRef, rememberX, markChosen };
}

export function DevTestBubble() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // DR-072's keyboard-aware positioning lives inside DevTestFloatingTrigger now, shared with
  // the modal-hosted copies (PR #402 review).
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [hidden, setHidden] = useState(false);   // bubble hidden for the capture frame
  const [shot, setShot] = useState<string | null>(null);
  const [items, setItems] = useState<DevTestItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);
  const [creating, setCreating] = useState(false);
  // DR-123: the ⋮ panel holding filter, sort and dispatch. Plain useState and NOT a persisted
  // draft — "everything collapsible should be collapsed by default" is the ask, and a menu that
  // remembered being open would greet him with the very rows he asked to have put away.
  const [menuOpen, setMenuOpen] = useState(false);
  // DR-063: "I don't think I see the issue I just opened." A new item lands in the Open
  // section, which renders below whatever the verify queue holds (up to dozens of cards) —
  // easy to miss entirely. Pin it in its own section at the very top instead, expanded, until
  // the reader dismisses it or opens another new-issue form.
  const [justCreated, setJustCreated] = useState<DevTestItem | null>(null);
  // DR-074: "the scrolled position should also be in the state. In a long list, I shouldn't be
  // needing to scroll over and over again." Same persisted-draft mechanism DR-065 uses for
  // per-item state, keyed once for the whole list rather than per item.
  const scrollDraft = usePersistedDraft<number>(draftKey('devtest-scroll'), 0);
  const scrollRef = useRef<ScrollView>(null);
  const restoredScrollRef = useRef(false);
  // Opus review, PR #380: persisting on every `onScroll` puts a `setState` on this component —
  // which re-renders every unmemoized `ItemCard` below it, dozens of them — on every throttled
  // scroll frame. Track the live offset in a ref (no re-render) and only commit it to the
  // persisted draft at the natural pause points, one re-render per gesture instead of per frame.
  const scrollOffsetRef = useRef(0);
  // Where the list was standing when a card was opened, so closing it can put us back. Keyed by
  // id: opening a second card while the first is open must not overwrite the first's anchor.
  const expandAnchors = useRef<Record<string, number>>({});
  const onExpandChange = useCallback((expanded: boolean, id: string) => {
    if (expanded) {
      expandAnchors.current[id] = scrollOffsetRef.current;
      return;
    }
    const anchor = expandAnchors.current[id];
    delete expandAnchors.current[id];
    // Only ever scroll BACK. If he has since scrolled above the anchor under his own steam,
    // yanking him down to it would be the same complaint in the other direction.
    if (anchor === undefined || scrollOffsetRef.current <= anchor) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: anchor, animated: true }));
  }, []);
  const commitScrollOffset = useCallback(() => {
    scrollDraft.setValue(scrollOffsetRef.current);
  }, [scrollDraft]);

  // DR-092: the model a bubble dispatch uses, persisted so it survives reopen like the toolbar.
  const modelDraft = usePersistedDraft<DispatchModel>(draftKey('devtest-dispatch-model'), 'sonnet');
  const [dispatchingAll, setDispatchingAll] = useState(false);
  // Fails waiting to be handed over, oldest first — a QUEUE, not a slot. A single slot meant
  // failing a second item silently discarded the first one's prompt, which is the same
  // "recorded and carried nowhere" gap this feature exists to close, one level up. Only the
  // head is shown, since dispatch is single-flight and a stack of prompts would be worse.
  const [failQueue, setFailQueue] = useState<string[]>([]);
  const queueFailPrompt = useCallback((id: string) => {
    setFailQueue((q) => (q.includes(id) ? q : [...q, id]));
  }, []);
  const failPrompt = failQueue[0] ?? null;
  // The heartbeat behind the banner below: what a dispatched session is doing, and how the last
  // one ended. Polls only while this sheet is open.
  const dispatchStatus = useDispatchHeartbeat(visible);

  // DR-077: search/filter/sort state persists across opens the same way everything else in
  // this sheet does — one key for the whole toolbar, so leaving mid-review (e.g. filtered to
  // "Not reviewed") and coming back keeps the exact view, matching the "jump back into whatever
  // I was working on" ask.
  const toolbar = usePersistedDraft<{ query: string; filter: ReviewFilter; sort: SortMode }>(
    draftKey('devtest-toolbar'), { query: '', filter: 'all', sort: 'default' },
  );
  const { query, filter, sort } = toolbar.value;
  // DR-116: what is currently hiding rows, named rather than merely counted. Empty ⇒ the list
  // is complete and no caption/reset is warranted.
  const narrowedBy = useMemo(() => narrowingReasons(query, filter), [query, filter]);
  const narrowed = narrowedBy.length > 0;
  // DR-123: what the ⋮ has to announce, which is NOT the same set as what narrows the list.
  // Sort hides nothing, so it is deliberately absent from `narrowingReasons` and from the count
  // caption — but it is persisted, and with the chips behind a menu it became the one toolbar
  // choice with no trace on screen at all. DR-118's own row predicted this exactly: "nothing on
  // screen would have explained the order" (Opus review, PR #479).
  const optionsSummary = useMemo(
    () => optionsNote(narrowedBy, sort), [narrowedBy, sort],
  );
  const setQuery = (next: string) => toolbar.setValue((v) => ({ ...v, query: next }));

  // DR-116's chip reveal, for BOTH rows. DR-118 made this general rather than filter-only: adding
  // a fourth sort chip widened that row past a phone's width, so a restored "A–Z"/"Recently
  // reviewed" could now sit off-screen with every visible chip looking unselected — the same
  // unreadable state DR-116 was filed about, one row down and with no caption naming it (sort is
  // deliberately excluded from `narrowingReasons`, because it hides nothing).
  //
  // DR-123 moved both rows inside the ⋮ menu, so the thing they mount and unmount with is the
  // MENU, not the sheet — passing `visible` here would spend the once-per-open token on the first
  // sheet-open and then never reveal the restored chip on any subsequent menu open.
  const filterChips = useChipReveal(filter, 'all', toolbar.ready, menuOpen);
  const sortChips = useChipReveal(sort, 'default', toolbar.ready, menuOpen);

  // A tap is not a restore, so it spends the token even though the tester's own choice must never
  // move the row (Opus review, PR #469: selecting a chip switches its label to semibold, which
  // changes its measured width and re-fires `onLayout` for the whole row — without this the first
  // filter tap of each open snapped the chip row sideways, unanimated, under the finger).
  const setFilter = (next: ReviewFilter) => {
    filterChips.markChosen();
    toolbar.setValue((v) => ({ ...v, filter: next }));
  };
  // Below its hook rather than beside `setQuery`: only ever called from an `onPress`, so a
  // forward reference would work — but it would TDZ-crash the day anything calls it at render.
  const setSort = (next: SortMode) => {
    sortChips.markChosen();
    toolbar.setValue((v) => ({ ...v, sort: next }));
  };
  // DR-116: one tap back to the whole list. Sort is left alone — see `narrowingReasons`.
  const showEverything = () => {
    setFilter('all');
    setQuery('');
  };
  // "Everything else" is force-open while narrowed, so LEAVING that state must not re-collapse it:
  // the closed rows a filter had put on screen would vanish a frame later, which is a miniature of
  // the very complaint DR-116 is about. Bound to the narrowed state rather than to the "Show all"
  // button (Opus review, PR #469 — the button was only one of three ways out; tapping the All chip
  // and clearing the search box both reproduced the vanish). The cost is that the section stays
  // expanded after a filtered session until the tester collapses it again, which is the right side
  // to err on for a complaint that begins "I don't know how to view the rest".
  useEffect(() => { if (narrowed) setShowRest(true); }, [narrowed]);

  // Seeded in bulk on open (covers items whose card has never mounted — DR-077's whole point is
  // finding those), then kept live by each mounted ItemCard reporting its own verdict as it
  // loads or changes (`reportVerdict` below).
  const [verdicts, setVerdicts] = useState<Record<string, VerdictInfo>>({});
  // DR-118: the same bulk read's other half, and deliberately NOT kept live. Expanding a card
  // is itself activity, so a live map would re-sort the list under the finger that just tapped
  // it — the card would slide away mid-read. It is a snapshot per open: what happened before
  // this sitting orders the list, what happens during it takes effect the next time.
  const [localState, setLocalState] = useState<Record<string, LocalItemState>>({});
  // DR-134: `awaiting_reply` and `agent_state` are derived server-side from the inbox and the
  // dispatch records, so no local state update can keep them true. Without this the two things
  // the row asks Kamil to check both fail in the sitting he checks them: a comment recorded
  // after a Pass does not move into "Needs reply", and dispatching from a card never adds
  // "Claude is on it" — he would record a Fail on working code.
  const refreshItems = useCallback(async () => {
    try {
      setItems((await api.getDevTestItems()).items);
    } catch {
      /* a failed refresh leaves the last good list; the next open re-fetches. */
    }
  }, []);

  // DR-134: the badge is derived from which item a LIVE session is on, so it has to move when
  // that changes — a dispatch starting, or ending. The heartbeat already polls for exactly that,
  // so hang the item refetch off its transitions rather than adding a second timer.
  const dispatchedItem = dispatchStatus?.state === 'running' ? dispatchStatus.item_id : null;
  const lastDispatched = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Only on a real TRANSITION. Firing on mount too would race the open path's own fetch,
    // which is what it did first: the reopen test lost its list entirely because the second
    // fetch landed after the first and the two disagreed.
    const changed = lastDispatched.current !== undefined && lastDispatched.current !== dispatchedItem;
    lastDispatched.current = dispatchedItem;
    if (visible && changed) void refreshItems();
  }, [visible, dispatchedItem, refreshItems]);

  const reportVerdict = useCallback((id: string, info: VerdictInfo | undefined) => {
    setVerdicts((prev) => {
      const cur = prev[id];
      if (cur?.verdict === info?.verdict && cur?.at === info?.at) return prev;
      const next = { ...prev };
      if (info) next[id] = info; else delete next[id];
      return next;
    });
  }, []);

  const open = useCallback(async () => {
    let captured: string | null = null;
    if (captureScreen && canScreenshot()) {
      setHidden(true);
      // Two frames so the hidden bubble is actually out of the composited frame.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        // jpg: PNG ignores `quality` on both platforms, and a full-screen PNG can brush
        // the server's payload cap; JPEG at 0.8 is 5-10x smaller and plenty for triage.
        captured = await captureScreen({ format: 'jpg', result: 'base64', quality: 0.8 });
      } catch {
        captured = null;
      }
      setHidden(false);
    }
    setShot(captured);
    setVisible(true);
    try {
      setItems((await api.getDevTestItems()).items);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? 'Could not load test items.');
    }
    const local = await loadLocalItemState().catch(() => ({}));
    setLocalState(local);
    setVerdicts(verdictsOf(local));
  }, []);

  // DR-078: triggers hosted inside native Modal windows open this sheet through the
  // module-level opener above, and render only while a root mount is live.
  useEffect(() => {
    const opener = () => void open();
    sheetOpener = opener;
    adjustBubbleMounts(1);
    return () => {
      if (sheetOpener === opener) sheetOpener = null;
      adjustBubbleMounts(-1);
    };
  }, [open]);

  // Exclude the pinned "Just added" item from its normal section — Opus review, PR #371: it
  // used to render there too, a second mounted `ItemCard` for the same item.id sharing one
  // AsyncStorage draft key with independent in-memory state, so submitting a verdict on one
  // instance's debounced write could resurrect it on the other.
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (q && !i.id.toLowerCase().includes(q) && !i.title.toLowerCase().includes(q)) return false;
      const v = verdicts[i.id]?.verdict;
      return matchesFilter(i, filter, v);
    });
  }, [items, query, filter, verdicts]);

  const scoped = useMemo(
    () => (justCreated ? filteredItems.filter((i) => i.id !== justCreated.id) : filteredItems),
    [filteredItems, justCreated],
  );
  const sections = useMemo(() => sectionItems(scoped), [scoped]);

  // Sorting bypasses the priority sections entirely — "A–Z" / "Recently reviewed" are explicit
  // requests to browse the whole matched set as one flat list, not grouped by ledger state.
  // `null` means "use the default priority sections above" (unchanged behavior).
  const flatSorted = useMemo(() => {
    if (sort === 'default') return null;
    const copy = [...scoped];
    if (sort === 'az') copy.sort((a, b) => a.title.localeCompare(b.title));
    // DR-118: newest first, and an item nothing has ever happened to sorts below every item
    // something has (0 vs a real timestamp). Ties keep the ledger's own order — Array#sort is
    // stable — which is what a row with no activity at all should fall back to.
    else if (sort === 'activity') {
      copy.sort((a, b) => activityAt(b, localState[b.id]) - activityAt(a, localState[a.id]));
    } else copy.sort((a, b) => (verdicts[b.id]?.at ?? -1) - (verdicts[a.id]?.at ?? -1));
    return copy;
  }, [sort, scoped, verdicts, localState]);

  // DR-074: restore once per open, after the list has real content to scroll to — not on every
  // scroll-driven update to scrollDraft.value (the ref guard blocks re-entry once it's run).
  useEffect(() => {
    // The chip rows' own "once per open" reset lives in `useChipReveal`, which resets the same
    // way and for the same reason (RN's Modal returns null while hidden, so its children unmount
    // and everything is measured afresh on the next open).
    if (!visible) {
      restoredScrollRef.current = false;
      // The list is re-sorted and re-filtered between opens, so an offset recorded in one
      // session means nothing in the next. A card left EXPANDED when the sheet closes keeps
      // its anchor otherwise, and collapsing it later scrolls to a position measured against
      // a list that no longer exists.
      expandAnchors.current = {};
      // Same "this sitting is over" reset. `DevTestBubble` stays mounted to render the floating
      // trigger, so without this an unanswered prompt greeted him on the next open, about a
      // fail from a session he had already walked away from.
      setFailQueue([]);
      // DR-123: same "this sitting is over" reset. The menu is closed on every open by design,
      // and leaving it open across a close would also strand `useChipReveal`'s token, which now
      // keys off the menu rather than the sheet.
      setMenuOpen(false);
      return;
    }
    if (restoredScrollRef.current || !scrollDraft.ready || !items.length) return;
    restoredScrollRef.current = true;
    const y = scrollDraft.value;
    if (y > 0) requestAnimationFrame(() => scrollRef.current?.scrollTo({ y, animated: false }));
  }, [visible, items.length, scrollDraft.ready, scrollDraft.value]);

  return (
    <>
      {!visible && !hidden ? <DevTestFloatingTrigger /> : null}

      <Modal visible={visible} animationType="slide" onRequestClose={() => setVisible(false)}>
        <View style={[styles.sheet, { paddingTop: insets.top + space.xs }]}>
          {/* DR-123 — Kamil: "a lot of the top space is taken by options like filter, sort, how
              many shown and hidden, dispatch. Put these all into a three dot or hamburger menu…
              Everything collapsible should be collapsed by default." The fixed header used to be
              six stacked rows (title, capture caption, search, Filter, Sort, Claude) before a
              single card could be seen. It is now two: this row and the search field. Everything
              he named lives behind the ⋮, closed on every open. */}
          <View style={styles.header}>
            <Text variant="heading" style={styles.headerTitle} numberOfLines={1}>Device tests</Text>
            <View style={styles.headerActions} testID="devtest-header-actions">
              <IconButton
                name="plus"
                size={18}
                filled={false}
                color={t.text}
                accessibilityRole="button"
                accessibilityLabel="New issue"
                style={styles.headerIcon}
                onPress={() => setCreating(true)}
              />
              {/* Mint, not muted, whenever anything behind it is off its default: DR-116 was
                  filed because a filter restored from days ago was hiding rows with nothing on
                  screen saying so, and putting the chips behind a menu is exactly the move that
                  could bring that back. The count row below names a NARROWING in words; this one
                  also covers a non-default SORT, which narrows nothing and so has no caption —
                  the case DR-118's row called out as the harder one to diagnose. */}
              <IconButton
                name="more-vertical"
                size={18}
                filled={false}
                color={optionsSummary ? t.mint : t.text}
                accessibilityRole="button"
                accessibilityState={{ expanded: menuOpen }}
                accessibilityLabel={optionsSummary
                  ? `Options — filter, sort and dispatch. ${optionsSummary}`
                  : 'Options — filter, sort and dispatch'}
                testID="devtest-options-toggle"
                style={styles.headerIcon}
                onPress={() => setMenuOpen((v) => !v)}
              />
              <IconButton
                name="x"
                size={20}
                filled={false}
                color={t.muted}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={styles.headerIcon}
                onPress={() => {
                  setVisible(false);
                  setJustCreated(null);
                }}
              />
            </View>
          </View>
          {error ? <Text variant="caption" color={t.danger}>{error}</Text> : null}
          {/* The one capture state that must not be behind the menu: with no native module there
              is no "Attach the captured screen" checkbox on any card, so a tester looking for it
              finds an absence and nothing explaining it (Opus review, PR #479). The other two
              states are reported inside the ⋮ — one of them is the checkbox itself. */}
          {!canScreenshot() ? (
            <Text variant="caption" color={t.muted}>
              Screenshots need a rebuilt dev client (react-native-view-shot).
            </Text>
          ) : null}

          {/* DR-077 — search stays in the header rather than moving into the menu with the rest:
              it is the one control he did not name, and it is how a specific row gets found in a
              list of 120. Filter and sort are mutually independent from it: filter narrows WHICH
              items are in play, sort decides how to browse the result. */}
          <View style={styles.searchRow}>
            <TextInput
              placeholder="Search by id or title"
              placeholderTextColor={t.muted}
              value={query}
              onChangeText={setQuery}
              style={[styles.searchInput, { flex: 1 }]}
              accessibilityLabel="Search device-test items"
            />
            {/* Opus review, PR #387: a persisted search query has no other way to notice it's
                still filtering the list days later — surface a way to clear it right next to
                where it's typed, not just a muted caption below. */}
            {query.length ? (
              <Pressable
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={8}
                style={styles.searchClear}
              >
                <Icon name="x" size={16} color={t.muted} />
              </Pressable>
            ) : null}
          </View>
          {/* DR-116 — "shows 11 of 117. I don't know how to view the rest." The old caption said
              only how many were hidden; it never said BY WHAT, and the only escape was finding
              the responsible chip (possibly scrolled off-screen) or the search field's small ×.
              Name the narrowing and put the way out next to the number.

              DR-123 asked for this count to go into the menu too. It does not, and the reason is
              DR-116 itself: unnarrowed it renders NOTHING (so it costs him no top space, which is
              the actual complaint), and narrowed it is the only thing on screen that says why the
              list is short. Hiding that behind a menu is the state DR-116 was filed about. */}
          {narrowed ? (
            <View style={styles.matchRow} testID="devtest-match-row">
              <Text variant="caption" color={t.muted} style={styles.matchCount}>
                {filteredItems.length} of {items.length} shown · narrowed by {narrowedBy.join(' and ')}
              </Text>
              <SmallButton
                title={`Show all ${items.length}`}
                icon="rotate-ccw"
                // Says what it DOES, not what it is — this is the escape hatch the whole row
                // exists for, and "Show all 117" alone does not say the filter goes with it.
                accessibilityLabel={`Show all ${items.length} items — clears the filter and search`}
                onPress={showEverything}
              />
            </View>
          ) : null}

          {menuOpen ? (
            <View style={styles.menu} testID="devtest-options-menu">
              {/* Opus review, PR #387: two visually identical chip rows with no label read as one
                  confusing group — "Filter"/"Sort" name what each row actually does. The label sits
                  INSIDE the same row View as its chips, and that plain View wrapper is load-bearing,
                  not just compactness: RN's ScrollView base style carries `flexGrow: 1`, so a bare
                  horizontal ScrollView in this flex-column sheet stretches to claim a share of the
                  spare VERTICAL space (Kamil's 2026-08-12 screenshot: two chip rows each filling a
                  third of the screen, the list shoved to the bottom). A View defaults to
                  `flexGrow: 0`, so each row hugs its content height. */}
              <View style={styles.toolbarRow} testID="devtest-filter-toolbar">
                <Text variant="caption" color={t.muted} style={styles.chipRowLabel}>Filter</Text>
                <ScrollView
                  ref={filterChips.scrollRef}
                  // Named so a test asserting "this row scrolled" cannot be satisfied by the OTHER
                  // horizontal row (Opus review, PR #471).
                  testID="devtest-filter-chips"
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterRow}
                >
                  {REVIEW_FILTERS.map((f) => (
                    <ToggleChip
                      key={f.key}
                      label={f.label}
                      active={filter === f.key}
                      onPress={() => setFilter(f.key)}
                      onLayout={(e) => filterChips.rememberX(f.key, e)}
                    />
                  ))}
                </ScrollView>
              </View>
              <View style={styles.toolbarRow} testID="devtest-sort-toolbar">
                <Text variant="caption" color={t.muted} style={styles.chipRowLabel}>Sort</Text>
                <ScrollView
                  ref={sortChips.scrollRef}
                  testID="devtest-sort-chips"
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterRow}
                >
                  {SORT_MODES.map((s) => (
                    <ToggleChip
                      key={s.key}
                      label={s.label}
                      active={sort === s.key}
                      onPress={() => setSort(s.key)}
                      onLayout={(e) => sortChips.rememberX(s.key, e)}
                    />
                  ))}
                </ScrollView>
              </View>
              {/* DR-092: hand the whole pending queue to one Claude session (Kamil's batch pick).
                  Fire-on-tap — dev-only, and the toast + bubble replies make a mis-tap visible. */}
              <View style={styles.dispatchRow} testID="devtest-dispatch-all">
                <Text variant="caption" color={t.muted} style={styles.chipRowLabel}>Claude</Text>
                <ModelPicker model={modelDraft.value} onChange={(m) => modelDraft.setValue(m)} />
                <SmallButton
                  title="Dispatch all"
                  icon="zap"
                  loading={dispatchingAll}
                  disabled={dispatchingAll}
                  onPress={() => {
                    setMenuOpen(false);
                    void fireDispatch(modelDraft.value, undefined, setDispatchingAll);
                  }}
                />
              </View>
              {/* Was a permanent caption under the title. It answers one question — can this
                  sitting attach a screenshot — and when the answer is yes that is already visible
                  as the "Attach the captured screen" checkbox on every card. The one branch that
                  has to be readable WITHOUT opening this menu (the dev client cannot capture at
                  all, so the checkbox he is looking for is missing rather than unticked) is
                  rendered in the header instead — see below. */}
              <Text variant="caption" color={t.muted} style={styles.menuNote}>
                {shot ? 'Screen captured — attach it to any comment below.'
                  : 'No capture this time.'}
              </Text>
            </View>
          ) : null}
          {dispatchStatus ? <DispatchBanner status={dispatchStatus} /> : null}
          <DeployBanner />
          {failPrompt ? (
            <FailPrompt
              itemId={failPrompt}
              model={modelDraft.value}
              onDone={() => setFailQueue((q) => q.slice(1))}
            />
          ) : null}

          {/* DR-076 — the comment field sits directly above the Pass/Fail/Remark row inside this
              same ScrollView, and this whole sheet is a plain RN Modal with no keyboard-avoiding
              scope of its own (DR-072 only fixed the closed-sheet trigger button). Same
              react-native-keyboard-controller wrapper the rest of the app already uses
              (discover.tsx, paper/[slug].tsx) — its keyboard state is global, so it works inside
              a Modal's own native window the same as anywhere else. */}
          <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
            <ScrollView
              testID="devtest-scroll"
              ref={scrollRef}
              contentContainerStyle={styles.scroll}
              onScroll={(e) => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y; }}
              onScrollEndDrag={commitScrollOffset}
              onMomentumScrollEnd={commitScrollOffset}
              scrollEventThrottle={100}
              keyboardShouldPersistTaps="handled"
            >
              {creating ? (
                <NewItemForm
                  shot={shot}
                  route={pathname}
                  onDone={(item) => {
                    setCreating(false);
                    if (item) {
                      setItems((prev) => [item, ...prev]);
                      setJustCreated(item);
                    }
                  }}
                />
              ) : null}
              {justCreated ? (
                <>
                  <View style={styles.justAddedRow}>
                    <Section label="Just added" tone={t.mint} />
                    <Pressable onPress={() => setJustCreated(null)} hitSlop={8} accessibilityLabel="Dismiss">
                      <Icon name="x" size={16} color={t.muted} />
                    </Pressable>
                  </View>
                  <ItemCard
                    key={`new-${justCreated.id}`}
                    item={justCreated}
                    shot={shot}
                    route={pathname}
                    startExpanded
                    onExpandChange={onExpandChange}
                    onFailRecorded={queueFailPrompt} onRecorded={refreshItems}
                    onVerdictChange={reportVerdict}
                    dispatchModel={modelDraft.value}
                  />
                </>
              ) : null}
              {flatSorted ? (
                <>
                  <Section label={`Results (${flatSorted.length})`} tone={t.mint} />
                  {flatSorted.map((i) => (
                    <ItemCard
                      key={i.id}
                      item={i}
                      shot={shot}
                      route={pathname}
                      onVerdictChange={reportVerdict}
                      dispatchModel={modelDraft.value}
                      // DR-118: only under the sort it explains. Elsewhere it is one more line
                      // of chrome on a card that already carries four chips.
                      activity={sort === 'activity' ? activityNote(i, localState[i.id]) : undefined}
                      // This branch renders whenever `sort !== 'default'`, and both of these
                      // were missing from it — so the fail prompt never appeared and no scroll
                      // anchor was recorded under "Last activity", "Recently reviewed" or
                      // "A–Z". "Last activity" is the sort Kamil asked for to work the queue,
                      // which made it the first place the fail prompt was silently dead.
                      onExpandChange={onExpandChange}
                      onFailRecorded={queueFailPrompt} onRecorded={refreshItems}
                    />
                  ))}
                </>
              ) : (
                <>
                  <Section label={`To verify (${sections.verify.length})`} tone={t.mint} />
                  {sections.verify.map((i) => (
                    <ItemCard key={i.id} item={i} shot={shot} route={pathname} onVerdictChange={reportVerdict} dispatchModel={modelDraft.value}
                      onExpandChange={onExpandChange}
                    onFailRecorded={queueFailPrompt} onRecorded={refreshItems} />
                  ))}
                  <Section label={`Open (${sections.open.length})`} tone={t.amber} />
                  {sections.open.map((i) => (
                    <ItemCard key={i.id} item={i} shot={shot} route={pathname} onVerdictChange={reportVerdict} dispatchModel={modelDraft.value}
                      onExpandChange={onExpandChange}
                    onFailRecorded={queueFailPrompt} onRecorded={refreshItems} />
                  ))}
                  {/* DR-116: while a search or filter is narrowing the list, this section is
                      never collapsed. Collapsed, it hides rows the caption above has already
                      COUNTED as shown — the same "where did the rest go?" confusion one level
                      down, and the reason a filter could leave fewer cards on screen than the
                      number he was reading. Unnarrowed it stays a toggle: closed/deferred rows
                      are noise when browsing the whole ledger.

                      `|| narrowed` below is deliberately redundant with the `narrowed` effect
                      above, which is what actually keeps the section open on the way OUT of a
                      narrowed state: it covers only the single commit between narrowing and that
                      effect flushing, so the section cannot flicker shut. Being redundant, it is
                      the one guard here with no test of its own — while narrowed there is no
                      toggle to turn `showRest` back off, so the two can never disagree in a
                      settled render. */}
                  {narrowed ? (
                    <Section label={`Everything else (${sections.rest.length})`} tone={t.muted} />
                  ) : (
                    <Pressable onPress={() => setShowRest((v) => !v)} style={styles.restToggle}>
                      <Section label={`Everything else (${sections.rest.length})`} tone={t.muted} />
                      <Icon name={showRest ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} />
                    </Pressable>
                  )}
                  {showRest || narrowed
                    ? sections.rest.map((i) => (
                        <ItemCard key={i.id} item={i} shot={shot} route={pathname} onVerdictChange={reportVerdict} dispatchModel={modelDraft.value}
                      onExpandChange={onExpandChange}
                    onFailRecorded={queueFailPrompt} onRecorded={refreshItems} />
                      ))
                    : null}
                </>
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}

function Section({ label, tone }: { label: string; tone: string }) {
  // DR-123's margin pass: `space.lg` above every section header was one of the larger fixed
  // costs in a list of ~120 rows.
  return (
    <Text variant="overline" color={tone} style={{ marginTop: space.md, marginBottom: space.xs }}>
      {label}
    </Text>
  );
}


/** Fire a Claude dispatch (fire-on-tap, Kamil's decision): one session for `itemId`, or the
 *  whole pending batch when omitted. Shared by the header's "Dispatch all" and each item card
 *  so both report the same way and hit the same single-flight guard. */
async function fireDispatch(model: DispatchModel, itemId: string | undefined,
                           setBusy: (b: boolean) => void, fresh = false) {
  setBusy(true);
  try {
    const { dispatch } = await api.dispatchToClaude(model, itemId, fresh);
    // The server decides whether this continued a session or started one, and says so — the
    // client cannot know, and guessing here would eventually disagree with what actually ran.
    showToast(dispatch.continued_session
      ? `Claude (${dispatch.model}) is picking ${itemId} back up. Replies land here.`
      : `Claude (${model}) is on ${itemId ?? 'all pending issues'}. Replies land here.`);
    refreshDispatchStatus?.();     // pull the banner forward instead of waiting for the tick
    return dispatch;
  } catch (e) {
    // 409 = a session is already running; the server's message says so plainly.
    showToast((e as Error).message ?? 'Could not dispatch.');
    return null;
  } finally {
    setBusy(false);
  }
}

// The heartbeat poller publishes its refresh here so `fireDispatch` — a module-level helper
// shared by the header and every card — can pull the banner forward the moment a session
// spawns, rather than leaving it blank until the next tick. Same module-level handoff the
// sheet opener above uses.
let refreshDispatchStatus: (() => void) | null = null;

/** Poll the dispatch heartbeat while the sheet is open.
 *
 *  The polling interval follows the state: a live session is worth watching closely, but a
 *  finished record never changes again, so continuing to hit it every few seconds would be
 *  pure noise against a dev server that is also serving the reader.
 *
 *  A failed poll resolves to the previous value rather than surfacing an error — this is a
 *  status ornament, and an unreachable dev server already shows up in the item list above.
 */
function useDispatchHeartbeat(visible: boolean): DispatchStatus | null {
  const [status, setStatus] = useState<DispatchStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const tick = async () => {
      // Cleared up front so an out-of-band refresh() mid-cycle re-arms once, not twice.
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      let next: DispatchStatus | null = null;
      try {
        next = (await api.getDispatchStatus()).dispatch;
        if (!cancelled) setStatus(next);
      } catch {
        // keep the last known state on the screen
      }
      if (cancelled) return;
      timer.current = setTimeout(() => void tick(), next?.state === 'running' ? 5000 : 30000);
    };
    void tick();
    const refresh = () => void tick();
    refreshDispatchStatus = refresh;
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      // Only de-register if we are still the registered one. Clearing unconditionally is
      // last-writer-wins, and a transient second mount's cleanup would then de-register the
      // survivor, leaving the banner without its post-dispatch refresh — the same shape the
      // `sheetOpener` guard and the `adjustBubbleMounts` counter above already exist to avoid.
      if (refreshDispatchStatus === refresh) refreshDispatchStatus = null;
    };
  }, [visible]);

  return status;
}

/** How much of a description shows before "Show details". Enough to tell items apart, short
 *  enough that the verdict row stays on screen. */
const DETAIL_PREVIEW_LINES = 3;

/** The prompt a fail raises: recording it and acting on it used to be two gestures a screen
 *  apart, and the gap is where a fail sits — DR-009's waited ten hours because nothing carried
 *  it anywhere.
 *
 *  It clears ONLY when a dispatch is actually accepted. `fireDispatch` swallows its own errors
 *  and resolves either way, so dismissing on `.then` treated a refusal as a hand-off — and a
 *  refusal is the EXPECTED answer while another session is running, which is most of the time
 *  once you are working a queue of fails. That left the card looking exactly like the
 *  successful case with the fail carried nowhere: the gap this exists to close, with the UI
 *  now asserting the opposite. */
function FailPrompt({ itemId, model, onDone }: {
  itemId: string; model: DispatchModel; onDone: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);

  return (
    <View style={styles.failPrompt} testID="devtest-fail-prompt">
      <Text variant="caption" color={t.text}>
        {itemId} failed. Hand it to Claude now?
      </Text>
      <Text variant="caption" color={t.muted}>
        It continues the session that already worked this item when there is one, so it starts
        from your comment rather than from scratch.
      </Text>
      <View style={styles.failPromptRow}>
        <SmallButton
          title={`Dispatch (${model})`}
          icon="zap"
          variant="primary"
          loading={busy}
          disabled={busy}
          testID="devtest-fail-prompt-dispatch"
          onPress={() => {
            void fireDispatch(model, itemId, setBusy).then((d) => {
              // Only a real dispatch dismisses this. A refusal leaves it up, because trying
              // again once the running session replies is the correct next action.
              if (d) onDone();
            });
          }}
        />
        <SmallButton
          title="Not now"
          disabled={busy}
          testID="devtest-fail-prompt-dismiss"
          onPress={onDone}
        />
      </View>
    </View>
  );
}

/** How long to wait before re-reading state after a deploy: the server checkout moves in a
 *  detached child a couple of seconds later, so an immediate re-read sees the old answer. */
const DEPLOY_SETTLE_MS = 4000;

/** The banner for "merged, but not on this phone yet".
 *
 *  A merged PR moves `origin/main` and nothing a reader can see. Until the device worktree
 *  Metro serves and the server checkout follow it, reloading the app gets the old build from
 *  the old ledger — which on 2026-09-01 left DR-116 merged and invisible for over an hour with
 *  nothing on the phone to explain why. This says so, and deploys in one tap.
 *
 *  Renders nothing when the phone is level with `main`, which is the normal state. */
export function DeployBanner() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [state, setState] = useState<DeployState | null>(null);
  const [busy, setBusy] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [postDeployNpmCi, setPostDeployNpmCi] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const load = useCallback(async () => {
    try {
      setDeployed(false);
      setState((await api.getDeployState()).deploy);
    } catch {
      setState(null);   // dev-only ornament; a stale server just means no banner
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const behind = Math.max(state?.device_behind ?? 0, state?.server_behind ?? 0);
  // `last_error` matters even at zero behind: the deferred half of a deploy can fail after the
  // response said it was under way, and that failure has nowhere else to surface.
  if (!state || (behind <= 0 && !state.last_error)) return null;

  const blocker = state.active_dispatch
    ? `Claude is still working (${state.active_dispatch})`
    : state.active_job
    ? `a background job is running (${state.active_job})`
    : !state.clean ? 'the server checkout has uncommitted changes'
    : !state.device_present ? 'the worktree Metro serves is missing'
    // Deploy only advances the server checkout FROM main; on any other branch it refuses,
    // because switching a tree someone is working in is the thing it exists to stop. Without
    // this clause the banner offered "Deploy and reload" into a guaranteed 409 — a repeatable
    // dead end with nothing on the phone to explain it.
    //
    // Keyed on server !== target, NOT on `server_behind`, for the reason `backend_restarting`
    // spells out on the server side: a feature branch that already CONTAINS origin/main is zero
    // behind while still differing from it, which is the ordinary shape of a rebased branch —
    // and precisely the case where deploy refuses and the button must not be offered.
    : state.server !== state.target && state.server_branch && state.server_branch !== 'main'
      ? `the server checkout is on ${state.server_branch}, not main`
    : !state.deployable ? 'this is the public tunnel; use the tailnet address'
    : null;

  return (
    <View style={[styles.dispatchBanner, { backgroundColor: t.amberWash, borderColor: t.amber }]}
          testID="devtest-deploy-banner">
      <View style={styles.dispatchBannerHead}>
        <Icon name="upload-cloud" size={14} color={t.amber} />
        <Text variant="caption" color={t.text} style={styles.dispatchBannerTitle}>
          {behind <= 0 ? 'Last deploy did not finish'
            : behind === 1 ? '1 merged change not on this phone yet'
            : `${behind} merged changes not on this phone yet`}
        </Text>
      </View>
      {state.target_subject ? (
        <Text variant="caption" color={t.muted} numberOfLines={2}>{state.target_subject}</Text>
      ) : null}
      {state.last_error ? (
        <Text variant="caption" color={t.danger} numberOfLines={2}>
          Last deploy failed: {state.last_error}
        </Text>
      ) : null}
      {state.needs_npm_ci || postDeployNpmCi ? (
        <Text variant="caption" color={t.muted}>
          Touches mobile’s lockfile — run `npm ci` in the device worktree before reloading.
        </Text>
      ) : null}
      {deployed ? (
        <Text variant="caption" color={t.muted}>
          Deploying… {postDeployNpmCi ? 'run `npm ci`, then reload' : 'reload the app in a moment'}.
        </Text>
      ) : blocker ? (
        <Text variant="caption" color={t.muted}>Cannot deploy: {blocker}.</Text>
      ) : (
        <SmallButton
          title="Deploy and reload"
          icon="upload-cloud"
          loading={busy}
          disabled={busy}
          style={styles.bannerButton}
          testID="devtest-deploy-now"
          onPress={() => {
            setBusy(true);
            void api.deployNow()
              .then((r) => {
                showToast(r.deploy.needs_npm_ci
                  // Said HERE and not only before the deploy: afterwards the server recomputes
                  // this over an empty range, so the warning would vanish at exactly the moment
                  // it applies — and "reload the app" into a bundle that cannot build.
                  ? 'Deployed, but mobile deps changed — run `npm ci` in the device worktree '
                    + 'before reloading.'
                  : r.deploy.backend_restarting
                    ? 'Deployed. The server is restarting — reload the app in a moment.'
                    : 'Deployed. Reload the app to pick it up.');
                setPostDeployNpmCi(r.deploy.needs_npm_ci);
                // The deferred half moves the server checkout a couple of seconds from now, so
                // reloading immediately would re-read the OLD state and leave the banner up
                // with a live button — a second tap would race a second child.
                setDeployed(true);
                if (settleTimer.current) clearTimeout(settleTimer.current);
                settleTimer.current = setTimeout(() => void load(), DEPLOY_SETTLE_MS);
              })
              .catch((e: Error) => showToast(e.message ?? 'Could not deploy.'))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </View>
  );
}

/** How often the Resume button re-checks whether its window has reopened. Short enough that
 *  the countdown does not look stuck, long enough to be free. */
const RESUME_READY_POLL_MS = 15000;

/** "in 48m", "in 2h 10m", or "now" once the window has reopened. */
function formatUntil(resetsAt: number | null | undefined): string {
  if (!resetsAt) return 'soon';
  const secs = resetsAt - Date.now() / 1000;
  // Under a minute reads as "now": `formatElapsed` renders sub-second as "just started", which
  // is nonsense pointed at the future.
  if (secs < 60) return 'now';
  return `in ${formatElapsed(secs)}`;
}

/** "22m", "1h 04m" — a duration a glance can read, not a precise one. */
function formatElapsed(seconds: number | null): string {
  if (!seconds || seconds < 1) return 'just started';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** The dispatch heartbeat, shown under the Dispatch row whenever a session has ever run.
 *
 *  This is the whole point of the status route: a dispatched session works for tens of minutes
 *  on a feature-sized item, and until now the bubble said nothing at all after the spawn toast.
 *  It shows what the session is doing (`last_step`), that it is still moving (`steps`), and —
 *  the case that used to be invisible — that it ended, well or badly.
 *
 *  DR-121 — Kamil: "The dispatch status takes up too much space. It should be hideable.
 *  Specially the details should collapse. When dispatch is not active, ideally we should be able
 *  to see no status. When it's active, then the collapsible UI should appear." It lives in the
 *  sheet's FIXED header, above the scrolling list, so its four-to-six lines were costing a fifth
 *  of the sheet permanently — including for a session that finished days ago. So:
 *
 *  - it collapses to its one-line headline, and opens itself only while the session is ACTIVE
 *    (running, or rate-limited and waiting to be resumed) — which is his "when it's active, the
 *    collapsible UI should appear";
 *  - a finished/failed/gone one can be DISMISSED outright, which is his "see no status", and the
 *    dismissal persists so closing the sheet does not bring it back. It is keyed on the
 *    dispatch's id AND state, so the next dispatch — or this one changing state — shows up
 *    regardless. That is why the terminal case is dismissable rather than auto-hidden: DR-092
 *    exists because a session that died silently looked identical to one still working, and an
 *    ending that hides itself before it has been read would re-create exactly that. */
export function DispatchBanner({ status }: { status: DispatchStatus }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const running = status.state === 'running';
  const limited = status.state === 'rate_limited';
  const bad = status.state === 'failed' || status.state === 'gone';
  // Amber, not red: nothing is broken, the account is out of window. Colouring it as a failure
  // would send you looking for a defect that is not there.
  const tint = running ? t.violet
    : limited ? t.amber
    : status.state === 'finished' ? t.mint : t.danger;
  const wash = running ? t.violetWash
    : limited ? t.amberWash
    : status.state === 'finished' ? t.mintWash : t.dangerWash;
  const target = status.item_id ?? 'all pending issues';
  const headline = running
    ? `${status.model} is on ${target}`
    : limited ? `${status.model} hit the usage limit on ${target}`
    : status.state === 'finished' ? `${status.model} finished ${target}`
    : status.state === 'failed' ? `${status.model} failed on ${target}`
    // `gone` is the one that most needs saying out loud: nothing was written, so no reply is
    // coming and waiting longer will not help.
    : `${status.model} stopped without replying (${status.ended_reason ?? 'no output'})`;
  // Prefer the model's own turn summary over the raw tool call — it reads as a sentence.
  const detail = running ? (status.last_summary ?? status.last_step)
    : limited ? `The window reopens ${formatUntil(status.rate_limit?.resets_at)}. Resuming keeps everything it had worked out.`
    : status.result?.text;

  // One dispatch in one state. A resume, or this session ending, produces a different key, so
  // neither a dismissal nor a manual collapse can outlive the thing it was about.
  const key = `${status.id}:${status.state}`;
  // Active = worth watching, so it opens itself; anything ended starts as its one-line headline.
  const active = running || limited;
  const [override, setOverride] = useState<{ key: string; open: boolean } | null>(null);
  const open = override?.key === key ? override.open : active;
  const dismissal = usePersistedDraft<{ key: string | null }>(
    draftKey('devtest-dispatch-banner-dismissed'), { key: null },
  );
  // Only an ENDED dispatch can be dismissed. Dismissing a running one would hide the heartbeat
  // while the session is still spending, and dismissing a rate-limited one would hide the Resume
  // button that is the only way to pick it back up.
  const dismissable = !active;
  // Render nothing until the stored dismissal has loaded: the fallback is "not dismissed", so
  // rendering early would flash a banner he has already dismissed onto the sheet every open.
  if (!dismissal.ready) return null;
  if (dismissal.value.key === key) return null;

  return (
    <View style={[styles.dispatchBanner, { backgroundColor: wash, borderColor: tint }]}
          testID="devtest-dispatch-status">
      {/* Two SIBLING controls, not one inside the other. `Pressable` sets `accessible` on
          itself, so a dismiss button nested in the toggle would sit inside an element that has
          already declared itself a single labelled button — and the toggle's own explicit label
          replaces its children's announcement, so the × would be unreachable to a screen reader
          with nothing naming it (Opus review, PR #475). Siblings also take the Android touch
          negotiation out of the picture entirely. */}
      <View style={styles.dispatchBannerHead}>
        <Pressable
          onPress={() => setOverride({ key, open: !open })}
          accessibilityRole="button"
          // An explicit label on a Pressable replaces what its children would have announced, so
          // the headline has to be repeated here (the same trap as the card header above).
          accessibilityLabel={`${headline}. ${formatElapsed(status.elapsed_s)}. Tap to ${open ? 'hide' : 'show'} details.`}
          style={styles.dispatchBannerToggle}
          testID="devtest-dispatch-status-toggle">
          <View style={styles.dispatchBannerHead}>
            <Icon name={running ? 'zap' : bad ? 'alert-triangle' : 'check'} size={14} color={tint} />
            {/* One line, and it must ELLIPSIZE rather than wrap: "one line collapsed" is the
                whole measure DR-121 is about, and the longest headlines ("… stopped without
                replying (process gone)") wrap to two on a 360dp phone. */}
            <Text variant="caption" color={t.text} numberOfLines={1}
                  style={styles.dispatchBannerTitle}>{headline}</Text>
            <Text variant="caption" color={t.muted}>{formatElapsed(status.elapsed_s)}</Text>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={t.muted} />
          </View>
        </Pressable>
        {dismissable ? (
          <Pressable
            // `setValue` alone would be lost: its write is debounced 300ms, and closing the
            // sheet unmounts the Modal's children, which cancels the pending write — the same
            // trap the verdict draft hit in PR #380. `setValue` updates the ref synchronously,
            // so `markSubmitted` flushes the new value to storage at once.
            onPress={() => {
              dismissal.setValue({ key });
              void dismissal.markSubmitted();
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss this dispatch status"
            testID="devtest-dispatch-status-dismiss">
            <Icon name="x" size={14} color={t.muted} />
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <>
          {detail ? (
            // DR-128 — Kamil, of this very line: "the details text seem to expect markdown
            // rendering but none is happening." A session's closing recap is written as
            // markdown, and it was the raw source. Same two-line clamp; nested runs keep it.
            <Text variant="caption" color={t.muted} numberOfLines={2}
                  testID="devtest-dispatch-status-detail">
              <MarkdownRuns text={detail} />
            </Text>
          ) : null}
          <Text variant="caption" color={t.muted}>
            {status.steps > 0 ? `${status.steps} steps` : 'no step detail'}
            {status.result?.num_turns ? ` · ${status.result.num_turns} turns` : ''}
            {/* Refused steps are the DR-092 failure mode: a headless session cannot ask, so a
                denial is final and the session looks idle rather than blocked. */}
            {status.result?.denials ? ` · ${status.result.denials} refused` : ''}
            {running || limited ? '' : ' · check the item below for its reply'}
          </Text>
        </>
      ) : null}
      {/* Outside the collapse: Resume is the one ACTION this banner carries, and a collapsed
          rate-limited session that hid its own way forward would be the DR-092 failure again. */}
      {status.resumable ? <ResumeButton status={status} /> : null}
    </View>
  );
}

/** Pick a rate-limited session back up. Deliberately a manual tap rather than an automatic
 *  retry: resuming spends the freshly-reopened window, and which job that goes to is Kamil's
 *  call, not the client's. Enabled once the window has reopened — pressing early only earns
 *  another refusal. */
function ResumeButton({ status }: { status: DispatchStatus }) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const resetsAt = status.rate_limit?.resets_at ?? 0;
  // Recomputed on a tick rather than armed once. A single setTimeout for the real wait is hours
  // long: RN throttles timers that far out and warns about them, and a backgrounded app may
  // never fire it at all — so the button could sit disabled at "Resume in 2h 10m" forever while
  // the poll beside it was delivering fresh data.
  const [, tick] = useState(0);
  // The same 60s grace `formatUntil` uses. Comparing against the exact instant left the button
  // reading "Resume now" while still disabled — it looked broken rather than early.
  const ready = !resetsAt || resetsAt - Date.now() / 1000 < 60;

  useEffect(() => {
    if (ready) return;
    const timer = setInterval(() => tick((n) => n + 1), RESUME_READY_POLL_MS);
    return () => clearInterval(timer);
  }, [ready]);

  return (
    <SmallButton
      title={ready ? 'Resume where it stopped' : `Resume ${formatUntil(resetsAt)}`}
      icon="play"
      loading={busy}
      disabled={busy || !ready}
      style={styles.bannerButton}
      testID="devtest-dispatch-resume"
      onPress={() => {
        setBusy(true);
        void api.resumeDispatch(status.model)
          .then(() => {
            showToast(`${status.model} is picking up where it stopped.`);
            refreshDispatchStatus?.();
          })
          .catch((e: Error) => showToast(e.message ?? 'Could not resume.'))
          .finally(() => setBusy(false));
      }}
    />
  );
}

/** A compact model selector — the same chip vocabulary the toolbar rows use. */
function ModelPicker({ model, onChange }: {
  model: DispatchModel; onChange: (m: DispatchModel) => void;
}) {
  const t = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexDirection: 'row', gap: space.xs, paddingVertical: space.xs }}>
      {DISPATCH_MODELS.map((m) => (
        <ToggleChip key={m} label={m} active={model === m} onPress={() => onChange(m)} />
      ))}
      <Text variant="caption" color={t.muted} style={{ alignSelf: 'center', marginLeft: space.xs }}>
        model
      </Text>
    </ScrollView>
  );
}

// One control for "include the captured screen", shared by the new-issue form and the
// per-item remark row so the affordance and its accessibility stay identical.
function AttachToggle({ attach, onToggle }: { attach: boolean; onToggle: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onToggle}
      style={styles.attachRow}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: attach }}
      accessibilityLabel="Attach the captured screen"
    >
      <Icon name={attach ? 'check-square' : 'square'} size={16} color={t.mint} />
      <Text variant="caption" color={t.text}>Attach the captured screen</Text>
    </Pressable>
  );
}

/** The toast suffix for a submission that asked for a screenshot — from the SERVER's answer,
 *  not the request's intent: a dropped image (too large, invalid, disk error) otherwise gets
 *  announced as "with screenshot" while triage finds nothing. */
function screenshotOutcome(
  wanted: boolean,
  saved: string | null | undefined,
  error: string | undefined,
): string {
  if (!wanted) return '';
  if (saved) return ' with screenshot';
  return ` — but the screenshot did not land (${error ?? 'unknown reason'})`;
}

interface NewItemDraft { title: string; description: string }
const NEW_ITEM_DRAFT_FALLBACK: NewItemDraft = { title: '', description: '' };

// Exported for a direct persistence test (DR-065), same reasoning as ItemCard above.
export function NewItemForm({ shot, route, onDone }: {
  // DR-088: the captured screen attaches at creation. Needing a follow-up remark for the
  // screenshot is what produced accidental Pass verdicts on brand-new issues.
  shot?: string | null; route?: string; onDone: (item: DevTestItem | null) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // DR-065: an unfinished new-issue draft used to vanish the moment the sheet closed (Modal
  // unmount kills local useState) — the same persisted-draft pattern the notes screen already
  // uses for exactly this failure mode.
  const draft = usePersistedDraft<NewItemDraft>(draftKey('devtest-new-item'), NEW_ITEM_DRAFT_FALLBACK);
  const [busy, setBusy] = useState(false);
  // Deliberately NOT in the persisted draft: the capture is per-open, so a checked state
  // surviving to a later session would attach a DIFFERENT screen's pixels to this issue —
  // misleading evidence is worse than re-ticking a checkbox.
  const [attach, setAttach] = useState(false);
  return (
    <View style={styles.card}>
      <Text variant="label">New issue</Text>
      <TextInput
        placeholder="What's wrong / what's the idea?"
        placeholderTextColor={t.muted}
        value={draft.value.title}
        onChangeText={(title) => draft.setValue((v) => ({ ...v, title }))}
        style={styles.input}
      />
      <TextInput
        placeholder="Steps, context, expectations (optional)"
        placeholderTextColor={t.muted}
        value={draft.value.description}
        onChangeText={(description) => draft.setValue((v) => ({ ...v, description }))}
        multiline
        style={[styles.input, styles.inputTall]}
      />
      {shot ? <AttachToggle attach={attach} onToggle={() => setAttach((v) => !v)} /> : null}
      <View style={styles.row}>
        <SmallButton
          title="Create"
          icon="check"
          variant="primary"
          loading={busy}
          disabled={!draft.value.title.trim()}
          onPress={async () => {
            setBusy(true);
            try {
              const wantedShot = !!(attach && shot);
              const res = await api.createDevTestItem(
                draft.value.title.trim(), draft.value.description.trim() || undefined,
                wantedShot ? { screenshot_b64: shot, route } : undefined,
              );
              const { item } = res;
              showToast(`Issue recorded for triage${
                screenshotOutcome(wantedShot, res.screenshot, res.screenshot_error)}.`);
              await draft.clear(NEW_ITEM_DRAFT_FALLBACK);
              onDone(item);
            } catch (e) {
              showToast((e as Error).message ?? 'Could not create the issue.');
              onDone(null);
            } finally {
              setBusy(false);
            }
          }}
        />
        <SmallButton title="Cancel" onPress={() => {
          void draft.clear(NEW_ITEM_DRAFT_FALLBACK);
          onDone(null);
        }} />
      </View>
    </View>
  );
}

interface ItemCardDraft {
  expanded: boolean; comment: string; attach: boolean;
  // DR-118: when this card was last EXPANDED — "the last item I opened", which is a fact only
  // the phone holds. Written on open, never on collapse: closing a card is not a visit.
  openedAt?: number;
  // DR-075: "besides the 'Notes' [count], Pass and Fail feedback too should have some
  // indication... this helps me see what next to test." A remark already shows via the
  // feedback_count chip; this is the same idea for a verdict already given THIS session.
  verdict?: 'pass' | 'fail';
  // DR-077: WHEN the verdict landed, not just what it was — "Recently reviewed" sort needs this,
  // and it's the same field either way, so it's not worth a second persisted key.
  verdictAt?: number;
}

// Exported for a direct persistence test (DR-065) — mounting the whole bubble to reach one
// card would mean mocking the network fetch just to get here.
export function ItemCard({ item, shot, route, startExpanded = false, onVerdictChange,
                          dispatchModel, activity, onExpandChange, onFailRecorded,
                          onRecorded }: {
  item: DevTestItem; shot: string | null; route: string; startExpanded?: boolean;
  /** Told when this card opens or closes, so the list can restore the reading position it
   *  had before all that content appeared. */
  onExpandChange?: (expanded: boolean, id: string) => void;
  /** Told when a FAIL lands, so the sheet can raise the hand-it-over prompt. Raised there
   *  rather than here because recording a verdict re-filters the list, which can unmount this
   *  card in the same commit. */
  onFailRecorded?: (id: string) => void;
  /** DR-134: a verdict or comment just changed what the SERVER thinks is unanswered, and that
   *  is not derivable here — the sheet has to re-ask. Fires after a successful record only. */
  onRecorded?: () => void;
  /** DR-118: "You opened it · 2h ago" and friends — what the "Last activity" sort ordered this
   *  card by. Undefined under every other sort, where it would be noise. */
  activity?: string;
  // DR-077: reports this card's own verdict up to the list so filtering/sorting can see it the
  // instant it changes, without waiting for the sheet to close and reopen.
  onVerdictChange?: (id: string, info: VerdictInfo | undefined) => void;
  // DR-092: the model the bubble's picker currently holds — this card's Dispatch uses it.
  // Optional so the DR-065 persistence test can mount a card without the whole bubble.
  dispatchModel?: DispatchModel;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // ONE flag across both dispatch buttons. Separate flags left "fresh" enabled while the
  // ordinary dispatch was in flight, and the second tap earned a raw single-flight 409 toast
  // rather than doing nothing.
  const [dispatching, setDispatching] = useState<'item' | 'fresh' | null>(null);
  // DR-065: "which item was opened, any unfinished message... full resumption of previous
  // state" — closing the sheet (or the app dying) used to lose whichever card was expanded and
  // whatever remark was half-typed, since it was plain useState inside a Modal. Keyed per item
  // id so several cards can each keep their own in-progress remark independently, same as the
  // notes screen's drafts.
  const draft = usePersistedDraft<ItemCardDraft>(
    draftKey('devtest-item', item.id),
    { expanded: startExpanded, comment: '', attach: false },
  );
  const { expanded, comment, attach, verdict: lastVerdict, verdictAt } = draft.value;
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<DevTestFeedbackEntry[] | null>(null);
  // Not persisted: "collapsed" is the right state to come back to every time, and remembering
  // per item would recreate the wall of text on exactly the cards he reads most.
  const [details, setDetails] = useState(false);
  // The description as one plain string. DR-128 gave the visible preview its formatting back
  // (`MarkdownRuns` below), so this is now only for the toggle's `accessibilityLabel`, which
  // must be a string. Memoized per description because the whole list re-renders on a verdict.
  const detailPreview = useMemo(() => markdownToPlain(item.how_to_test), [item.how_to_test]);

  // DR-077: only report once the persisted load has actually resolved — reporting the fallback
  // (undefined) value during the one render before `ready` flips would transiently clobber a
  // verdict the parent already knows about from its own bulk `loadLocalItemState` read on open.
  useEffect(() => {
    if (!draft.ready) return;
    onVerdictChange?.(item.id, lastVerdict ? { verdict: lastVerdict, at: verdictAt ?? 0 } : undefined);
  }, [item.id, draft.ready, lastVerdict, verdictAt, onVerdictChange]);

  // DR-118: expanding stamps the visit; collapsing leaves the stamp alone, so "when did I last
  // open this" is not overwritten by the tap that closes it a second later.
  // EVERY open/close goes through here. A Pass/Fail used to collapse the card by writing
  // `expanded: false` straight into the draft inside `send`, which meant the commonest way a
  // card closes — the one that follows reading the whole thing — skipped both the scroll
  // restore and the details reset entirely. That is the same divergence PR #380's review found
  // in this function between `clear()` and `setValue`; one helper so it cannot happen a third
  // time.
  //
  // Kamil, 2026-09-02: "when I collapse the issue, I have to scroll up." Expanding adds screens
  // of content BELOW the header, so the reading position drifts far down; collapsing removes it
  // again and leaves the list scrolled past where he started. Hand the offset he was at to the
  // list, which puts him back there when this card closes.
  const setExpanded = useCallback((next: boolean) => {
    onExpandChange?.(next, item.id);
    if (!next) setDetails(false);   // reopening starts collapsed again
    draft.setValue((v) => (
      next ? { ...v, expanded: true, openedAt: Date.now() } : { ...v, expanded: false }
    ));
  }, [draft, item.id, onExpandChange]);
  const setComment = (next: string) => draft.setValue((v) => ({ ...v, comment: next }));
  const setAttach = (next: boolean) => draft.setValue((v) => ({ ...v, attach: next }));

  const send = async (verdict: 'pass' | 'fail' | 'remark') => {
    // DR-088: a screenshot alone is a valid remark. Requiring words on top of it pushed the
    // tester toward Pass/Fail (which didn't complain) just to get the screenshot through.
    if (verdict === 'remark' && !comment.trim() && !(attach && shot)) {
      showToast('A comment needs some text or an attached screenshot.');
      return;
    }
    setBusy(true);
    try {
      const wantedShot = !!(attach && shot);
      const { entry } = await api.recordDevTestFeedback({
        item_id: item.id,
        verdict,
        comment: comment.trim() || undefined,
        route,
        screenshot_b64: wantedShot ? shot : undefined,
      });
      // DR-123: `remark` is the wire word; "comment" is the one he is shown, matching the button
      // he just pressed. A toast that named a third thing is how the vocabulary drifted.
      showToast(`${item.id}: ${verdict === 'remark' ? 'comment' : verdict} recorded${
        screenshotOutcome(wantedShot, entry.screenshot, entry.screenshot_error)}.`);
      onRecorded?.();
      // Nothing left to resume once a verdict lands, but DR-075 wants the fact that a pass/fail
      // was already given to survive close/reopen (a remark leaves no verdict, so it doesn't
      // touch whatever verdict already exists). `clear()` DELETES the persisted entry — it
      // would drop the verdict the next time this card mounts fresh, so this uses `setValue`
      // (which actually persists) instead, resetting only the ephemeral fields.
      // A FAIL is the one verdict that asks for work, so it raises a prompt to hand it over —
      // but the prompt belongs to the SHEET, not to this card. Recording a verdict re-runs the
      // list's filter, and under "Not reviewed" (the flow DR-077 exists for) that unmounts this
      // card immediately, taking any local prompt with it before it could be seen. It also lets
      // the card keep its ordinary collapse, so nothing about a fail is written to the
      // persisted draft that a later mount would restore without the prompt that justified it.
      if (verdict !== 'remark') setExpanded(false);
      if (verdict === 'fail') onFailRecorded?.(item.id);
      draft.setValue((v) => ({
        // A remark is a COMMENT, and the card used to collapse on submit with the history list
        // untouched — so the note you had just written vanished and nothing said it had landed.
        // Kamil, 2026-09-02: "I can't be sure if my comments are actually being placed. I don't
        // see them after remarking." They were being placed; the card just closed over them.
        // A pass/fail still collapses: that finishes with the item, and DR-077's queue wants it
        // out of the way.
        // `setExpanded(false)` above already wrote the collapse for a verdict; this literal
        // replaces the whole draft, so it has to carry the same value rather than contradict it.
        expanded: verdict === 'remark', comment: '', attach: false,
        verdict: verdict === 'remark' ? v.verdict : verdict,
        verdictAt: verdict === 'remark' ? v.verdictAt : Date.now(),
        // Carried, not reset: this literal replaces the whole draft, and DR-118's visit stamp is
        // durable state like the verdict beside it, not one of the ephemeral fields above.
        openedAt: v.openedAt,
      }));
      // Opus review, PR #380: `setValue`'s write is debounced 300ms, but tapping the card closed
      // right after Pass/Fail unmounts `ItemCard` (the Modal renders no children while hidden),
      // which cancels the pending write outright — losing the exact verdict DR-075 exists to
      // keep. `markSubmitted` writes `valueRef.current` (already updated by `setValue` above,
      // synchronously) to AsyncStorage immediately, so there's nothing left for an unmount to cancel.
      await draft.markSubmitted();
      // Show it. Always after a remark (the card stays open, so the note must appear in it),
      // and otherwise only when the history is already on screen — loading it unasked for a
      // pass would spend a request per card on something nobody is looking at.
      if (verdict === 'remark' || history !== null) {
        try {
          setHistory((await api.getDevTestFeedback(item.id)).entries);
        } catch {
          // Recording is what mattered and it succeeded; the list can wait for a reopen.
        }
      }
    } catch (e) {
      showToast((e as Error).message ?? 'Could not record feedback.');
    } finally {
      setBusy(false);
    }
  };

  const verdictColor = lastVerdict === 'pass' ? t.mint : lastVerdict === 'fail' ? t.danger : null;

  return (
    <View style={[styles.card, verdictColor ? { borderColor: verdictColor } : null]}>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        accessibilityRole="button"
        // The activity note is a child Text, and an explicit label on the Pressable replaces
        // whatever its children would have read out — so it has to be repeated here or it is
        // invisible to a screen reader under the one sort that shows it.
        // The full state, not `shortState`'s abbreviation: a screen reader has no width problem,
        // and it is the one place the exact ledger word still has to be reachable.
        accessibilityLabel={`${item.id}: ${item.title}. ${item.state}.${activity ? ` ${activity}.` : ''} Tap to ${expanded ? 'collapse' : 'leave a pass, fail, or comment'}.${lastVerdict ? ` Already ${lastVerdict === 'fail' ? 'failed' : 'passed'} this session.` : ''}`}
      >
        {/* DR-123 — Kamil: "'Implemented -- verify' is too big. The PR or whatever name doesn't
            need to be always visible."
            The head was five bordered chips (id, state, notes, replies, verdict) that wrapped to
            two rows on a phone before the title had been read. It is now the title, with ONE
            muted line under it carrying the same facts as words. The id — the "PR or whatever
            name" — moves into the expanded body, which is where it is actually used (naming the
            item to a dispatch, or matching a reply that mentions it); search still matches it
            whether or not it is on screen. */}
        <View style={styles.cardHead}>
          <Text variant="body" numberOfLines={expanded ? undefined : 2} style={styles.cardTitle}>
            {item.title}
          </Text>
          {/* Nothing else on a collapsed card hints it's tappable (DR-061) — this chevron is
              the only affordance, so it has to be unambiguous on its own. */}
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={t.muted} />
        </View>
        <Text
          variant="caption"
          color={verdictColor ?? stateTone(item.state, t)}
          style={styles.cardMeta}
          // Two, not one: at a large OS font scale a fully populated line outruns a 360dp card,
          // and one line would drop its tail. It only ever takes the second line when it needs it.
          numberOfLines={2}>
          {cardMeta(item, lastVerdict)}
        </Text>
        {activity ? (
          <Text variant="caption" color={t.muted} style={styles.activity}>{activity}</Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <>
          {/* The id and the date, once the card is open — see the head's note above. */}
          <Text variant="caption" color={t.muted} style={styles.cardId}>
            {item.id}{item.raised ? ` · raised ${item.raised}` : ''}
          </Text>
          {/* Kamil, 2026-09-02: "the description, after it is fixed, should start collapsed."
              These run to whole screens of triage prose — the thing he opens a card FOR is the
              verdict row and the notes, and the description was pushing both below the fold. */}
          {/* DR-120 — Kamil, 2026-09-02: "the description seems like an unformatted plain text
              jumble with links etc not formatted." It is a ledger EVIDENCE cell, which is the
              densest markdown in the file (bold, PR links, backticked paths), and it was the one
              body of text in this card rendered as raw `<Text>` while an agent reply three
              elements below it went through `<Markdown>`. Expanded, it now uses the same
              renderer — and it sits OUTSIDE the toggle's Pressable, because a Pressable ancestor
              swallows the taps on the links that renderer just made tappable.
              The collapsed preview stays a single `<Text>`: `numberOfLines` is what bounds it to
              three lines and only one Text honours it. Rendering the raw source there would
              leave the FIRST thing he sees still a jumble, so it gets the prose with the syntax
              taken out. */}
          {item.how_to_test ? (
            details ? (
              <>
                <View style={styles.howBody} testID="devtest-item-details-body">
                  {/* DR-123 — Kamil, on DR-120's own question ("say the word and I will keep the
                      formatting but put it back to the smaller size"): "Reduce issues font. All.
                      Descriptions comments etc." He said the word. The formatting stays; the
                      reading scale drops to roughly the card's own type size. */}
                  <Markdown text={item.how_to_test} textScale={BUBBLE_TEXT_SCALE} />
                </View>
                <Pressable
                  onPress={() => setDetails(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Hide details"
                  testID="devtest-item-details">
                  <Text variant="caption" color={t.violet} style={styles.how}>Hide details</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={() => setDetails(true)}
                accessibilityRole="button"
                // This file's own note at the card header: an explicit label on a Pressable
                // REPLACES whatever its children would have announced, so the prose has to be
                // carried here or a screen reader loses the description entirely.
                accessibilityLabel={`Show details. ${detailPreview}`}
                testID="devtest-item-details">
                {/* DR-128: the preview is markdown too, now — nested `<Text>` runs, which is
                    what keeps `numberOfLines` working. The plain string still exists, but only
                    for the label above; the screen gets the formatting. */}
                <Text
                  variant="caption"
                  color={t.muted}
                  style={styles.how}
                  testID="devtest-item-preview"
                  numberOfLines={DETAIL_PREVIEW_LINES}>
                  <MarkdownRuns text={item.how_to_test} />
                </Text>
                <Text variant="caption" color={t.violet} style={styles.how}>Show details</Text>
              </Pressable>
            )
          ) : null}
          {history === null ? (
            // DR-123: "conversation", not "notes" — this one button opens BOTH his entries and
            // Claude's replies, which is exactly the ambiguity he named ("I don't know what Notes
            // here are. Is note a comment? A reply?").
            <SmallButton
              title="Show conversation"
              icon="message-square"
              style={styles.historyToggle}
              onPress={async () => {
                try {
                  setHistory((await api.getDevTestFeedback(item.id)).entries);
                } catch {
                  setHistory([]);
                }
              }}
            />
          ) : history.length === 0 ? (
            <Text variant="caption" color={t.muted} style={styles.history}>
              Nothing here yet — no comments from you, no replies from Claude.
            </Text>
          ) : (
            // DR-080: a styled conversation, not `ts · verdict — comment` lines. Tester
            // entries carry their verdict chip; agent responses (triage answers — diagnosis,
            // "fixed in PR #N", "split into DR-0XX") render as markdown under an Agent chip,
            // so the pass/close decision can be made right here.
            history.map((e, idx) =>
              e.kind === 'response' ? (
                <View key={`${e.ts}-${idx}`} style={[styles.historyEntry, styles.historyAgent]}>
                  <View style={styles.historyHead}>
                    {/* DR-123: one vocabulary — his entries are "You", the agent's are "Claude",
                        and what the agent leaves is a "reply". "Agent" was a third word for a
                        thing the counts above already called a reply. */}
                    <Text variant="label" color={t.violet}>Claude · reply</Text>
                    <Text variant="caption" color={t.muted}>{e.ts.slice(5, 16)}</Text>
                  </View>
                  <Markdown text={e.text ?? ''} textScale={BUBBLE_TEXT_SCALE} />
                </View>
              ) : (
                <View key={`${e.ts}-${idx}`} style={styles.historyEntry}>
                  <View style={styles.historyHead}>
                    <Text
                      variant="label"
                      color={e.verdict === 'pass' ? t.mint : e.verdict === 'fail' ? t.danger : t.muted}>
                      {/* `remark` is still the wire word (the API, the inbox and the triage skill
                          all speak it); "comment" is what he is shown, matching the button that
                          produced it. */}
                      You · {e.verdict === 'remark' || !e.verdict ? 'comment' : e.verdict}
                    </Text>
                    <Text variant="caption" color={t.muted}>{e.ts.slice(5, 16)}</Text>
                  </View>
                  {/* DR-123 — Kamil: "make sure the comment font size is like the rest of the
                      things. Currently it's too large." It was `body` (15.5) inside a card whose
                      own title is now smaller than that. */}
                  {e.comment ? (
                    <Text variant="caption" color={t.text} style={styles.historyComment}>{e.comment}</Text>
                  ) : null}
                </View>
              ),
            )
          )}
          <TextInput
            placeholder="Comment (optional for Pass and Fail)"
            placeholderTextColor={t.muted}
            value={comment}
            onChangeText={setComment}
            multiline
            style={styles.input}
          />
          {shot ? <AttachToggle attach={attach} onToggle={() => setAttach(!attach)} /> : null}
          {/* DR-123: "The buttons for … Pass, Fail, Remark etc. are too big. Use icons where
              possible and clear." Compact pills, icon + word — icon ALONE is not clear here: a
              check and a cross are unambiguous, but nothing reads as "leave a comment" without
              its label, and a row where two of three are labelled reads worse than three that
              are. `Remark` is now `Comment`, the same word the rest of the sheet uses. */}
          <View style={styles.row}>
            <SmallButton title="Pass" icon="check" variant="primary" loading={busy} disabled={busy}
              onPress={() => void send('pass')} />
            <SmallButton title="Fail" icon="x" disabled={busy}
              onPress={() => void send('fail')} />
            <SmallButton title="Comment" icon="message-circle" disabled={busy}
              onPress={() => void send('remark')} />
          </View>
          {/* DR-092: hand THIS issue to a Claude session, on the model the bubble picker holds.
              Fire-on-tap; the toast and its eventual bubble reply confirm. */}
          {/* Two buttons, not a toggle: continuing is the default and the common case, so it
              stays one tap. "Fresh session" is the deliberate act — for when the accumulated
              context is the problem rather than the point — and reads as one. */}
          {dispatchModel ? (
            <View style={styles.row}>
              <SmallButton
                title={`Dispatch (${dispatchModel})`}
                icon="zap"
                loading={dispatching === 'item'}
                disabled={dispatching !== null}
                accessibilityLabel={`Dispatch ${item.id} to Claude on ${dispatchModel}, continuing the session that already worked it`}
                onPress={() => void fireDispatch(
                  dispatchModel, item.id, (b) => setDispatching(b ? 'item' : null))}
                testID="devtest-dispatch-item"
              />
              <SmallButton
                title="Fresh session"
                icon="refresh-cw"
                loading={dispatching === 'fresh'}
                disabled={dispatching !== null}
                accessibilityLabel={`Dispatch ${item.id} to a brand new Claude session on ${dispatchModel}`}
                testID="devtest-dispatch-fresh"
                onPress={() => void fireDispatch(
                  dispatchModel, item.id, (b) => setDispatching(b ? 'fresh' : null), true)}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** DR-123 — Kamil: "Reduce issues font. All. Descriptions comments etc."
 *
 *  The multiplier applied to every `<Markdown>` this sheet renders (the item description and
 *  Claude's replies). 0.8 puts the 17px reading paragraph at ~13.6px, level with the card's own
 *  title and meta line rather than a third larger than them — which is what made a description
 *  the loudest thing on a card it is only context for. `Markdown` already supports this (DR-068's
 *  discussion text-size control); nothing new had to be threaded through it. */
const BUBBLE_TEXT_SCALE = 0.8;

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  bubble: {
    position: 'absolute',
    right: space.md,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: t.mint,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    zIndex: 40,
  },
  // DR-123 — "Too large margin as well. Reduce those too for this screen." The sheet's own
  // gutter and every card's padding drop one step on the space scale; the type sizes below do
  // the same. Local to this dev-only sheet by his own scoping ("we might consider for the rest
  // of the app later"), so no shared token moves.
  sheet: { flex: 1, backgroundColor: t.bg, paddingHorizontal: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { flex: 1 },
  // The `gap` is not cosmetic. `IconButton` carries its own `hitSlop`, which RN clips to the
  // PARENT's bounds — so with the icons edge to edge, adjacent slop regions overlap inside this
  // row and RN resolves an overlap in favour of the later sibling. The later sibling here is
  // Close, which also drops the DR-063 "Just added" pin, so a thumb that missed ⋮ by a few dp
  // dismissed the sheet and discarded the item he had just filed (Opus review, PR #479).
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // A real `control.minTouch` box, not a hitSlop: same reasoning as `smallBtnTarget`. Only the
  // glyph is visible (`filled={false}`), so the box costs nothing but the row's own height —
  // which the four rows this header replaced cost many times over.
  headerIcon: { width: control.minTouch, height: control.minTouch },
  scroll: { paddingBottom: space.xl },
  card: {
    backgroundColor: t.elevated,
    borderRadius: radius.sm,
    padding: space.sm,
    marginBottom: space.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line,
  },
  // No `flexWrap` any more: the head is one title plus one chevron, and the chips that used to
  // wrap it onto a second line are now the single `cardMeta` line below it.
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  justAddedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { flex: 1, fontFamily: fonts.bodyMedium, fontSize: 13.5, lineHeight: 18 },
  cardMeta: { marginTop: 2, fontSize: 11.5, lineHeight: 15 },
  cardId: { marginTop: space.xs, letterSpacing: 0.3 },
  activity: { marginTop: 2 },
  how: { marginTop: space.xs, lineHeight: 18 },
  // The same spacing without the `lineHeight`, which is a TextStyle: on the View wrapping the
  // rendered description it is silently ignored at runtime and only misleads the next reader.
  howBody: { marginTop: space.xs },
  history: { marginTop: 4 },
  historyToggle: { marginTop: space.sm, alignSelf: 'flex-start' },
  historyEntry: {
    marginTop: space.sm,
    paddingLeft: space.sm,
    borderLeftWidth: 2,
    borderLeftColor: t.line,
    gap: 2,
  },
  historyAgent: { borderLeftColor: t.violet },
  historyHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  historyComment: { lineHeight: 17 },
  input: {
    marginTop: space.sm,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    fontSize: 13,
    color: t.text,
    backgroundColor: t.surface,
  },
  inputTall: { minHeight: 64, textAlignVertical: 'top' },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  // `flexWrap` so a row of compact pills breaks onto a second line at large OS font scales
  // rather than squeezing each one below its label.
  row: { flexDirection: 'row', gap: space.xs, marginTop: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  restToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  searchInput: {
    marginTop: space.xs,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    fontSize: 13,
    color: t.text,
    backgroundColor: t.surface,
  },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  searchClear: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  // DR-123: the ⋮ panel. In FLOW rather than absolutely positioned over the list — it is only
  // ever open while he is choosing something, and an in-flow panel needs no header-height
  // arithmetic to stay anchored as the rows above it (the error line, the narrowed count) come
  // and go.
  menu: {
    marginTop: space.xs,
    padding: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line2,
    backgroundColor: t.surface,
  },
  menuNote: { marginTop: space.xs },
  // The TARGET: `control.minTouch` tall, invisible. `minHeight` rather than `height` so a label
  // that grows past it at a large OS font scale takes the room instead of being clipped.
  smallBtnTarget: { minHeight: control.minTouch, justifyContent: 'center' },
  // The PILL: what he actually sees, and the only part that shrank.
  smallBtn: {
    minHeight: SMALL_BTN_HEIGHT,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  smallBtnPrimary: { backgroundColor: t.mint },
  smallBtnGhost: { backgroundColor: t.elevated, borderWidth: 1, borderColor: t.line2 },
  bannerButton: { marginTop: space.xs, alignSelf: 'flex-start' },
  // The row View (not the ScrollView) owns the vertical footprint — see the comment at the
  // usage site. The shared label minimum keeps the two chip rows' left edges aligned.
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs },
  dispatchRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm },
  failPrompt: {
    marginTop: space.sm,
    padding: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.amber,
    backgroundColor: t.amberWash,
    gap: space.xs,
  },
  failPromptRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dispatchBanner: {
    marginTop: space.xs,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  dispatchBannerHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  // DR-121: the toggle takes the row's slack so the dismiss × beside it stays pinned right.
  dispatchBannerToggle: { flex: 1 },
  // Takes the slack so the elapsed time stays pinned right however long the headline runs.
  dispatchBannerTitle: { flex: 1 },
  // minWidth, not width: at OS font scales past ~1.4x "Filter" outgrows 44px and a fixed width
  // would wrap it to a second line (Opus review, PR #388) — min keeps the two rows' chips
  // aligned at 1x and lets the label take more room instead of wrapping when scaled.
  chipRowLabel: { minWidth: 44 },
  filterRow: { flexDirection: 'row', gap: space.xs, paddingVertical: space.xs },
  // DR-116: the caption takes the spare width so a long reason wraps rather than squeezing the
  // "Show all" button that is the whole point of the row. `flexWrap` because that button's height
  // is fixed while its padding scales with accessibility text size — at large scales it takes the
  // next line rather than crushing the caption to its min-content width.
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  matchCount: { marginTop: 2, flex: 1 },
});
