// Bottom-sheet for a reading session: the paper's most significant related works (from the
// reference graph) — prior work it builds on / compares against, and project papers that build
// on it — each with the extracted reason it matters. In-project entries jump straight into
// that paper's discussion; external ones can be added to the reading list or opened at their
// source. The analyst's context lists the same entries, so it can say "see X in your Related
// works menu" and the menu will actually contain X.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';

import { useAddPaper, useGraph, useRelatedWorks } from '@/api/queries';
import type { GraphRetrievalCandidate, Paper, RelatedWork } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { canStartGraphBuild } from '@/graph/buildAvailability';
import {
  useGraphBuild,
  type GraphBuildProgress,
  type GraphBuildState,
  type PaperBuildStatus,
} from '@/hooks/useGraphBuild';
import { Button, Card, Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { fullPaperUrl } from '@/lib/paperLinks';

export function RelatedWorksSheet({
  pid,
  slug,
  papers,
  visible,
  onClose,
  onOpenPaper,
}: {
  pid: string | null;
  slug: string | null;
  papers: Paper[];
  visible: boolean;
  onClose: () => void;
  onOpenPaper: (slug: string) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const related = useRelatedWorks(pid, slug, visible); // fetch only once the menu opens
  // GET /graph already carries both the cheap freshness status and the retained build snapshot.
  // Keep it dormant with the sheet, then use that snapshot to rejoin work started elsewhere.
  const graph = useGraph(pid, visible);
  // A hidden sheet must not leave a second poller running beside the Map tab. The server job is
  // durable; reopening fetches its retained snapshot and resumes from there.
  const build = useGraphBuild(visible ? pid : null, { completionToast: false });
  const status = graph.data?.status ?? null;
  const works = related.data ?? [];
  const resumeBuild = build.resume;
  const refetchGraph = graph.refetch;
  const graphRevision = graph.data?.graph?.revision ?? graph.data?.status.graph_revision ?? null;
  const observedRevision = useRef<string | null | undefined>(undefined);

  // Project queries remain fresh for 30 seconds. Without an explicit read on this edge, a quick
  // close/reopen can reuse the pre-start `{build: null}` snapshot and falsely offer another build
  // while the durable server job is already running. Force this cheap status read on every open;
  // TanStack deduplicates it with an ordinary stale refetch when both are due.
  useEffect(() => {
    if (!visible || !pid) return;
    void refetchGraph();
  }, [visible, pid, refetchGraph]);

  useEffect(() => {
    if (!visible) return;
    resumeBuild(graph.data?.build);
  }, [visible, graph.data?.build, resumeBuild]);

  // Related works are a derived view of the persisted graph. The build hook publishes both the
  // fast skeleton and final graph into this query cache; refresh the cards at those revision
  // boundaries without polling the heavier related-work endpoint on every progress tick.
  useEffect(() => {
    if (!visible) {
      observedRevision.current = undefined;
      return;
    }
    if (!graph.data) return;
    if (observedRevision.current === undefined) {
      observedRevision.current = graphRevision;
      return;
    }
    if (observedRevision.current !== graphRevision) {
      observedRevision.current = graphRevision;
      void related.refetch();
    }
  }, [visible, graph.data, graphRevision, related.refetch]);

  const initialLoading =
    (!related.data && related.isLoading) || (!graph.data && graph.isLoading);
  const initialError = !related.data && related.isError;
  const graphUnavailable = !graph.data && graph.isError;
  const needsUpdate = Boolean(
    status?.has_graph && (status.graph_needs_enrichment || status.stale_papers.length > 0),
  );
  const canBuild = canStartGraphBuild(status);
  const candidateSources = build.progress?.retrievalCandidates
    ?? status?.retrieval_candidates
    ?? {};

  return (
    <BottomSheet visible={visible} onClose={onClose} scrollable>
      <Text variant="editorial" style={{ marginBottom: 4 }}>
        Related works
      </Text>
      <Text variant="caption" style={{ marginBottom: space.md }}>
        The works this paper leans on most, and project papers that build on it
      </Text>

      {initialLoading ? (
        <ActivityIndicator color={t.mint} style={{ paddingVertical: space.xl }} />
      ) : initialError ? (
        <Card style={styles.errorCard}>
          <Text variant="body" color={t.danger} style={{ textAlign: 'center' }}>
            Could not load the related-works status.
          </Text>
          <Button
            title="Try again"
            variant="ghost"
            onPress={() => {
              void graph.refetch();
              void related.refetch();
            }}
            style={{ marginTop: space.sm }}
          />
        </Card>
      ) : (
        <View style={styles.content}>
          {graphUnavailable ? (
            <Card style={styles.errorCard}>
              <Text variant="body" color={t.danger}>
                Could not check the map or its current build. Related works already loaded are
                still available below.
              </Text>
              <Button
                title="Retry status"
                variant="ghost"
                onPress={() => void graph.refetch()}
                style={{ marginTop: space.sm }}
              />
            </Card>
          ) : null}

          {build.progress ? (
            <RelatedBuildProgress progress={build.progress} papers={papers} />
          ) : null}

          {build.error ? (
            <Card style={styles.errorCard}>
              <Text variant="body" color={t.danger}>{build.error}</Text>
              <Button
                title="Retry build"
                variant="ghost"
                disabled={!canBuild}
                onPress={() => void build.run(false)}
                style={{ marginTop: space.sm }}
              />
            </Card>
          ) : null}

          <SourceConfirmations candidates={candidateSources} build={build} />

          {works.map((work) => (
            <RelatedCard key={work.id} pid={pid} work={work} onOpenPaper={onOpenPaper} />
          ))}

          {!works.length ? (
            <Text variant="body" color={t.muted} style={styles.emptyCopy}>
              {build.building
                ? 'Related works will appear here as the map gains evidence.'
                : !status
                  ? 'Map status is unavailable right now.'
                  : status.has_graph
                  ? 'No significant related works surfaced for this paper yet.'
                  : 'No related works yet. Build the project reference map here; it keeps running if you close this sheet.'}
            </Text>
          ) : null}

          {!build.building && !build.error && status && (!status.has_graph || needsUpdate) ? (
            <View style={styles.buildOffer}>
              <Text variant="caption" color={t.muted} style={{ textAlign: 'center' }}>
                {status?.has_graph
                  ? 'Only changed or unfinished papers are processed; existing work stays cached.'
                  : 'Starting may use your model allowance. Nothing begins until you tap below.'}
              </Text>
              <Button
                title={status?.has_graph ? 'Update related works' : 'Build related works'}
                disabled={!canBuild}
                loading={build.building}
                onPress={() => void build.run(false)}
              />
            </View>
          ) : null}
        </View>
      )}
    </BottomSheet>
  );
}

const ACTIVE_STATUSES = new Set<PaperBuildStatus>(['metadata', 'retrieving', 'extracting']);
const ATTENTION_STATUSES = new Set<PaperBuildStatus>([
  'needs_confirmation',
  'not_found',
  'error',
]);

const STATUS_LABELS: Record<PaperBuildStatus, string> = {
  pending: 'Waiting',
  metadata: 'Mapping references',
  metadata_cached: 'References mapped',
  retrieving: 'Retrieving full text',
  retrieval_cached: 'Full text ready',
  needs_confirmation: 'Source confirmation needed',
  extracting: 'Reading full text',
  cached: 'Analysis reused',
  done: 'Analyzed',
  not_found: 'Source unavailable',
  error: 'Needs attention',
};

function RelatedBuildProgress({
  progress,
  papers,
}: {
  progress: GraphBuildProgress;
  papers: Paper[];
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const titles = new Map(papers.map((paper) => [paper.slug, paper.title]));
  const events = Object.entries(progress.perPaper);
  const complete = progress.phase === 'complete';

  return (
    <Card style={styles.progressCard}>
      <View style={styles.progressHeader}>
        <View style={{ flex: 1 }}>
          <Text variant="overline" color={t.mint}>RELATED WORKS</Text>
          <Text variant="heading">{complete ? 'Related works updated' : 'Building related works…'}</Text>
        </View>
        <Text variant="caption" color={t.muted}>
          {progress.ready > 0
            ? `${progress.done} of ${progress.ready} analyzed`
            : `${progress.done} analyzed`}
        </Text>
      </View>
      <Text variant="caption" color={t.muted} style={{ marginTop: 4 }}>
        {complete
          ? `${progress.done} paper${progress.done === 1 ? '' : 's'} analyzed`
          : 'You can close this sheet and return without interrupting the build.'}
      </Text>

      {events.length ? (
        <View style={styles.eventList}>
          {events.map(([paperSlug, paperStatus]) => {
            const active = ACTIVE_STATUSES.has(paperStatus);
            const attention = ATTENTION_STATUSES.has(paperStatus);
            const title = titles.get(paperSlug)
              ?? (progress.currentSlug === paperSlug ? progress.currentTitle : null)
              ?? paperSlug;
            return (
              <View key={paperSlug} style={styles.eventRow}>
                {active ? (
                  <ActivityIndicator size="small" color={t.mint} />
                ) : (
                  <Icon
                    name={attention ? 'alert-circle' : 'check-circle'}
                    size={16}
                    color={attention ? t.amber : t.mint}
                  />
                )}
                <View style={{ flex: 1 }}>
                  <Text variant="body" numberOfLines={2}>{title}</Text>
                  <Text variant="caption" color={attention ? t.amber : t.muted}>
                    {STATUS_LABELS[paperStatus]}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : progress.currentTitle ? (
        <Text variant="body" style={{ marginTop: space.md }}>
          {progress.currentTitle}
        </Text>
      ) : null}
    </Card>
  );
}

function SourceConfirmations({
  candidates,
  build,
}: {
  candidates: Record<string, GraphRetrievalCandidate[]>;
  build: GraphBuildState;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const entries = Object.entries(candidates).filter(([, options]) => options.length > 0);
  if (!entries.length || build.building) return null;
  return (
    <Card style={styles.confirmationCard}>
      <Text variant="heading">Confirm paper sources</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: 4 }}>
        These matches were not confident enough to retrieve automatically. Choosing one starts
        an incremental build and may use your model allowance.
      </Text>
      {entries.map(([paperSlug, options]) => (
        <View key={paperSlug} style={{ gap: space.xs, marginTop: space.sm }}>
          {options.slice(0, 3).map((candidate) => (
            <Button
              key={candidate.arxiv_id}
              title={`${candidate.title} · arXiv:${candidate.arxiv_id}`}
              variant="ghost"
              onPress={() => void build.run(false, { [paperSlug]: candidate.arxiv_id })}
            />
          ))}
        </View>
      ))}
    </Card>
  );
}

function RelatedCard({
  pid,
  work,
  onOpenPaper,
}: {
  pid: string | null;
  work: RelatedWork;
  onOpenPaper: (slug: string) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const addPaper = useAddPaper(pid ?? '');
  const [added, setAdded] = useState(false);
  const inProject = work.kind === 'project' && !!work.slug;
  const link = fullPaperUrl(work);
  const meta = [
    work.year ?? null,
    work.direction === 'builds_on' ? 'builds on it' : 'builds on this paper',
    inProject ? (work.list_status === 'read' ? 'in project · read' : 'in project') : 'external',
    work.citation_count ? `~${work.citation_count.toLocaleString()} citations` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  async function handleAdd() {
    if (!pid || added) return;
    try {
      const result = await addPaper.mutateAsync({
        title: work.title,
        arxivId: work.arxiv_id ?? undefined,
        year: work.year ?? undefined,
      });
      if (!result.paper) return;
      setAdded(true);
    } catch {
      // surfaced inline via addPaper.isError
    }
  }

  return (
    <Card style={styles.card}>
      <Text variant="serifTitle" numberOfLines={3}>
        {work.title}
      </Text>
      <Text variant="caption" style={{ marginTop: 4 }}>
        {meta}
      </Text>
      {work.reason ? (
        <View style={{ marginTop: space.sm }}>
          <Text variant="label" color={t.violet}>
            Why it matters here
          </Text>
          <Text variant="body" style={{ marginTop: 2, fontSize: 14.5, lineHeight: 21 }}>
            {work.reason}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {inProject ? (
          <Pressable
            onPress={() => onOpenPaper(work.slug!)}
            style={[styles.actionBtn, styles.actionBtnPrimary]}
            accessibilityLabel={`Open ${work.title}`}
          >
            <Text variant="caption" color={t.mintInk} style={{ fontFamily: fonts.bodySemiBold }}>
              Open discussion
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleAdd}
            disabled={added || addPaper.isPending}
            style={[styles.actionBtn, added ? { borderColor: t.mint } : styles.actionBtnPrimary]}
            accessibilityLabel={`Add ${work.title} to project`}
          >
            {addPaper.isPending ? (
              <ActivityIndicator size="small" color={t.mintInk} />
            ) : (
              <Text
                variant="caption"
                color={added ? t.mint : t.mintInk}
                style={added ? null : { fontFamily: fonts.bodySemiBold }}
              >
                {added ? 'Added' : 'Add to project'}
              </Text>
            )}
          </Pressable>
        )}
        {link ? (
          <Pressable
            onPress={() => Linking.openURL(link)}
            style={styles.actionBtn}
            accessibilityLabel={`Open full paper for ${work.title}`}
          >
            <Icon name="external-link" size={12} color={t.muted} />
            <Text variant="caption" color={t.muted}>
              Open full paper
            </Text>
          </Pressable>
        ) : null}
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
  content: { gap: space.sm, paddingBottom: space.xl },
  emptyCopy: { paddingVertical: space.lg, textAlign: 'center' },
  buildOffer: { gap: space.sm },
  progressCard: { borderColor: t.mint },
  progressHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  eventList: { marginTop: space.md },
  eventRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.line2,
    paddingVertical: space.sm,
  },
  confirmationCard: { borderColor: t.amber },
  errorCard: { borderColor: t.danger },
  card: { borderColor: t.line2 },
  actions: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.md,
    alignItems: 'center',
  },
  actionBtn: {
    height: 38,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  // Mint fill for the card's main CTA (frame 06); mintInk text is only legible on this fill.
  actionBtnPrimary: { backgroundColor: t.mint, borderColor: t.mint },
});
