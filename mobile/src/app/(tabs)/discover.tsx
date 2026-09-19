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
// Adding a paper the reader already knows is deliberately not a footer on this potentially long
// result screen. DR-149 moves that entry to the active project's Library Plus sheet, which links
// back here when the reader actually wants exploration.

import { Redirect, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  keys,
  useAddPaper,
  useDiscovery,
  useGraphRecommendations,
  useNeighbourhood,
  useProjectMembership,
} from '@/api/queries';
import type {
  DiscoveryJob,
  GraphRecommendation,
  HiddenRecommendation,
  PaperSuggestion,
} from '@/api/types';
import { NeighbourhoodLine, relativeAge } from '@/components/NeighbourhoodLine';
import { DiscoverLoadingSkeleton } from '@/components/LoadingSkeletons';
import { ProgressSteps } from '@/components/ProgressSteps';
import { ScanningList } from '@/components/ScanningList';
import { useDiscoveryRun } from '@/hooks/useDiscoveryRun';
import { useDelayedInitialSkeleton } from '@/hooks/useDelayedInitialSkeleton';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { discoverProgress } from '@/lib/discoverProgress';
import { fullPaperUrl } from '@/lib/paperLinks';
import { useActiveProject } from '@/store/project';
import { Button, Card, Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { control, fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export const DISCOVER_PLACEHOLDER = 'Type a topic or question';

export function discoverySkipLabel(phase: DiscoveryJob['phase']): string {
  if (phase === 'searching') return 'Skip search';
  if (phase === 'citations') return 'Skip citations';
  if (phase === 'evidence') return 'Skip evidence';
  return 'Skip next step';
}

/** First occurrence wins: the ranked order is the server's, and the later copy of a duplicate is
 *  the lower-ranked one. Rows with no candidate id at all are kept as-is — a missing id is not
 *  evidence of sameness. */
export function dedupeSuggestions<T extends { candidate_id?: string | null }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = row.candidate_id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export type UnifiedSuggestion = PaperSuggestion & {
  recommendation_provenance: 'Search result' | 'Project graph' | 'Search result · Project graph';
};

// Match the Map sheet's high-signal ceiling. Real projects already hold 1,000+ low-signal
// candidates; mounting all of them as hook-owning cards in a plain ScrollView stalls the device.
export const MAX_UNIFIED_GRAPH_RECOMMENDATIONS = 100;
const NO_QUERY_SUGGESTIONS: PaperSuggestion[] = [];
const NO_GRAPH_RECOMMENDATIONS: GraphRecommendation[] = [];

/** Adapt the Map's persisted, project-ranked recommendation into the richer Discover card shape.
 *
 * This stays client-side so the stable GET /graph contract does not grow view-specific aliases.
 * Fields the graph cannot know are honestly empty; the card already treats abstract,
 * affiliations, and provider URLs as optional presentation. */
export function graphRecommendationToSuggestion(rec: GraphRecommendation): UnifiedSuggestion {
  const graphIdentity = rec.id.replace(/^ext:/, '');
  const paperId = graphIdentity.startsWith('s2:') ? graphIdentity.slice(3) : undefined;
  return {
    candidate_id: `graph:${rec.id}`,
    arxiv_id: rec.arxiv_id,
    doi: rec.doi,
    paper_id: paperId,
    title: rec.title,
    authors: rec.authors ?? [],
    affiliations: [],
    year: rec.year,
    category: '',
    venue: rec.venue || undefined,
    url: rec.url ?? '',
    pdf_url: '',
    citation_count: rec.citation_count ?? null,
    sources: rec.provenance?.includes('semantic_scholar') ? ['semantic_scholar'] : [],
    relevance: 0,
    credibility: 0,
    score: rec.recommend_score,
    reasons: rec.recommend_reasons ?? [],
    recommendation_provenance: 'Project graph',
  };
}

function normalizedIdentity(row: PaperSuggestion) {
  const arxiv = (row.arxiv_id ?? '').trim().toLowerCase().replace(/v\d+$/, '');
  const doi = (row.doi ?? '').trim().toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  const paperId = (row.paper_id ?? '').trim().toLowerCase();
  const title = row.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return { arxiv, doi, paperId, title };
}

function sameSuggestedWork(a: PaperSuggestion, b: PaperSuggestion): boolean {
  const left = normalizedIdentity(a);
  const right = normalizedIdentity(b);
  if (
    (left.arxiv && left.arxiv === right.arxiv)
    || (left.doi && left.doi === right.doi)
    || (left.paperId && left.paperId === right.paperId)
  ) {
    return true;
  }
  // A title is only a fallback. If both lanes name the same kind of strong identity and
  // disagree, they are two works despite sharing a title (the wrong-PDF hazard behind DR-126).
  if (
    (left.arxiv && right.arxiv && left.arxiv !== right.arxiv)
    || (left.doi && right.doi && left.doi !== right.doi)
    || (left.paperId && right.paperId && left.paperId !== right.paperId)
  ) {
    return false;
  }
  return !!left.title && left.title === right.title;
}

/** One ranked list, never blended score scales: query-ranked rows lead, then the Map's existing
 * project ranking. A cross-lane duplicate keeps the query card but gains any distinct project
 * provenance, so de-duplication does not erase why the corpus itself recommended it. */
export function mergeRecommendationLanes(
  queryRows: PaperSuggestion[],
  graphRows: GraphRecommendation[],
): UnifiedSuggestion[] {
  const merged: UnifiedSuggestion[] = dedupeSuggestions(queryRows).map((row) => ({
    ...row,
    recommendation_provenance: 'Search result',
  }));
  for (const recommendation of graphRows.slice(0, MAX_UNIFIED_GRAPH_RECOMMENDATIONS)) {
    const graphRow = graphRecommendationToSuggestion(recommendation);
    const existing = merged.find((row) => sameSuggestedWork(row, graphRow));
    if (!existing) {
      merged.push(graphRow);
      continue;
    }
    existing.reasons = Array.from(new Set([
      ...(existing.reasons ?? []),
      ...(graphRow.reasons ?? []),
    ]));
    existing.sources = Array.from(new Set([
      ...(existing.sources ?? []),
      ...(graphRow.sources ?? []),
    ])) as PaperSuggestion['sources'];
    existing.recommendation_provenance = 'Search result · Project graph';
  }
  return merged;
}

/** DR-136 — attribute `result.focus` to the run that wrote it.
 *
 *  `focus` is the query planner's one-line restatement of what it decided to search for
 *  (app/discovery.generate_queries). It is saved with the results and can therefore be much
 *  older than the goals now in the box above — Kamil's read it as "maybe from a previous
 *  search", which is close: it is from the run whose results he was looking at, not from the
 *  goals he last typed. It is only unexplained because it was printed with no label and no
 *  date, so this says both. Returns '' when there is no focus to attribute (a result saved
 *  before the field existed, or a run whose planner returned none), so the line disappears
 *  rather than reading "Searched for “”".
 */
export function describeRunFocus(
  focus: string | undefined | null,
  generatedAt: string | undefined | null,
  now: number = Date.now(),
): string {
  const text = (focus ?? '').trim();
  if (!text) return '';
  const at = generatedAt ? Date.parse(generatedAt) : NaN;
  // A future or unparseable timestamp yields no age rather than "in -3d": the label is worth
  // showing even when the clock disagrees, and a wrong age is worse than none.
  const age = Number.isNaN(at) || at > now ? '' : relativeAge((now - at) / 1000);
  return age ? `Searched ${age} for “${text}”` : `Searched for “${text}”`;
}

export default function DiscoverRedirect() {
  return <Redirect href="/graph?explore=discover-route" />;
}

/** The complete query-to-ranked-results experience without its tab chrome.
 *
 * DR-052's combined Map renders this inline below the graph. `embedded=false` remains for the
 * empty-project first-paper state, where there is no graph viewport or parent scroller. */
export function DiscoverContent({
  embedded = false,
  editorRequest,
  showNeighbourhood = true,
}: {
  embedded?: boolean;
  /** A changed non-empty token opens the editor when an old /discover entry point lands here. */
  editorRequest?: string;
  /** The combined Map already renders the shared freshness line above its graph. */
  showNeighbourhood?: boolean;
} = {}) {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { activePid: pid } = useActiveProject();
  const discovery = useDiscovery(pid);
  const graphRecommendationsQuery = useGraphRecommendations(pid);
  const showDiscoverySkeleton = useDelayedInitialSkeleton(
    discovery.isLoading,
    discovery.data !== undefined,
  );
  const runState = useDiscoveryRun(pid);
  const neighbourhood = useNeighbourhood(pid);
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
    if (editorRequest) setEditingGoals(true);
  }, [editorRequest]);
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
  // DR-113 — a result can carry the SAME paper twice. The server no longer produces that (an
  // arXiv DOI and a publisher DOI for one arXiv id used to count as two different papers, and
  // the loser then overwrote the winner's slot), but results already saved on disk still hold
  // the duplicate, and re-running Discover costs a paid multi-minute run. Collapsing here means
  // an existing result stops showing one paper twice — and the list's React keys, which are
  // candidate ids, stay unique instead of raising an error over the results.
  const graphRecommendations = graphRecommendationsQuery.data ?? NO_GRAPH_RECOMMENDATIONS;
  const querySuggestions = result?.suggestions ?? NO_QUERY_SUGGESTIONS;
  const suggestions = useMemo(
    () => mergeRecommendationLanes(querySuggestions, graphRecommendations),
    [querySuggestions, graphRecommendations],
  );
  const inLibrary = dedupeSuggestions(result?.in_library ?? []);
  const topN = result?.top_n ?? 5;
  const visible = showAll ? suggestions : suggestions.slice(0, topN);
  const hiddenCount = suggestions.length - Math.min(topN, suggestions.length);

  const searchedFor = describeRunFocus(result?.focus, result?.generated_at);

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

  const content = (
    <>
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
                skipping={runState.skipping}
                onCancel={runState.cancel}
                onSkip={runState.skip}
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

          {/* The query only represents saved results. Keep the real search controls and any
              reattached job progress visible while its empty cache warms up. */}
          {discovery.isLoading
          && discovery.data === undefined
          && !runState.running
          && showDiscoverySkeleton ? (
            <DiscoverLoadingSkeleton />
          ) : null}

          {(result || suggestions.length > 0) && !runState.running ? (
            <View style={{ marginTop: space.xl }}>
              {/* DR-052 PR 4: the shared neighbourhood line — the same freshness the Map shows,
                  since Discover's forward-citation sweep and the Map read one substrate. Its
                  refresh IS a Discover run (which re-sweeps), so it reuses runDiscovery. */}
              {pid && showNeighbourhood ? (
                <NeighbourhoodLine
                  neighbourhood={neighbourhood.data}
                  onRefresh={() => void runDiscovery()}
                  refreshLabel="Refresh"
                />
              ) : null}
              <Text variant="editorial">
                {runState.job?.status === 'cancelled' ? 'Previous results' : 'Papers to add'}
              </Text>
              {/* DR-136 — Kamil: "Unexplained text at the top of Discover … 'Reinforcement
                  Learning for robotics…', I think that shouldn't be there. Maybe from a previous
                  search." It is `result.focus`: the model's one-line restatement of what the
                  SAVED run searched for, written when that run planned its queries. Legitimate
                  and worth keeping — on his own results it is the only thing on the screen that
                  explains why an LLM-serving project was searched for robotics — but it was
                  pasted in front of the sentence about the results with no label and no date, so
                  it read as a caption on papers it does not describe. Labelled and dated, it says
                  what it is and that it is months old, which is the actionable half. */}
              <View style={{ marginTop: space.xs, marginBottom: space.md }}>
                {result ? (
                  <Text variant="caption" color={t.muted}>
                    {result.candidate_count} papers across scholarly sources; search matches lead,
                    followed by recommendations from this project’s citation patterns.
                  </Text>
                ) : (
                  <Text variant="caption" color={t.muted}>
                    Ranked from this project’s citation patterns.
                  </Text>
                )}
                {searchedFor ? (
                  <Text
                    testID="discover-run-focus"
                    variant="caption"
                    color={t.muted}
                    numberOfLines={3}
                    style={{ marginTop: 2, opacity: 0.75 }}>
                    {searchedFor}
                  </Text>
                ) : null}
              </View>
              {visible.length > 0 ? (
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
              ) : null}
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
              {inLibrary.length > 0 ? <InLibraryRow items={inLibrary} /> : null}
            </View>
          ) : null}

    </>
  );
  const footer = addedCount > 0 ? (
    <View style={styles.footer}>
      <Button
        title={`Go to library · ${addedCount} added`}
        onPress={() => router.navigate('/')}
      />
    </View>
  ) : null;

  if (embedded) {
    return (
      <View>
        <View style={styles.body}>{content}</View>
        {footer}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {content}
      </ScrollView>
      {footer}
    </KeyboardAvoidingView>
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
  skipping,
  onCancel,
  onSkip,
}: {
  job: DiscoveryJob;
  cancelling: boolean;
  skipping: boolean;
  onCancel: () => Promise<boolean>;
  onSkip: () => Promise<boolean>;
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
        <>
          {skipping || job.skip_requested ? (
            <Text variant="caption" color={t.muted} style={{ textAlign: 'center' }}>
              Skipping at the next stage boundary…
            </Text>
          ) : null}
          <View style={styles.runControls}>
            <Button
              title={skipping || job.skip_requested
                ? 'Skip requested'
                : discoverySkipLabel(job.phase)}
              variant="ghost"
              icon="skip-forward"
              onPress={() => void onSkip()}
              disabled={skipping || Boolean(job.skip_requested) || cancelling}
              accessibilityLabel="Skip discovery step"
              style={styles.runControl}
            />
            <Button
              title={cancelling ? 'Stopping…' : 'Stop search'}
              variant="ghost"
              icon="x"
              onPress={() => void onCancel()}
              loading={cancelling}
              accessibilityLabel="Stop discovery search"
              style={styles.runControl}
            />
          </View>
        </>
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
  suggestion: PaperSuggestion & Partial<Pick<UnifiedSuggestion, 'recommendation_provenance'>>;
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
  // Neither list cache is invalidated while the undo row shows: this card owns the app's only
  // unhide action and must stay mounted. The full Map cache is separate, so it can refresh now
  // and stop serving the hidden paper without removing this row. Undo refreshes all three views.
  // The card is keyed by pid+candidate at the call site, and an identity ref guards in-flight
  // responses against representing a different project.
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
      void qc.invalidateQueries({ queryKey: keys.graphRecommendations(requestPid) });
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
            accessibilityRole="button"
            style={styles.undoBtn}
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
  // DR-112 — Kamil: "Affiliation is a key paper information (to me even more important than
  // author names)." The field was already on the wire (OpenAlex authorship enrichment fills it,
  // and the scoring prompt reads it) and simply never drawn. It gets its own line rather than a
  // tail on the meta string, which already wraps to three lines on his phone; two institutions
  // is where a card stops informing and starts listing.
  // Blank entries are filtered, not just falsy-checked: OpenAlex returns an authorship with an
  // empty affiliation string when it knows the author but not the institution, and a list of
  // those rendered as a lone "·" (Opus review).
  const affiliationList = (s.affiliations ?? []).map((a) => (a ?? '').trim()).filter(Boolean);
  const affiliations = affiliationList.slice(0, 2).join(' · ')
    + (affiliationList.length > 2 ? ` +${affiliationList.length - 2}` : '');
  // DR-129 — Kamil, on his DR-112 pass: "remove DOI from the details shown, and affiliation can
  // go after authors and before venue. Citations last. No doi like I said." Two consequences.
  // The identifier tail goes ENTIRELY, not just its DOI branch: it is one slot rendering
  // `arXiv:…` when an arXiv id exists and `DOI:…` otherwise, and it sat after the citations that
  // he wants last. Nothing else on the card uses it — Full paper builds its own URL from
  // `url`/`pdf_url`, and Add passes `arxiv_id` from the suggestion, not from this string.
  // And the institutions rejoin the run in the position he named. They stay at DR-112's
  // fuller-strength colour, nested inside the meta line rather than beside it, so the reorder
  // costs none of the weight he asked for there ("more important than author names") while
  // reading in exactly the order he wrote: authors, affiliation, venue, citations.
  const metaParts: { key: string; text: string; strong?: boolean }[] = [];
  if (authors) metaParts.push({ key: 'authors', text: authors });
  if (s.year) metaParts.push({ key: 'year', text: String(s.year) });
  if (affiliationList.length) {
    metaParts.push({ key: 'affiliations', text: affiliations, strong: true });
  }
  if (s.venue) metaParts.push({ key: 'venue', text: s.venue });
  if (s.citation_count != null) {
    metaParts.push({ key: 'citations', text: `~${s.citation_count.toLocaleString()} citations` });
  }
  // The truncated "+N" is a width compromise; a screen reader has no width, so it hears the
  // whole list (DR-112's Opus review) — now on the meta line, since a nested Text inside a Text
  // is flattened and its own label would never be announced. The "Affiliations:" prefix DR-112's
  // review added rides along: sighted readers get the institutions' stronger colour, and colour
  // is the ONLY cue left once they share the meta line's separator, so the spoken line has to
  // name the field itself or it becomes an unmarked run of proper nouns.
  const metaLabel = metaParts
    .map((p) => (
      p.key === 'affiliations' ? `Affiliations: ${affiliationList.join(', ')}` : p.text
    ))
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
          <Text
            testID="suggestion-meta"
            variant="caption"
            style={{ marginTop: 2 }}
            accessibilityLabel={metaLabel || undefined}>
            {metaParts.map((part, i) => (
              <Text key={part.key} variant="caption">
                {i > 0 ? ' · ' : ''}
                {part.strong ? (
                  <Text
                    testID="suggestion-affiliations"
                    variant="caption"
                    color={t.text}
                    style={{ opacity: 0.85 }}>
                    {part.text}
                  </Text>
                ) : (
                  part.text
                )}
              </Text>
            ))}
          </Text>
        </View>
      </View>
      {s.recommendation_provenance ? (
        <Text variant="overline" color={t.muted} style={{ marginTop: space.sm }}>
          {s.recommendation_provenance}
        </Text>
      ) : null}
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
            accessibilityRole="button"
            style={[styles.actionBtn, showAbstract && styles.actionBtnActive]}
            accessibilityLabel={`${showAbstract ? 'Hide' : 'Show'} abstract for ${s.title}`}>
            <Icon name="align-left" size={20} color={showAbstract ? t.mint : t.muted} />
          </Pressable>
        ) : null}
        {paperUrl ? (
          <Pressable
            onPress={() => Linking.openURL(paperUrl)}
            accessibilityRole="button"
            style={styles.actionBtn}
            accessibilityLabel={`Open full paper for ${s.title}`}>
            <Icon name="external-link" size={20} color={t.muted} />
          </Pressable>
        ) : null}
        {!inLibrary ? (
          <Pressable
            onPress={() => void handleHide()}
            disabled={hideBusy}
            accessibilityRole="button"
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

/** DR-066 — Kamil: suggestions already on the reading list "shouldn't be included. We could
 *  have an option to reveal them, but not by default." A quiet collapsed count row under the
 *  results; expanding lists each excluded suggestion with the reading-list title it matched,
 *  so the reader can audit the exclusion without the duplicates competing with real results. */
export function InLibraryRow({ items }: { items: (PaperSuggestion & { library_match?: string })[] }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.inLibrary}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.inLibraryHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${items.length} suggestion${items.length === 1 ? '' : 's'} already in your library. Tap to ${open ? 'collapse' : 'expand'}.`}
      >
        <Icon name="check-circle" size={14} color={t.muted} />
        <Text variant="caption" color={t.muted} style={{ flex: 1 }}>
          {items.length} already in your library
        </Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={t.muted} />
      </Pressable>
      {open
        ? items.map((s) => (
            <View key={s.candidate_id} style={styles.inLibraryItem}>
              <Text variant="caption" numberOfLines={2}>{s.title}</Text>
              {s.library_match && s.library_match !== s.title ? (
                <Text variant="caption" color={t.muted} numberOfLines={1}>
                  matches “{s.library_match}”
                </Text>
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  inLibrary: {
    marginTop: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  inLibraryHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 32 },
  inLibraryItem: {
    marginTop: space.sm,
    paddingLeft: space.md + space.xs,
    gap: 2,
  },
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
  runControls: { alignSelf: 'stretch', flexDirection: 'row', gap: space.sm },
  runControl: { flex: 1, height: 42 },
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
  // DR-112: sits directly under the meta line, closer to it than the reason row is,
  // because it is part of what the paper IS rather than why it was suggested.
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
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm, alignItems: 'center' },
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
  // Opus review, PR #381: this used to share `actionBtn`, which the icon-button conversion
  // turned into a fixed 48x48 square with no horizontal padding — fine for a single icon, but
  // "Undo" is text and needs room to sit in, especially at a larger accessibility font scale.
  // Its own style keeps the auto-width/padded geometry while still meeting the touch-target floor.
  undoBtn: {
    minHeight: control.minTouch,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: t.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionKey: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    marginBottom: space.sm,
  },
  actionKeyItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
