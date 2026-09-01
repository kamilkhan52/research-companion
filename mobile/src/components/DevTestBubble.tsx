// The in-app device-test companion (DR-060) — dev builds only. A floating bubble, openable
// from anywhere, listing the device-review ledger's items with what-to-test instructions;
// pass/fail/remark verdicts (comment optional on verdicts, required for a bare remark), a
// screenshot of the screen BENEATH the bubble, and new-issue capture. Everything lands in the
// server's `.dev-feedback/` inbox for the /device-feedback skill to triage into the ledger —
// the app never writes the ledger itself.
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
import { Modal, NativeModules, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as api from '@/api/endpoints';
import { DISPATCH_MODELS } from '@/api/dispatch';
import type { DispatchModel } from '@/api/dispatch';
import type { DevTestItem, DevTestFeedbackEntry, DispatchStatus } from '@/api/endpoints';
import { Markdown } from '@/components/Markdown';
import { showToast } from '@/ui/Toast';
import { Button, Chip, Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
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
export type ReviewFilter = 'all' | 'unreviewed' | 'reviewed' | 'passed' | 'failed';
export type SortMode = 'default' | 'recent' | 'az';
export type VerdictInfo = { verdict: 'pass' | 'fail'; at: number };

export const REVIEW_FILTERS: { key: ReviewFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unreviewed', label: 'Not reviewed' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'passed', label: 'Passed' },
  { key: 'failed', label: 'Failed' },
];
export const SORT_MODES: { key: SortMode; label: string }[] = [
  { key: 'default', label: 'Priority' },
  { key: 'recent', label: 'Recently reviewed' },
  { key: 'az', label: 'A–Z' },
];

const ITEM_DRAFT_PREFIX = `${draftKey('devtest-item')}:`;

/** Reads every item's persisted verdict straight from storage, not just currently-mounted
 *  cards — a card inside the collapsed "Everything else" section (or simply not yet scrolled
 *  to) never mounts, so its verdict would otherwise be invisible to filtering/sorting until
 *  that section is expanded. Exported for a direct test; a corrupt entry just contributes
 *  nothing rather than blocking the rest of the sheet. */
export async function loadAllVerdicts(): Promise<Record<string, VerdictInfo>> {
  const keys = await AsyncStorage.getAllKeys();
  const itemKeys = keys.filter((k) => k.startsWith(ITEM_DRAFT_PREFIX));
  if (!itemKeys.length) return {};
  const pairs = await AsyncStorage.multiGet(itemKeys);
  const out: Record<string, VerdictInfo> = {};
  for (const [key, raw] of pairs) {
    if (!raw) continue;
    try {
      const stored = JSON.parse(raw) as { value?: { verdict?: 'pass' | 'fail'; verdictAt?: number } };
      const verdict = stored.value?.verdict;
      if (verdict === 'pass' || verdict === 'fail') {
        const id = decodeURIComponent(key.slice(ITEM_DRAFT_PREFIX.length));
        out[id] = { verdict, at: stored.value?.verdictAt ?? 0 };
      }
    } catch {
      // ignore a corrupt entry — see doc comment above
    }
  }
  return out;
}

/** A Chip driven by its own Pressable rather than Chip's built-in `onPress` (same reasoning as
 *  the member chips in authors.tsx): gives it a real accessibilityRole/State as a toggle. */
function ToggleChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={({ pressed }) => pressed && { opacity: 0.7 }}
    >
      <Chip label={label} dot={false} selected={active} />
    </Pressable>
  );
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
  const commitScrollOffset = useCallback(() => {
    scrollDraft.setValue(scrollOffsetRef.current);
  }, [scrollDraft]);

  // DR-092: the model a bubble dispatch uses, persisted so it survives reopen like the toolbar.
  const modelDraft = usePersistedDraft<DispatchModel>(draftKey('devtest-dispatch-model'), 'sonnet');
  const [dispatchingAll, setDispatchingAll] = useState(false);
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
  const setQuery = (next: string) => toolbar.setValue((v) => ({ ...v, query: next }));
  const setFilter = (next: ReviewFilter) => toolbar.setValue((v) => ({ ...v, filter: next }));
  const setSort = (next: SortMode) => toolbar.setValue((v) => ({ ...v, sort: next }));

  // Seeded in bulk on open (covers items whose card has never mounted — DR-077's whole point is
  // finding those), then kept live by each mounted ItemCard reporting its own verdict as it
  // loads or changes (`reportVerdict` below).
  const [verdicts, setVerdicts] = useState<Record<string, VerdictInfo>>({});
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
    setVerdicts(await loadAllVerdicts().catch(() => ({})));
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
      switch (filter) {
        case 'unreviewed': return !v;
        case 'reviewed': return !!v;
        case 'passed': return v === 'pass';
        case 'failed': return v === 'fail';
        default: return true;
      }
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
    else copy.sort((a, b) => (verdicts[b.id]?.at ?? -1) - (verdicts[a.id]?.at ?? -1));
    return copy;
  }, [sort, scoped, verdicts]);

  // DR-074: restore once per open, after the list has real content to scroll to — not on every
  // scroll-driven update to scrollDraft.value (the ref guard blocks re-entry once it's run).
  useEffect(() => {
    if (!visible) { restoredScrollRef.current = false; return; }
    if (restoredScrollRef.current || !scrollDraft.ready || !items.length) return;
    restoredScrollRef.current = true;
    const y = scrollDraft.value;
    if (y > 0) requestAnimationFrame(() => scrollRef.current?.scrollTo({ y, animated: false }));
  }, [visible, items.length, scrollDraft.ready, scrollDraft.value]);

  return (
    <>
      {!visible && !hidden ? <DevTestFloatingTrigger /> : null}

      <Modal visible={visible} animationType="slide" onRequestClose={() => setVisible(false)}>
        <View style={[styles.sheet, { paddingTop: insets.top + space.sm }]}>
          <View style={styles.header}>
            <Text variant="title">Device tests</Text>
            <View style={styles.headerActions}>
              <Button
                title="New issue"
                variant="ghost"
                icon="plus"
                onPress={() => setCreating(true)}
              />
              <Pressable
                onPress={() => {
                  setVisible(false);
                  setJustCreated(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={12}
                style={styles.close}
              >
                <Icon name="x" size={22} color={t.muted} />
              </Pressable>
            </View>
          </View>
          <Text variant="caption" color={t.muted} style={styles.subtitle}>
            {shot ? 'Screen captured — attach it to any remark below.' : canScreenshot()
              ? 'No capture this time.'
              : 'Screenshots need a rebuilt dev client (react-native-view-shot).'}
          </Text>
          {error ? <Text variant="caption" color={t.danger}>{error}</Text> : null}

          {/* DR-077 — search/filter/sort, outside the KeyboardAvoidingView/ScrollView below so
              it stays put while the list scrolls. Filter and sort are mutually independent:
              filter narrows WHICH items are in play, sort decides how to browse the result —
              "Not reviewed" + "Priority" for finding the next one, "Reviewed" + "Recently
              reviewed" for jumping back into whatever was just being worked on. */}
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
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              {REVIEW_FILTERS.map((f) => (
                <ToggleChip key={f.key} label={f.label} active={filter === f.key} onPress={() => setFilter(f.key)} />
              ))}
            </ScrollView>
          </View>
          <View style={styles.toolbarRow} testID="devtest-sort-toolbar">
            <Text variant="caption" color={t.muted} style={styles.chipRowLabel}>Sort</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              {SORT_MODES.map((s) => (
                <ToggleChip key={s.key} label={s.label} active={sort === s.key} onPress={() => setSort(s.key)} />
              ))}
            </ScrollView>
          </View>
          {query.trim() || filter !== 'all' ? (
            <Text variant="caption" color={t.muted} style={styles.matchCount}>
              {filteredItems.length} of {items.length} shown
            </Text>
          ) : null}

          {/* DR-092: hand the whole pending queue to one Claude session (Kamil's batch pick).
              Fire-on-tap — dev-only, and the toast + bubble replies make a mis-tap visible. */}
          <View style={styles.dispatchRow} testID="devtest-dispatch-all">
            <Text variant="caption" color={t.muted} style={styles.chipRowLabel}>Claude</Text>
            <ModelPicker model={modelDraft.value} onChange={(m) => modelDraft.setValue(m)} />
            <Button
              title="Dispatch all"
              variant="ghost"
              icon="zap"
              loading={dispatchingAll}
              disabled={dispatchingAll}
              onPress={() => void fireDispatch(modelDraft.value, undefined, setDispatchingAll)}
            />
          </View>
          {dispatchStatus ? <DispatchBanner status={dispatchStatus} /> : null}

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
                    onVerdictChange={reportVerdict}
                    dispatchModel={modelDraft.value}
                  />
                </>
              ) : null}
              {flatSorted ? (
                <>
                  <Section label={`Results (${flatSorted.length})`} tone={t.mint} />
                  {flatSorted.map((i) => (
                    <ItemCard key={i.id} item={i} shot={shot} route={pathname} onVerdictChange={reportVerdict} dispatchModel={modelDraft.value} />
                  ))}
                </>
              ) : (
                <>
                  <Section label={`To verify (${sections.verify.length})`} tone={t.mint} />
                  {sections.verify.map((i) => (
                    <ItemCard key={i.id} item={i} shot={shot} route={pathname} onVerdictChange={reportVerdict} dispatchModel={modelDraft.value} />
                  ))}
                  <Section label={`Open (${sections.open.length})`} tone={t.amber} />
                  {sections.open.map((i) => (
                    <ItemCard key={i.id} item={i} shot={shot} route={pathname} onVerdictChange={reportVerdict} dispatchModel={modelDraft.value} />
                  ))}
                  <Pressable onPress={() => setShowRest((v) => !v)} style={styles.restToggle}>
                    <Section label={`Everything else (${sections.rest.length})`} tone={t.muted} />
                    <Icon name={showRest ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} />
                  </Pressable>
                  {showRest
                    ? sections.rest.map((i) => (
                        <ItemCard key={i.id} item={i} shot={shot} route={pathname} onVerdictChange={reportVerdict} dispatchModel={modelDraft.value} />
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
  return (
    <Text variant="overline" color={tone} style={{ marginTop: space.lg, marginBottom: space.xs }}>
      {label}
    </Text>
  );
}


/** Fire a Claude dispatch (fire-on-tap, Kamil's decision): one session for `itemId`, or the
 *  whole pending batch when omitted. Shared by the header's "Dispatch all" and each item card
 *  so both report the same way and hit the same single-flight guard. */
async function fireDispatch(model: DispatchModel, itemId: string | undefined,
                           setBusy: (b: boolean) => void) {
  setBusy(true);
  try {
    const { dispatch } = await api.dispatchToClaude(model, itemId);
    showToast(`Claude (${model}) is on ${itemId ?? 'all pending issues'}. Replies land here.`);
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

/** "in 48m", "in 2h 10m", or "now" once the window has reopened. */
function formatUntil(resetsAt: number | null | undefined): string {
  if (!resetsAt) return 'soon';
  const secs = resetsAt - Date.now() / 1000;
  if (secs <= 0) return 'now';
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
 *  the case that used to be invisible — that it ended, well or badly. */
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

  return (
    <View style={[styles.dispatchBanner, { backgroundColor: wash, borderColor: tint }]}
          testID="devtest-dispatch-status">
      <View style={styles.dispatchBannerHead}>
        <Icon name={running ? 'zap' : bad ? 'alert-triangle' : 'check'} size={14} color={tint} />
        <Text variant="caption" color={t.text} style={styles.dispatchBannerTitle}>{headline}</Text>
        <Text variant="caption" color={t.muted}>{formatElapsed(status.elapsed_s)}</Text>
      </View>
      {detail ? (
        <Text variant="caption" color={t.muted} numberOfLines={2}>{detail}</Text>
      ) : null}
      <Text variant="caption" color={t.muted}>
        {status.steps > 0 ? `${status.steps} steps` : 'no step detail'}
        {status.result?.num_turns ? ` · ${status.result.num_turns} turns` : ''}
        {/* Refused steps are the DR-092 failure mode: a headless session cannot ask, so a
            denial is final and the session looks idle rather than blocked. */}
        {status.result?.denials ? ` · ${status.result.denials} refused` : ''}
        {running || limited ? '' : ' · check the item below for its reply'}
      </Text>
      {status.resumable ? <ResumeButton status={status} /> : null}
    </View>
  );
}

/** Pick a rate-limited session back up. Deliberately a manual tap rather than an automatic
 *  retry: resuming spends the freshly-reopened window, and which job that goes to is Kamil's
 *  call, not the client's. Enabled once the window has reopened — pressing early only earns
 *  another refusal. */
function ResumeButton({ status }: { status: DispatchStatus }) {
  const [busy, setBusy] = useState(false);
  const resetsAt = status.rate_limit?.resets_at ?? 0;
  const [ready, setReady] = useState(() => !resetsAt || resetsAt <= Date.now() / 1000);

  useEffect(() => {
    if (ready || !resetsAt) return;
    const ms = Math.max(0, resetsAt * 1000 - Date.now()) + 1000;
    const timer = setTimeout(() => setReady(true), ms);
    return () => clearTimeout(timer);
  }, [ready, resetsAt]);

  return (
    <Button
      title={ready ? 'Resume where it stopped' : `Resume ${formatUntil(resetsAt)}`}
      variant="ghost"
      icon="play"
      loading={busy}
      disabled={busy || !ready}
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
        <Button
          title="Create"
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
        <Button title="Cancel" variant="ghost" onPress={() => {
          void draft.clear(NEW_ITEM_DRAFT_FALLBACK);
          onDone(null);
        }} />
      </View>
    </View>
  );
}

interface ItemCardDraft {
  expanded: boolean; comment: string; attach: boolean;
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
                          dispatchModel }: {
  item: DevTestItem; shot: string | null; route: string; startExpanded?: boolean;
  // DR-077: reports this card's own verdict up to the list so filtering/sorting can see it the
  // instant it changes, without waiting for the sheet to close and reopen.
  onVerdictChange?: (id: string, info: VerdictInfo | undefined) => void;
  // DR-092: the model the bubble's picker currently holds — this card's Dispatch uses it.
  // Optional so the DR-065 persistence test can mount a card without the whole bubble.
  dispatchModel?: DispatchModel;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [dispatching, setDispatching] = useState(false);
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

  // DR-077: only report once the persisted load has actually resolved — reporting the fallback
  // (undefined) value during the one render before `ready` flips would transiently clobber a
  // verdict the parent already knows about from its own bulk `loadAllVerdicts` read on open.
  useEffect(() => {
    if (!draft.ready) return;
    onVerdictChange?.(item.id, lastVerdict ? { verdict: lastVerdict, at: verdictAt ?? 0 } : undefined);
  }, [item.id, draft.ready, lastVerdict, verdictAt, onVerdictChange]);

  const setExpanded = (next: boolean) => draft.setValue((v) => ({ ...v, expanded: next }));
  const setComment = (next: string) => draft.setValue((v) => ({ ...v, comment: next }));
  const setAttach = (next: boolean) => draft.setValue((v) => ({ ...v, attach: next }));

  const send = async (verdict: 'pass' | 'fail' | 'remark') => {
    // DR-088: a screenshot alone is a valid remark. Requiring words on top of it pushed the
    // tester toward Pass/Fail (which didn't complain) just to get the screenshot through.
    if (verdict === 'remark' && !comment.trim() && !(attach && shot)) {
      showToast('A remark needs a comment or an attached screenshot.');
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
      showToast(`${item.id}: ${verdict} recorded${
        screenshotOutcome(wantedShot, entry.screenshot, entry.screenshot_error)}.`);
      // Nothing left to resume once a verdict lands, but DR-075 wants the fact that a pass/fail
      // was already given to survive close/reopen (a remark leaves no verdict, so it doesn't
      // touch whatever verdict already exists). `clear()` DELETES the persisted entry — it
      // would drop the verdict the next time this card mounts fresh, so this uses `setValue`
      // (which actually persists) instead, resetting only the ephemeral fields.
      draft.setValue((v) => ({
        expanded: false, comment: '', attach: false,
        verdict: verdict === 'remark' ? v.verdict : verdict,
        verdictAt: verdict === 'remark' ? v.verdictAt : Date.now(),
      }));
      // Opus review, PR #380: `setValue`'s write is debounced 300ms, but tapping the card closed
      // right after Pass/Fail unmounts `ItemCard` (the Modal renders no children while hidden),
      // which cancels the pending write outright — losing the exact verdict DR-075 exists to
      // keep. `markSubmitted` writes `valueRef.current` (already updated by `setValue` above,
      // synchronously) to AsyncStorage immediately, so there's nothing left for an unmount to cancel.
      await draft.markSubmitted();
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
        accessibilityLabel={`${item.id}: ${item.title}. Tap to ${expanded ? 'collapse' : 'leave a pass, fail, or remark'}.${lastVerdict ? ` Already ${lastVerdict === 'fail' ? 'failed' : 'passed'} this session.` : ''}`}
      >
        <View style={styles.cardHead}>
          <Chip label={item.id} color={t.violet} dot={false} />
          <Chip label={item.state} color={t.muted} dot={false} />
          {item.feedback_count ? (
            <Chip label={`${item.feedback_count} note${item.feedback_count === 1 ? '' : 's'}`} color={t.mint} dot={false} />
          ) : null}
          {item.response_count ? (
            // DR-080: a reply exists — worth opening the history before re-testing.
            <Chip label={`${item.response_count} repl${item.response_count === 1 ? 'y' : 'ies'}`} color={t.violet} dot={false} />
          ) : null}
          {lastVerdict ? (
            // Opus review, PR #380: an explicit `=== 'fail'` check (not an else) so a future
            // widening of the verdict type can't silently mislabel an unrecognized value "Failed".
            <Chip label={lastVerdict === 'fail' ? 'Failed' : 'Passed'} color={verdictColor ?? undefined} dot={false} />
          ) : null}
          {/* Nothing else on a collapsed card hints it's tappable (DR-061) — this chevron is
              the only affordance, so it has to be unambiguous on its own. */}
          <View style={styles.cardChevron}>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} />
          </View>
        </View>
        <Text variant="body" numberOfLines={expanded ? undefined : 2} style={styles.cardTitle}>
          {item.title}
        </Text>
      </Pressable>
      {expanded ? (
        <>
          {item.how_to_test ? (
            <Text variant="caption" color={t.muted} style={styles.how}>
              {item.how_to_test}
            </Text>
          ) : null}
          {history === null ? (
            <Button
              title="Show earlier notes"
              variant="ghost"
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
              No earlier notes.
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
                    <Chip label="Agent" color={t.violet} dot={false} />
                    <Text variant="caption" color={t.muted}>{e.ts.slice(5, 16)}</Text>
                  </View>
                  <Markdown text={e.text ?? ''} />
                </View>
              ) : (
                <View key={`${e.ts}-${idx}`} style={styles.historyEntry}>
                  <View style={styles.historyHead}>
                    <Chip
                      label={`You · ${e.verdict ?? 'note'}`}
                      color={e.verdict === 'pass' ? t.mint : e.verdict === 'fail' ? t.danger : t.muted}
                      dot={false}
                    />
                    <Text variant="caption" color={t.muted}>{e.ts.slice(5, 16)}</Text>
                  </View>
                  {e.comment ? <Text variant="body">{e.comment}</Text> : null}
                </View>
              ),
            )
          )}
          <TextInput
            placeholder="Comment (optional — a remark needs a comment or a screenshot)"
            placeholderTextColor={t.muted}
            value={comment}
            onChangeText={setComment}
            multiline
            style={styles.input}
          />
          {shot ? <AttachToggle attach={attach} onToggle={() => setAttach(!attach)} /> : null}
          <View style={styles.row}>
            <Button title="Pass" icon="check" loading={busy} disabled={busy}
              onPress={() => void send('pass')} />
            <Button title="Fail" icon="x" variant="ghost" disabled={busy}
              onPress={() => void send('fail')} />
            <Button title="Remark" icon="message-circle" variant="ghost" disabled={busy}
              onPress={() => void send('remark')} />
          </View>
          {/* DR-092: hand THIS issue to a Claude session, on the model the bubble picker holds.
              Fire-on-tap; the toast and its eventual bubble reply confirm. */}
          {dispatchModel ? (
            <Button
              title={`Dispatch to Claude (${dispatchModel})`}
              icon="zap"
              variant="ghost"
              loading={dispatching}
              disabled={dispatching}
              onPress={() => void fireDispatch(dispatchModel, item.id, setDispatching)}
              style={{ marginTop: space.sm }}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

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
  sheet: { flex: 1, backgroundColor: t.bg, paddingHorizontal: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  subtitle: { marginTop: 2 },
  scroll: { paddingBottom: space.xl },
  card: {
    backgroundColor: t.elevated,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap', marginBottom: space.xs },
  cardChevron: { marginLeft: 'auto' },
  justAddedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontFamily: fonts.bodyMedium },
  how: { marginTop: space.xs, lineHeight: 18 },
  history: { marginTop: 4 },
  historyEntry: {
    marginTop: space.sm,
    paddingLeft: space.sm,
    borderLeftWidth: 2,
    borderLeftColor: t.line,
    gap: 2,
  },
  historyAgent: { borderLeftColor: t.violet },
  historyHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: {
    marginTop: space.sm,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.sm,
    padding: space.sm,
    color: t.text,
    backgroundColor: t.surface,
  },
  inputTall: { minHeight: 72, textAlignVertical: 'top' },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.md, alignItems: 'center' },
  restToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  searchInput: {
    marginTop: space.sm,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.sm,
    padding: space.sm,
    color: t.text,
    backgroundColor: t.surface,
  },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  searchClear: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  // The row View (not the ScrollView) owns the vertical footprint — see the comment at the
  // usage site. The shared label minimum keeps the two chip rows' left edges aligned.
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs },
  dispatchRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm },
  dispatchBanner: {
    marginTop: space.xs,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  dispatchBannerHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  // Takes the slack so the elapsed time stays pinned right however long the headline runs.
  dispatchBannerTitle: { flex: 1 },
  // minWidth, not width: at OS font scales past ~1.4x "Filter" outgrows 44px and a fixed width
  // would wrap it to a second line (Opus review, PR #388) — min keeps the two rows' chips
  // aligned at 1x and lets the label take more room instead of wrapping when scaled.
  chipRowLabel: { minWidth: 44 },
  filterRow: { flexDirection: 'row', gap: space.xs, paddingVertical: space.xs },
  matchCount: { marginTop: 2 },
});
