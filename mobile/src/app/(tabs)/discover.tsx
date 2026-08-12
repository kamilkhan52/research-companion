// Discover — find papers worth reading next, at any project (not just when starting one).
//
// A text field ("what would you like to explore?") starts a server-side job (app/discovery.py)
// that runs a funnel: papers that cite the reader's OWN library, plus their reference graph's
// existing recommendations, plus keyword search, are merged, passed through a free deterministic
// gate, then screened by two batched cheap-model passes before being ranked.
//
// That takes minutes, so this screen does two things while it waits. `ProgressPanel` maps the
// job's ten server phases onto five steps a reader can follow, carrying real counts. `LiveFinds`
// shows papers as they turn up — the first batch comes from the reader's own library and needs
// no model to be worth showing, so something real appears seconds in rather than a spinner.
//
// Adding a paper you already know is the other entry path: an "or" field under the query takes a
// title, DOI, or arXiv/PDF link, and the existing retrieval flow (deterministic -> agentic hunt)
// takes over on the paper's Discussion screen. It is hidden while a search runs.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { hideSuggestion, unhideSuggestion } from '@/api/endpoints';
import { keys, useAddPaper, useDiscovery, useProjectMembership } from '@/api/queries';
import type { DiscoveryJob, HiddenRecommendation, PaperSuggestion } from '@/api/types';
import { AddPaperInline } from '@/components/AddPaperInline';
import { ProgressSteps } from '@/components/ProgressSteps';
import { ScanningList } from '@/components/ScanningList';
import { TabHeader } from '@/components/TopBar';
import { useDiscoveryRun } from '@/hooks/useDiscoveryRun';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { discoverProgress } from '@/lib/discoverProgress';
import { fullPaperUrl } from '@/lib/paperLinks';
import { useActiveProject } from '@/store/project';
import { Button, Card, Icon, Screen, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export const DISCOVER_PLACEHOLDER = 'Type a topic or question';

export default function DiscoverScreen() {
  const router = useRouter();
  const { specific } = useLocalSearchParams<{ specific?: string }>();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { activePid: pid } = useActiveProject();
  const discovery = useDiscovery(pid);
  const runState = useDiscoveryRun(pid);
  const goalsDraft = usePersistedDraft(
    pid ? draftKey(pid, 'discover', 'goals') : null,
    discovery.data?.goals || discovery.data?.result?.goals || '',
  );

  const goals = goalsDraft.value;
  const setGoals = goalsDraft.setValue;
  const [showAll, setShowAll] = useState(false);
  // Focus mode: once a search is running (or results exist) the goals editor collapses to a
  // compact summary — the ranked list is the point of the screen then, and it stays one tap away.
  const [editingGoals, setEditingGoals] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  useEffect(() => {
    const accepted = discovery.data?.goals || discovery.data?.result?.goals || '';
    if (goalsDraft.submitted && accepted === goals.trim()) {
      void goalsDraft.clear(goals);
    }
  }, [discovery.data, goals, goalsDraft.clear, goalsDraft.submitted]);

  // Re-attach to a run already in flight (screen reopened mid-run).
  const resume = runState.resume;
  useEffect(() => {
    resume(discovery.data?.job);
  }, [discovery.data?.job, resume]);

  const result = discovery.data?.result ?? null;
  const suggestions = result?.suggestions ?? [];
  const topN = result?.top_n ?? 5;
  const visible = showAll ? suggestions : suggestions.slice(0, topN);
  const hiddenCount = suggestions.length - Math.min(topN, suggestions.length);

  const hasRunContext = runState.running || !!result;
  const showEditor = !hasRunContext || editingGoals;
  // The deep link keeps the ordinary Discover layout and focuses the ONE shared compact field.
  // It remains visible during a run only for this explicit entry, so the route never lands on a
  // hidden target while normal discovery keeps its focus on the search in progress.
  const specificEntry = specific === '1';

  async function runDiscovery() {
    const text = goals.trim();
    if (!text) return;
    setShowAll(false);
    setEditingGoals(false);
    await goalsDraft.markSubmitted();
    if (await runState.run(text)) await goalsDraft.clear(text);
  }

  return (
    <Screen edges={['top']}>
      <TabHeader
        title="Discover"
        actions={[
          { name: 'settings', onPress: () => router.push('/settings'), accessibilityLabel: 'Settings' },
        ]}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {showEditor ? (
            <Card style={{ gap: space.sm }}>
              <Text variant="overline">Explore</Text>
              <Text variant="caption">
                What would you like to explore? Describe a topic, question, or method — we’ll
                scan scholarly sources for relevant papers.
              </Text>
              <TextInput
                value={goals}
                onChangeText={setGoals}
                multiline
                style={styles.goalsInput}
                placeholder={DISCOVER_PLACEHOLDER}
                placeholderTextColor={t.muted}
                editable={!runState.running}
              />
              <Button
                title={runState.running ? 'Searching…' : result ? 'Search again' : 'Search'}
                onPress={runDiscovery}
                loading={runState.running}
                disabled={!goals.trim()}
                style={{ marginTop: space.xs }}
              />
              {editingGoals && !runState.running ? (
                <Button title="Cancel" variant="ghost" onPress={() => setEditingGoals(false)} />
              ) : null}
              {/* Only when it matters: a reader watching a search run does not want a second
                  way to add a paper competing for attention. */}
              {pid && (specificEntry || !runState.running) ? (
                <AddPaperInline pid={pid} autoFocus={specificEntry} />
              ) : null}
            </Card>
          ) : (
            // Compact goals summary — the search is the focus now; tap to edit & search again.
            <Pressable
              onPress={() => !runState.running && setEditingGoals(true)}
              disabled={runState.running}
              accessibilityLabel="Edit your search">
              <Card style={styles.goalsSummary}>
                <View style={styles.goalsHead}>
                  <Text variant="overline">Exploring</Text>
                  {!runState.running ? (
                    <Text variant="label" color={t.mint}>
                      Edit
                    </Text>
                  ) : null}
                </View>
                <Text variant="body" numberOfLines={3} style={{ marginTop: space.xs }}>
                  {goals || result?.goals || ''}
                </Text>
              </Card>
            </Pressable>
          )}

          {/* Keep the panel after an in-session run finishes so the fully-checked
              "Search complete" state (frame 02) actually renders above the results. */}
          {runState.job && (
            runState.running
            || runState.job.status === 'done'
            || runState.job.status === 'cancelled'
          ) ? (
            <>
              <ProgressPanel
                job={runState.job}
                cancelling={runState.cancelling}
                onCancel={runState.cancel}
              />
              {runState.running || runState.job.status === 'cancelled' ? (
                <LiveFinds job={runState.job} cancelled={runState.job.status === 'cancelled'} />
              ) : null}
            </>
          ) : null}

          {runState.error ? (
            <Card style={styles.errorCard}>
              <Text variant="body" color={t.danger}>
                {runState.error}
              </Text>
              <Button title="Dismiss" variant="ghost" onPress={runState.clearError} style={{ marginTop: space.sm }} />
            </Card>
          ) : null}

          {result && !runState.running ? (
            <View style={{ marginTop: space.xl }}>
              <Text variant="editorial">
                {runState.job?.status === 'cancelled' ? 'Previous results' : 'Results'}
              </Text>
              <Text variant="caption" color={t.muted} style={{ marginTop: space.xs, marginBottom: space.md }}>
                {result.focus ? `${result.focus} · ` : ''}{result.candidate_count} papers across
                scholarly sources, ranked by fit and evidence.
              </Text>
              <View style={styles.actionKey}>
                <View style={styles.actionKeyItem}>
                  <Icon name="align-left" size={14} color={t.muted} />
                  <Text variant="caption" color={t.muted}>Abstract</Text>
                </View>
                <View style={styles.actionKeyItem}>
                  <Icon name="external-link" size={14} color={t.muted} />
                  <Text variant="caption" color={t.muted}>Full paper</Text>
                </View>
                <View style={styles.actionKeyItem}>
                  <Icon name="eye-off" size={14} color={t.muted} />
                  <Text variant="caption" color={t.muted}>Hide</Text>
                </View>
              </View>
              <View style={{ gap: space.sm }}>
                {visible.map((s, i) => (
                  <SuggestionCard
                    key={`${pid}:${s.candidate_id}`}
                    pid={pid!}
                    suggestion={s}
                    rank={i + 1}
                    onAdded={() => setAddedCount((c) => c + 1)}
                  />
                ))}
              </View>
              {hiddenCount > 0 ? (
                <Button
                  title={showAll ? 'Show top picks only' : `Show ${hiddenCount} more papers`}
                  variant="ghost"
                  onPress={() => setShowAll((v) => !v)}
                  style={{ marginTop: space.md }}
                />
              ) : null}
            </View>
          ) : null}

          {/* Adding a known paper now lives inline under the query (see AddByReferenceInline),
              so nothing is repeated down here. The compact summary state has no query box of its
              own, so it keeps the affordance — still hidden while a search runs. */}
          {pid && !showEditor && (specificEntry || !runState.running) ? (
            <AddPaperInline pid={pid} autoFocus={specificEntry} />
          ) : null}
        </ScrollView>

        {addedCount > 0 ? (
          <View style={styles.footer}>
            <Button
              title={`Go to library · ${addedCount} added`}
              onPress={() => router.navigate('/')}
            />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

// ---------- live phase progress (mirrors the job's phase field) ----------

// The mint check timeline from Figma `02 · Discover`, with the live phase's detail line
// underneath. The detail lines carry REAL counts now — a run takes minutes, and "1,204 papers
// found" is the difference between progress and a spinner. The phase mapping lives in
// `lib/discoverProgress` so it can be tested without rendering.
function ProgressPanel({
  job,
  cancelling,
  onCancel,
}: {
  job: DiscoveryJob;
  cancelling: boolean;
  onCancel: () => Promise<boolean>;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // The furthest step reached so far. Held here rather than derived, so an unrecognised phase
  // (older client, newer server) holds position instead of rewinding the timeline to "Planned".
  const furthest = useRef(0);
  const { steps, detail, done, step } = discoverProgress(job, furthest.current);
  furthest.current = job.status === 'running' ? step : 0;
  const cancelled = job.status === 'cancelled';

  return (
    <Card style={styles.progressPanel}>
      <Text variant="serifTitle" color={t.mint}>
        {cancelled ? 'Search stopped' : done ? 'Search complete' : 'Searching…'}
      </Text>
      <ProgressSteps
        dotSize={28}
        style={styles.stepsRow}
        steps={steps.map((step) => ({ key: step.key, label: step.label, state: step.state }))}
      />
      {cancelled ? (
        <Text variant="caption" style={{ textAlign: 'center' }}>
          {job.finds?.length
            ? 'Partial finds are shown below. They were not saved as ranked recommendations.'
            : 'No partial finds were ready. Your previous completed results are unchanged.'}
        </Text>
      ) : detail ? (
        <Text variant="caption" numberOfLines={1} style={{ textAlign: 'center' }}>
          {detail}
        </Text>
      ) : null}
      {job.status === 'running' ? (
        <Button
          title={cancelling ? 'Stopping…' : 'Stop search'}
          variant="ghost"
          icon="x"
          onPress={() => void onCancel()}
          loading={cancelling}
          accessibilityLabel="Stop discovery search"
          style={styles.stopButton}
        />
      ) : null}
    </Card>
  );
}

// ---------- live finds ----------

// A run takes minutes, so the screen shows what it is finding as it goes. The first batch comes
// from the reader's own library and reference graph, which need no model to be worth showing —
// they appear seconds in. They are labelled provisional, because a paper shown here and then
// absent from the results must read as the search narrowing rather than as a bug.
/** One row's height. Fixed, because the scroller translates by exact multiples of it — a row
 *  that grew to two lines would put the loop seam out of alignment. Titles clamp to one line. */
const FIND_ROW_H = 44;

function LiveFinds({ job, cancelled = false }: { job: DiscoveryJob; cancelled?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const finds = job.finds ?? [];
  if (!finds.length) return null;
  const ranked = job.finds_stage === 'ranked';

  return (
    <View style={styles.finds}>
      <View style={styles.findsHead}>
        <Icon name="compass" size={14} color={t.mint} />
        <Text variant="overline" color={t.mint}>
          {cancelled ? 'Partial finds' : ranked ? 'Best matches so far' : 'Scanning'}
        </Text>
      </View>
      <ScanningList rowHeight={FIND_ROW_H} rows={2} fadeColor={t.elevated} paused={cancelled}>
        {finds.map((find, i) => (
          <View key={`${find.title}:${i}`}>
            <Text variant="body" numberOfLines={1}>
              {find.title}
            </Text>
            {find.reason ? (
              <Text variant="caption" color={t.muted} numberOfLines={1} style={{ marginTop: 2 }}>
                {find.reason}
              </Text>
            ) : null}
          </View>
        ))}
      </ScanningList>
    </View>
  );
}

// ---------- one suggestion ----------

export function SuggestionCard({
  pid,
  suggestion: s,
  rank,
  onAdded,
}: {
  pid: string;
  suggestion: PaperSuggestion;
  rank: number;
  onAdded?: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const addPaper = useAddPaper(pid);
  const [added, setAdded] = useState(false);
  // Live membership: the suggestion list is a snapshot from when discovery ran, so a paper
  // added since (from anywhere) must still show as in the library, not re-addable.
  const { isInProject } = useProjectMembership(pid);
  const inLibrary = added || isInProject({ arxivId: s.arxiv_id, title: s.title });
  const [showAbstract, setShowAbstract] = useState(false);
  // Hide (R12.3): the server filters this paper from future recommendation responses; the
  // card flips into a compact undo row rather than vanishing, so a mis-tap is recoverable.
  // The cached Discover list is deliberately NOT invalidated while the undo row shows, but
  // the Map's recommendations query is — a mounted Graph tab must not keep serving the
  // hidden paper from its cache. The card is keyed by pid+candidate at the call site, and
  // an identity ref guards in-flight responses against representing a different project.
  const qc = useQueryClient();
  const [hiddenEntry, setHiddenEntry] = useState<HiddenRecommendation | null>(null);
  const [hideBusy, setHideBusy] = useState(false);
  const [hideError, setHideError] = useState<string | null>(null);
  const cardIdentity = `${pid}:${s.candidate_id}`;
  const identityRef = useRef(cardIdentity);
  identityRef.current = cardIdentity;
  const paperUrl = fullPaperUrl(s);

  async function handleHide() {
    if (hideBusy) return;
    const identity = cardIdentity;
    const requestPid = pid;
    setHideBusy(true);
    setHideError(null);
    try {
      const { hidden } = await hideSuggestion(requestPid, s);
      void qc.invalidateQueries({ queryKey: keys.graph(requestPid) });
      if (identityRef.current !== identity) return;
      setHiddenEntry(hidden);
    } catch (e) {
      if (identityRef.current !== identity) return;
      setHideError((e as Error).message ?? 'Could not hide this paper.');
    } finally {
      if (identityRef.current === identity) setHideBusy(false);
    }
  }

  async function handleUndoHide() {
    if (hideBusy || !hiddenEntry) return;
    const identity = cardIdentity;
    const requestPid = pid;
    setHideBusy(true);
    try {
      await unhideSuggestion(requestPid, hiddenEntry.keys);
      void qc.invalidateQueries({ queryKey: keys.graph(requestPid) });
      void qc.invalidateQueries({ queryKey: keys.discovery(requestPid) });
      if (identityRef.current !== identity) return;
      setHiddenEntry(null);
    } catch (e) {
      if (identityRef.current !== identity) return;
      setHideError((e as Error).message ?? 'Could not restore this paper.');
    } finally {
      if (identityRef.current === identity) setHideBusy(false);
    }
  }

  if (hiddenEntry) {
    return (
      <Card style={styles.suggestionCard}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="eye-off" size={14} color={t.muted} />
          <Text variant="caption" color={t.muted} style={{ flex: 1 }} numberOfLines={2}>
            “{s.title}” won’t be recommended again.
          </Text>
          <Pressable
            onPress={() => void handleUndoHide()}
            style={styles.actionBtn}
            accessibilityLabel={`Undo hiding ${s.title}`}>
            <Text variant="caption" color={t.mint}>Undo</Text>
          </Pressable>
        </View>
        {hideError ? (
          <Text variant="caption" color={t.danger} style={{ marginTop: 4 }}>{hideError}</Text>
        ) : null}
      </Card>
    );
  }

  // Defensive: a discovery result persisted before this field existed can still reach
  // the client missing it entirely (the backend backfills known-old projects, but this
  // guard is what stops a future gap like it from crashing the whole screen again).
  const authorList = s.authors ?? [];
  const authors = authorList.length > 2 ? `${authorList[0]} et al.` : authorList.join(', ');
  const meta = [
    authors || null,
    s.year,
    s.venue || null,
    s.citation_count != null ? `~${s.citation_count.toLocaleString()} citations` : null,
    s.arxiv_id ? `arXiv:${s.arxiv_id}` : s.doi ? `DOI:${s.doi}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  async function handleAdd() {
    if (inLibrary) return;
    try {
      const result = await addPaper.mutateAsync({
        title: s.title,
        arxivId: s.arxiv_id ?? undefined,
        pdfUrl: s.pdf_url || undefined,
        abstract: s.abstract,
        year: s.year ?? undefined,
      });
      if (!result.paper) return;
      setAdded(true);
      onAdded?.();
    } catch {
      // surfaced inline via addPaper.isError
    }
  }

  return (
    <Card style={styles.suggestionCard}>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <Text style={styles.rankNum}>{String(rank).padStart(2, '0')}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading">{s.title}</Text>
          <Text variant="caption" style={{ marginTop: 2 }}>
            {meta}
          </Text>
        </View>
      </View>
      {(s.reasons ?? [])[0] ? (
        <View style={styles.reasonRow}>
          <Icon name="check" size={14} color={t.mint} />
          <Text variant="caption" color={t.text} style={{ flex: 1, opacity: 0.85 }}>
            {(s.reasons ?? [])[0]}
          </Text>
        </View>
      ) : null}

      {showAbstract ? (
        <Text variant="body" color={t.muted} style={{ marginTop: space.sm, fontSize: 14, lineHeight: 21 }}>
          {s.abstract}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {s.abstract ? (
          <Pressable
            onPress={() => setShowAbstract((v) => !v)}
            style={[styles.actionBtn, showAbstract && styles.actionBtnActive]}
            accessibilityLabel={`${showAbstract ? 'Hide' : 'Show'} abstract for ${s.title}`}>
            <Icon name="align-left" size={20} color={showAbstract ? t.mint : t.muted} />
          </Pressable>
        ) : null}
        {paperUrl ? (
          <Pressable
            onPress={() => Linking.openURL(paperUrl)}
            style={styles.actionBtn}
            accessibilityLabel={`Open full paper for ${s.title}`}>
            <Icon name="external-link" size={20} color={t.muted} />
          </Pressable>
        ) : null}
        {!inLibrary ? (
          <Pressable
            onPress={() => void handleHide()}
            disabled={hideBusy}
            style={styles.actionBtn}
            accessibilityLabel={`Hide ${s.title} from recommendations`}>
            <Icon name="eye-off" size={20} color={t.muted} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Button
          title={added ? 'Added' : inLibrary ? 'In library' : 'Add'}
          icon={inLibrary ? 'check' : 'plus'}
          iconSize={inLibrary ? 17 : 24}
          onPress={handleAdd}
          loading={addPaper.isPending}
          disabled={inLibrary || addPaper.isPending}
          style={styles.addBtn}
          accessibilityLabel={inLibrary ? `${s.title} is in your library` : `Add ${s.title} to library`}
        />
      </View>
      {addPaper.isError ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: 4 }}>
          {(addPaper.error as Error).message}
        </Text>
      ) : null}
    </Card>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  body: { padding: space.md, paddingBottom: space.xxl },
  finds: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.elevated,
    gap: space.xs,
  },
  findsHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.xs },
  goalsInput: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    padding: space.md,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
    minHeight: 130,
    textAlignVertical: 'top',
    lineHeight: 22,
  },
  progressPanel: { gap: space.md, marginTop: space.md, alignItems: 'center' },
  stopButton: { alignSelf: 'stretch', height: 42 },
  stepsRow: {
    alignSelf: 'stretch',
    paddingHorizontal: space.sm,
  },
  goalsSummary: { padding: space.md, borderColor: t.line2 },
  goalsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rankNum: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 24,
    lineHeight: 30,
    color: t.violet,
  },
  reasonRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: space.sm },
  // DR-070 — "Make the Add button larger than the rest with a large plus." Taller than the
  // 48px icon row it sits beside, so it reads as the primary action rather than a fourth peer.
  addBtn: { height: 56, paddingHorizontal: space.lg },
  footer: {
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: t.line,
    backgroundColor: t.bg,
  },
  errorCard: { marginTop: space.md, borderColor: t.danger },
  suggestionCard: { borderColor: t.line2 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm, alignItems: 'center' },
  // DR-070 — Kamil: "turn these large buttons into icons so they're more compact." A one-time
  // key row above the results list carries the labels now; the icon choice is deliberately kept
  // distinct from Authors' existing `file-text` = "papers in project" stat (DR-048's open icon
  // question is the same vocabulary question, not yet answered for that screen).
  actionBtn: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnActive: { borderColor: t.mint, backgroundColor: t.mintWash },
  actionKey: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    marginBottom: space.sm,
  },
  actionKeyItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
