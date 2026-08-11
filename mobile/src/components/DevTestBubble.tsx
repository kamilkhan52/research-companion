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

import { usePathname } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Modal, NativeModules, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as api from '@/api/endpoints';
import type { DevTestItem, DevTestFeedbackEntry } from '@/api/endpoints';
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

export function DevTestBubble() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
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
  }, []);

  // Exclude the pinned "Just added" item from its normal section — Opus review, PR #371: it
  // used to render there too, a second mounted `ItemCard` for the same item.id sharing one
  // AsyncStorage draft key with independent in-memory state, so submitting a verdict on one
  // instance's debounced write could resurrect it on the other.
  const sections = useMemo(
    () => sectionItems(justCreated ? items.filter((i) => i.id !== justCreated.id) : items),
    [items, justCreated],
  );

  return (
    <>
      {!visible && !hidden ? (
        <Pressable
          onPress={() => void open()}
          accessibilityRole="button"
          accessibilityLabel="Open device-test companion"
          style={[styles.bubble, { bottom: insets.bottom + 96 }]}
        >
          <Icon name="clipboard" size={20} color={t.mintInk} />
        </Pressable>
      ) : null}

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

          <ScrollView contentContainerStyle={styles.scroll}>
            {creating ? (
              <NewItemForm
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
                />
              </>
            ) : null}
            <Section label={`To verify (${sections.verify.length})`} tone={t.mint} />
            {sections.verify.map((i) => (
              <ItemCard key={i.id} item={i} shot={shot} route={pathname} />
            ))}
            <Section label={`Open (${sections.open.length})`} tone={t.amber} />
            {sections.open.map((i) => (
              <ItemCard key={i.id} item={i} shot={shot} route={pathname} />
            ))}
            <Pressable onPress={() => setShowRest((v) => !v)} style={styles.restToggle}>
              <Section label={`Everything else (${sections.rest.length})`} tone={t.muted} />
              <Icon name={showRest ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} />
            </Pressable>
            {showRest
              ? sections.rest.map((i) => (
                  <ItemCard key={i.id} item={i} shot={shot} route={pathname} />
                ))
              : null}
          </ScrollView>
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

interface NewItemDraft { title: string; description: string }
const NEW_ITEM_DRAFT_FALLBACK: NewItemDraft = { title: '', description: '' };

// Exported for a direct persistence test (DR-065), same reasoning as ItemCard above.
export function NewItemForm({ onDone }: { onDone: (item: DevTestItem | null) => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // DR-065: an unfinished new-issue draft used to vanish the moment the sheet closed (Modal
  // unmount kills local useState) — the same persisted-draft pattern the notes screen already
  // uses for exactly this failure mode.
  const draft = usePersistedDraft<NewItemDraft>(draftKey('devtest-new-item'), NEW_ITEM_DRAFT_FALLBACK);
  const [busy, setBusy] = useState(false);
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
      <View style={styles.row}>
        <Button
          title="Create"
          loading={busy}
          disabled={!draft.value.title.trim()}
          onPress={async () => {
            setBusy(true);
            try {
              const { item } = await api.createDevTestItem(
                draft.value.title.trim(), draft.value.description.trim() || undefined,
              );
              showToast('Issue recorded for triage.');
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

interface ItemCardDraft { expanded: boolean; comment: string; attach: boolean }

// Exported for a direct persistence test (DR-065) — mounting the whole bubble to reach one
// card would mean mocking the network fetch just to get here.
export function ItemCard({ item, shot, route, startExpanded = false }: {
  item: DevTestItem; shot: string | null; route: string; startExpanded?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // DR-065: "which item was opened, any unfinished message... full resumption of previous
  // state" — closing the sheet (or the app dying) used to lose whichever card was expanded and
  // whatever remark was half-typed, since it was plain useState inside a Modal. Keyed per item
  // id so several cards can each keep their own in-progress remark independently, same as the
  // notes screen's drafts.
  const draft = usePersistedDraft<ItemCardDraft>(
    draftKey('devtest-item', item.id),
    { expanded: startExpanded, comment: '', attach: false },
  );
  const { expanded, comment, attach } = draft.value;
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<DevTestFeedbackEntry[] | null>(null);

  const setExpanded = (next: boolean) => draft.setValue((v) => ({ ...v, expanded: next }));
  const setComment = (next: string) => draft.setValue((v) => ({ ...v, comment: next }));
  const setAttach = (next: boolean) => draft.setValue((v) => ({ ...v, attach: next }));

  const send = async (verdict: 'pass' | 'fail' | 'remark') => {
    if (verdict === 'remark' && !comment.trim()) {
      showToast('A remark needs a comment.');
      return;
    }
    setBusy(true);
    try {
      await api.recordDevTestFeedback({
        item_id: item.id,
        verdict,
        comment: comment.trim() || undefined,
        route,
        screenshot_b64: attach && shot ? shot : undefined,
      });
      showToast(`${item.id}: ${verdict} recorded${attach && shot ? ' with screenshot' : ''}.`);
      // Nothing left to resume once a verdict lands — clear the draft rather than leave stale
      // text behind for next time.
      await draft.clear({ expanded: false, comment: '', attach: false });
    } catch (e) {
      showToast((e as Error).message ?? 'Could not record feedback.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        accessibilityRole="button"
        accessibilityLabel={`${item.id}: ${item.title}. Tap to ${expanded ? 'collapse' : 'leave a pass, fail, or remark'}.`}
      >
        <View style={styles.cardHead}>
          <Chip label={item.id} color={t.violet} dot={false} />
          <Chip label={item.state} color={t.muted} dot={false} />
          {item.feedback_count ? (
            <Chip label={`${item.feedback_count} note${item.feedback_count === 1 ? '' : 's'}`} color={t.mint} dot={false} />
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
          ) : (
            history.map((e, idx) => (
              <Text key={`${e.ts}-${idx}`} variant="caption" color={t.muted} style={styles.history}>
                {e.ts.slice(5, 16)} · {e.verdict}{e.comment ? ` — ${e.comment}` : ''}
              </Text>
            ))
          )}
          <TextInput
            placeholder="Comment (optional for pass/fail, required for remark)"
            placeholderTextColor={t.muted}
            value={comment}
            onChangeText={setComment}
            multiline
            style={styles.input}
          />
          {shot ? (
            <Pressable onPress={() => setAttach(!attach)} style={styles.attachRow} hitSlop={8}>
              <Icon name={attach ? 'check-square' : 'square'} size={16} color={t.mint} />
              <Text variant="caption" color={t.text}>Attach the captured screen</Text>
            </Pressable>
          ) : null}
          <View style={styles.row}>
            <Button title="Pass" icon="check" loading={busy} disabled={busy}
              onPress={() => void send('pass')} />
            <Button title="Fail" icon="x" variant="ghost" disabled={busy}
              onPress={() => void send('fail')} />
            <Button title="Remark" icon="message-circle" variant="ghost" disabled={busy}
              onPress={() => void send('remark')} />
          </View>
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
});
