// Discover — bootstrap a project's reading list from the researcher's goals. A clean text
// field ("what do you want to understand, learn, or explore?") starts a server-side discovery
// job (app/discovery.py): LLM-planned broad+narrow arXiv searches, citation counts, and a
// relevance ranking. The screen polls the job for live phase progress (job survives
// backgrounding — see useDiscoveryRun), then shows the top suggestions with the rest behind
// "show more". A "specific paper" box covers the other entry path: paste a title or an
// arXiv/PDF link, and the existing retrieval flow (deterministic -> agentic hunt) takes over
// on the paper's Discussion screen.

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAddPaper, useDiscovery } from '@/api/queries';
import type { DiscoveryJob, PaperSuggestion } from '@/api/types';
import { TabHeader } from '@/components/TopBar';
import { useDiscoveryRun } from '@/hooks/useDiscoveryRun';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { useActiveProject } from '@/store/project';
import { Button, Card, Icon, Screen, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

export default function DiscoverScreen() {
  const router = useRouter();
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
              <Text variant="overline">Project goals</Text>
              <Text variant="caption">
                Describe what you want to understand, learn, or explore. We’ll search arXiv and
                suggest the most fundamental papers to start from.
              </Text>
              <TextInput
                value={goals}
                onChangeText={setGoals}
                multiline
                style={styles.goalsInput}
                placeholder="e.g. I want to understand 3D-integrated DRAM: how vertical stacking changes bandwidth, latency and thermals, and what architectures exist…"
                placeholderTextColor={colors.muted}
                editable={!runState.running}
              />
              <Button
                title={runState.running ? 'Searching…' : result ? 'Search again' : 'Find readings'}
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
              accessibilityLabel="Edit project goals">
              <Card style={styles.goalsSummary}>
                <View style={styles.goalsHead}>
                  <Text variant="overline">Project goals</Text>
                  {!runState.running ? (
                    <Text variant="label" color={colors.mint}>
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
              <Text variant="body" color={colors.danger}>
                {runState.error}
              </Text>
              <Button title="Dismiss" variant="ghost" onPress={runState.clearError} style={{ marginTop: space.sm }} />
            </Card>
          ) : null}

          {result && !runState.running ? (
            <View style={{ marginTop: space.xl }}>
              <Text variant="editorial">Recommended foundations</Text>
              <Text variant="body" color={colors.muted} style={{ marginTop: 2 }}>
                Why these papers fit your project
              </Text>
              <Text variant="caption" color={colors.muted} style={{ marginTop: space.xs, marginBottom: space.md }}>
                {result.focus ? `${result.focus} · ` : ''}Ranked {result.candidate_count} arXiv
                papers by relevance to your goals and citations.
              </Text>
              <View style={{ gap: space.sm }}>
                {visible.map((s, i) => (
                  <SuggestionCard
                    key={s.arxiv_id}
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
          {pid ? (
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

const PHASE_ORDER = ['queries', 'searching', 'citations', 'scoring', 'done'] as const;

// The mint check timeline from Figma `02 · Discover` ("Planned → Reviewed → Checked →
// Ranked"), with the live phase's detail line underneath — the polled job data the old
// vertical panel showed, kept.
function ProgressPanel({ job }: { job: DiscoveryJob }) {
  const current = PHASE_ORDER.indexOf(job.phase);
  const steps = [
    { key: 'queries', label: 'Planned', detail: job.focus },
    {
      key: 'searching',
      label: 'Searched',
      detail: job.total_queries
        ? `${job.searched}/${job.total_queries} searches · ${job.found} papers`
        : 'Searching arXiv…',
    },
    { key: 'citations', label: 'Checked', detail: `Citations for ${job.found} papers` },
    { key: 'scoring', label: 'Ranked', detail: 'Ranking by relevance to your goals' },
  ];
  const active = steps[Math.min(Math.max(current, 0), steps.length - 1)];
  const done = job.phase === 'done' || job.status === 'done';
  return (
    <Card style={styles.progressPanel}>
      <Text variant="serifTitle" color={colors.mint}>
        {done ? 'Search complete' : 'Searching…'}
      </Text>
      <View style={styles.stepsRow}>
        {steps.map((step, i) => {
          const state = done || i < current ? 'done' : i === current ? 'active' : 'pending';
          return (
            <View key={step.key} style={styles.step}>
              {i > 0 ? <View style={[styles.stepLine, state !== 'pending' && styles.stepLineDone]} /> : null}
              <View style={[styles.stepDot, state === 'done' && styles.stepDotDone]}>
                {state === 'done' ? (
                  <Icon name="check" size={13} color={colors.mintInk} />
                ) : state === 'active' ? (
                  <ActivityIndicator size="small" color={colors.mint} />
                ) : null}
              </View>
              <Text variant="caption" color={state === 'pending' ? colors.muted : colors.text}>
                {step.label}
              </Text>
            </View>
          );
        })}
      </View>
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
  const addPaper = useAddPaper(pid);
  const [added, setAdded] = useState(false);
  const [showAbstract, setShowAbstract] = useState(false);

  const authors = s.authors.length > 2 ? `${s.authors[0]} et al.` : s.authors.join(', ');
  const meta = [
    authors || null,
    s.year,
    s.citation_count != null ? `~${s.citation_count.toLocaleString()} citations` : null,
    `arXiv:${s.arxiv_id}`,
  ]
    .filter(Boolean)
    .join(' · ');

  async function handleAdd() {
    if (added) return;
    try {
      await addPaper.mutateAsync({ title: s.title, arxivId: s.arxiv_id, abstract: s.abstract });
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
          <Icon name="check" size={14} color={colors.mint} />
          <Text variant="caption" color={colors.text} style={{ flex: 1, opacity: 0.85 }}>
            {s.reasons[0]}
          </Text>
        </View>
      ) : null}

      {showAbstract ? (
        <Text variant="body" color={colors.muted} style={{ marginTop: space.sm, fontSize: 14, lineHeight: 21 }}>
          {s.abstract}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => setShowAbstract((v) => !v)}
          style={styles.actionBtn}
          accessibilityLabel={`${showAbstract ? 'Hide' : 'Show'} abstract for ${s.title}`}>
          <Text variant="caption" color={colors.muted}>
            {showAbstract ? 'Hide abstract' : 'Abstract'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => Linking.openURL(s.url)}
          style={styles.actionBtn}
          accessibilityLabel={`Open ${s.title} on arXiv`}>
          <Icon name="external-link" size={13} color={colors.muted} />
          <Text variant="caption" color={colors.muted}>arXiv</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Button
          title={added ? 'Added' : 'Add'}
          icon={added ? 'check' : 'plus'}
          onPress={handleAdd}
          loading={addPaper.isPending}
          disabled={added || addPaper.isPending}
          style={styles.addBtn}
          accessibilityLabel={`Add ${s.title} to library`}
        />
      </View>
      {addPaper.isError ? (
        <Text variant="caption" color={colors.danger} style={{ marginTop: 4 }}>
          {(addPaper.error as Error).message}
        </Text>
      ) : null}
    </Card>
  );
}

// ---------- bring a specific paper (name / arXiv link / PDF link) ----------

function SpecificPaper({ pid }: { pid: string }) {
  const router = useRouter();
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
      const { paper } = await addPaper.mutateAsync({ title, arxivId });
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
        placeholderTextColor={colors.muted}
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
        <Text variant="caption" color={colors.danger} style={{ marginTop: 4 }}>
          {err}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.md, paddingBottom: space.xxl },
  goalsInput: {
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    padding: space.md,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15,
    minHeight: 130,
    textAlignVertical: 'top',
    lineHeight: 22,
  },
  specificInput: {
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15,
  },
  progressPanel: { gap: space.md, marginTop: space.md, alignItems: 'center' },
  stepsRow: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
  },
  step: { alignItems: 'center', gap: 6, flex: 1 },
  stepLine: {
    position: 'absolute',
    top: 14,
    right: '50%',
    left: '-50%',
    height: 2,
    backgroundColor: colors.line2,
  },
  stepLineDone: { backgroundColor: colors.mint },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.line2,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotDone: { backgroundColor: colors.mint, borderColor: colors.mint },
  goalsSummary: { padding: space.md, borderColor: colors.line2 },
  goalsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rankNum: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 24,
    lineHeight: 30,
    color: colors.violet,
  },
  reasonRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: space.sm },
  addBtn: { height: 40, paddingHorizontal: space.lg },
  footer: {
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
  },
  errorCard: { marginTop: space.md, borderColor: colors.danger },
  suggestionCard: { borderColor: colors.line2 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' },
  actionBtn: {
    height: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});
