// Discover — scan scholarly sources for papers relevant to what you want to explore, at any
// project (not just when starting one). A clean text field ("what would you like to explore?")
// starts a server-side discovery job (app/discovery.py): LLM-planned broad+narrow arXiv and
// Semantic Scholar searches, Map-style citation/authorship enrichment, and a relevance-first
// ranking. The screen polls the job for live phase progress (job survives
// backgrounding — see useDiscoveryRun), then shows the top suggestions with the rest behind
// "show more". A "specific paper" box covers the other entry path: paste a title or an
// arXiv/PDF link, and the existing retrieval flow (deterministic -> agentic hunt) takes over
// on the paper's Discussion screen.

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
import { ProgressSteps } from '@/components/ProgressSteps';
import { TabHeader } from '@/components/TopBar';
import { useDiscoveryRun } from '@/hooks/useDiscoveryRun';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
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
  // compact summary and the "specific paper" box folds behind a toggle — the ranked list is
  // the point of the screen then. Both stay one tap away.
  const [editingGoals, setEditingGoals] = useState(false);
  const [showSpecific, setShowSpecific] = useState(false);
  const [addedCount, setAddedCount] = useState(0);

  // The Library's empty-project hub can deep-link directly into this entry path. Tabs may stay
  // mounted between navigations, so react to param changes rather than only using an initializer.
  useEffect(() => {
    if (specific === '1') setShowSpecific(true);
  }, [specific]);

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
  const specificEntry = specific === '1' && !hasRunContext;

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
          {specificEntry && pid ? (
            <>
              <SpecificPaper pid={pid} />
              <Button
                title="Discover papers instead"
                icon="compass"
                variant="ghost"
                onPress={() => router.replace('/discover')}
                style={{ marginTop: space.md }}
              />
            </>
          ) : showEditor ? (
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
          {runState.job && (runState.running || runState.job.status === 'done') ? (
            <ProgressPanel job={runState.job} />
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
              <Text variant="editorial">Results</Text>
              <Text variant="caption" color={t.muted} style={{ marginTop: space.xs, marginBottom: space.md }}>
                {result.focus ? `${result.focus} · ` : ''}{result.candidate_count} papers across
                scholarly sources, ranked by fit and evidence.
              </Text>
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

          {/* On a fresh screen the specific-paper box is a primary entry option; once a
              search owns the screen it folds behind a toggle. */}
          {pid && !specificEntry ? (
            hasRunContext && !showSpecific ? (
              <Button
                title="Have a specific paper? Add by name or link"
                variant="ghost"
                onPress={() => setShowSpecific(true)}
                style={{ marginTop: space.xl }}
              />
            ) : (
              <SpecificPaper pid={pid} />
            )
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

const PHASE_ORDER = ['queries', 'searching', 'citations', 'evidence', 'scoring', 'done'] as const;

// The mint check timeline from Figma `02 · Discover` ("Planned → Reviewed → Checked →
// Ranked"), with the live phase's detail line underneath — the polled job data the old
// vertical panel showed, kept.
function ProgressPanel({ job }: { job: DiscoveryJob }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const current = PHASE_ORDER.indexOf(job.phase);
  const steps = [
    { key: 'queries', label: 'Planned', detail: job.focus },
    {
      key: 'searching',
      label: 'Searched',
      detail: job.total_queries
        ? `${job.searched}/${job.total_queries} searches · ${job.found} papers`
        : 'Searching scholarly sources…',
    },
    { key: 'citations', label: 'Impact', detail: `Citation evidence for ${job.found} papers` },
    { key: 'evidence', label: 'Evidence', detail: 'Checking authors, venues, and institutions' },
    { key: 'scoring', label: 'Ranked', detail: 'Ranking by fit and evidence' },
  ];
  const active = steps[Math.min(Math.max(current, 0), steps.length - 1)];
  const done = job.phase === 'done' || job.status === 'done';
  return (
    <Card style={styles.progressPanel}>
      <Text variant="serifTitle" color={t.mint}>
        {done ? 'Search complete' : 'Searching…'}
      </Text>
      <ProgressSteps
        dotSize={28}
        style={styles.stepsRow}
        steps={steps.map((step, i) => ({
          key: step.key,
          label: step.label,
          state: done || i < current ? 'done' : i === current ? 'active' : 'pending',
        }))}
      />
      {!done && active?.detail ? (
        <Text variant="caption" numberOfLines={1} style={{ textAlign: 'center' }}>
          {active.detail}
        </Text>
      ) : null}
    </Card>
  );
}

// ---------- one suggestion ----------

function SuggestionCard({
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

  const authors = s.authors.length > 2 ? `${s.authors[0]} et al.` : s.authors.join(', ');
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
      {s.reasons[0] ? (
        <View style={styles.reasonRow}>
          <Icon name="check" size={14} color={t.mint} />
          <Text variant="caption" color={t.text} style={{ flex: 1, opacity: 0.85 }}>
            {s.reasons[0]}
          </Text>
        </View>
      ) : null}

      {showAbstract ? (
        <Text variant="body" color={t.muted} style={{ marginTop: space.sm, fontSize: 14, lineHeight: 21 }}>
          {s.abstract}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => setShowAbstract((v) => !v)}
          style={styles.actionBtn}
          accessibilityLabel={`${showAbstract ? 'Hide' : 'Show'} abstract for ${s.title}`}>
          <Text variant="caption" color={t.muted}>
            {showAbstract ? 'Hide abstract' : 'Abstract'}
          </Text>
        </Pressable>
        {paperUrl ? (
          <Pressable
            onPress={() => Linking.openURL(paperUrl)}
            style={styles.actionBtn}
            accessibilityLabel={`Open full paper for ${s.title}`}>
            <Icon name="external-link" size={13} color={t.muted} />
            <Text variant="caption" color={t.muted}>Full paper</Text>
          </Pressable>
        ) : null}
        {!inLibrary ? (
          <Pressable
            onPress={() => void handleHide()}
            disabled={hideBusy}
            style={styles.actionBtn}
            accessibilityLabel={`Hide ${s.title} from recommendations`}>
            <Icon name="eye-off" size={13} color={t.muted} />
            <Text variant="caption" color={t.muted}>Hide</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Button
          title={added ? 'Added' : inLibrary ? 'In library' : 'Add'}
          icon={inLibrary ? 'check' : 'plus'}
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

// ---------- bring a specific paper (name / arXiv link / PDF link) ----------

function SpecificPaper({ pid }: { pid: string }) {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const addPaper = useAddPaper(pid);
  const textDraft = usePersistedDraft(draftKey(pid, 'discover', 'specific-paper'), '');
  const text = textDraft.value;
  const setText = textDraft.setValue;
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const s = text.trim();
    if (!s) return;
    setErr(null);
    await textDraft.markSubmitted();
    // A paper name adds it by title (retrieval resolves it on open, escalating to the agentic
    // hunt if needed). An arXiv link/id or PDF link is carried to the Discussion screen as
    // ?source= so its Start fetches from exactly that source.
    const arxiv = s.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i) ?? s.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/);
    let title = s;
    let source: string | null = null;
    let arxivId: string | undefined;
    if (arxiv) {
      arxivId = arxiv[1];
      title = `arXiv ${arxivId}`; // placeholder title; the discussion opens with the real paper
      source = arxivId;
    } else if (/^https?:\/\//i.test(s)) {
      const tail = s.split('/').filter(Boolean).pop() ?? '';
      title = tail.replace(/\.pdf.*$/i, '').replace(/[-_]+/g, ' ').trim() || 'Linked paper';
      source = s;
    }
    try {
      const result = await addPaper.mutateAsync({
        title,
        arxivId,
        // A pasted non-arXiv URL is a direct PDF source; the analysis offer must fetch
        // exactly it, mirroring what ?source= does for the manual Start path below.
        pdfUrl: !arxivId && source ? source : undefined,
      });
      if (!result.paper) return;
      const { paper } = result;
      await textDraft.clear('');
      router.push(
        `/paper/${encodeURIComponent(paper.slug)}${source ? `?source=${encodeURIComponent(source)}` : ''}`,
      );
    } catch (e) {
      setErr((e as Error).message ?? 'Could not add the paper.');
    }
  }

  return (
    <Card style={{ marginTop: space.xl, gap: space.sm }}>
      <Text variant="title">Have a specific paper?</Text>
      <Text variant="caption">
        Paste a paper title, an arXiv link or id, or a direct PDF link. It’s added to your
        library and fetched when you open it — with an agentic web hunt if it’s hard to find.
      </Text>
      <TextInput
        value={text}
        onChangeText={setText}
        style={styles.specificInput}
        placeholder="Paste arXiv link, DOI, or title"
        placeholderTextColor={t.muted}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={submit}
      />
      <Button
        title="Add to library"
        variant="ghost"
        onPress={submit}
        loading={addPaper.isPending}
        disabled={!text.trim()}
      />
      {err ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: 4 }}>
          {err}
        </Text>
      ) : null}
    </Card>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  body: { padding: space.md, paddingBottom: space.xxl },
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
  specificInput: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
  },
  progressPanel: { gap: space.md, marginTop: space.md, alignItems: 'center' },
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
  addBtn: { height: 40, paddingHorizontal: space.lg },
  footer: {
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: t.line,
    backgroundColor: t.bg,
  },
  errorCard: { marginTop: space.md, borderColor: t.danger },
  suggestionCard: { borderColor: t.line2 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' },
  actionBtn: {
    height: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: t.line2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});
