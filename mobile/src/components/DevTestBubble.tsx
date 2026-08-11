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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as api from '@/api/endpoints';
import type { DevTestItem, DevTestFeedbackEntry } from '@/api/endpoints';
import { showToast } from '@/ui/Toast';
import { Button, Chip, Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

// Guarded: absent from dev clients built before this feature. captureScreen grabs the whole
// window, which is why the bubble hides itself for the frame.
let captureScreen: ((opts: object) => Promise<string>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  captureScreen = require('react-native-view-shot').captureScreen;
} catch {
  captureScreen = null;
}

export const canScreenshot = () => captureScreen !== null;

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

  const open = useCallback(async () => {
    let captured: string | null = null;
    if (captureScreen) {
      setHidden(true);
      // Two frames so the hidden bubble is actually out of the composited frame.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        captured = await captureScreen({ format: 'png', result: 'base64', quality: 0.9 });
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

  const sections = useMemo(() => sectionItems(items), [items]);

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
                onPress={() => setVisible(false)}
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
                  if (item) setItems((prev) => [item, ...prev]);
                }}
              />
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

function NewItemForm({ onDone }: { onDone: (item: DevTestItem | null) => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.card}>
      <Text variant="label">New issue</Text>
      <TextInput
        placeholder="What's wrong / what's the idea?"
        placeholderTextColor={t.muted}
        value={title}
        onChangeText={setTitle}
        style={styles.input}
      />
      <TextInput
        placeholder="Steps, context, expectations (optional)"
        placeholderTextColor={t.muted}
        value={description}
        onChangeText={setDescription}
        multiline
        style={[styles.input, styles.inputTall]}
      />
      <View style={styles.row}>
        <Button
          title="Create"
          loading={busy}
          disabled={!title.trim()}
          onPress={async () => {
            setBusy(true);
            try {
              const { item } = await api.createDevTestItem(title.trim(), description.trim() || undefined);
              showToast('Issue recorded for triage.');
              onDone(item);
            } catch (e) {
              showToast((e as Error).message ?? 'Could not create the issue.');
              onDone(null);
            } finally {
              setBusy(false);
            }
          }}
        />
        <Button title="Cancel" variant="ghost" onPress={() => onDone(null)} />
      </View>
    </View>
  );
}

function ItemCard({ item, shot, route }: { item: DevTestItem; shot: string | null; route: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState('');
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<DevTestFeedbackEntry[] | null>(null);

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
      setComment('');
      setAttach(false);
      setExpanded(false);
    } catch (e) {
      showToast((e as Error).message ?? 'Could not record feedback.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`${item.id}: ${item.title}`}
      >
        <View style={styles.cardHead}>
          <Chip label={item.id} color={t.violet} dot={false} />
          <Chip label={item.state} color={t.muted} dot={false} />
          {item.feedback_count ? (
            <Chip label={`${item.feedback_count} note${item.feedback_count === 1 ? '' : 's'}`} color={t.mint} dot={false} />
          ) : null}
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
            history.map((e) => (
              <Text key={e.ts} variant="caption" color={t.muted} style={styles.history}>
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
            <Pressable onPress={() => setAttach((v) => !v)} style={styles.attachRow} hitSlop={8}>
              <Icon name={attach ? 'check-square' : 'square'} size={16} color={t.mint} />
              <Text variant="caption" color={t.text}>Attach the captured screen</Text>
            </Pressable>
          ) : null}
          <View style={styles.row}>
            <Button title="Pass" icon="check" loading={busy} onPress={() => void send('pass')} />
            <Button title="Fail" icon="x" variant="ghost" onPress={() => void send('fail')} />
            <Button title="Remark" icon="message-circle" variant="ghost" onPress={() => void send('remark')} />
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
  cardHead: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap', marginBottom: space.xs },
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
