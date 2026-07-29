// Library — the home tab. Project-scoped: a project switcher pill over a continue-reading
// hero, project progress, status filters, and the flat list of papers in the active
// project. Tapping a paper opens its Discussion. Layout follows Figma frame `01 · Library`.

import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { backfillCovers, getOpeningDraft, getSession } from '@/api/endpoints';
import {
  keys,
  useBaseUrl,
  useProjectState,
  useProjects,
  useRecentSessions,
  useRemovePaper,
  useRemovePapers,
} from '@/api/queries';
import type { Paper, RecentSession } from '@/api/types';
import { OptionsSheet } from '@/components/chat/OptionsSheet';
import { MoveToProjectSheet } from '@/components/MoveToProjectSheet';
import { PaperCover } from '@/components/PaperCover';
import { TabHeader } from '@/components/TopBar';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';
import { SplitProjectSheet } from '@/components/SplitProjectSheet';
import { useActiveProject } from '@/store/project';
import { loadLastThread } from '@/lib/lastThread';
import { fullPaperUrl } from '@/lib/paperLinks';
import {
  filterBucket,
  paperStateKey,
  sortPapers,
  SORTS,
  type SortKey,
  type StatusFilter,
} from '@/lib/paperSort';
import {
  DEFAULT_SORT,
  DEFAULT_SORT_DIRECTION,
  usePaperSortPreference,
} from '@/hooks/usePaperSortPreference';
import { useContinueCardDismissal } from '@/hooks/useContinueCardDismissal';
import {
  Button,
  Card,
  Chip,
  Icon,
  IconButton,
  ProgressBar,
  Screen,
  Text,
  type IconName,
} from '@/ui';
import {
  useTheme,
  useThemedStyles,
  type DensityMode,
} from '@/theme/ThemeProvider';
import { floatShadow, fonts, radius, space, stateMetaFor, type ThemePalette } from '@/theme/tokens';

// The base URL the cover backfill has already succeeded for (module-level so it survives Library
// remounts/tab switches). Set only after the POST resolves, so a transient failure — or a switch
// to a different/reachable server — is retried on the next mount rather than silently skipped.
let coverBackfillDoneFor: string | null = null;

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'toread', label: 'To read' },
  { key: 'inprogress', label: 'In progress' },
  { key: 'done', label: 'Done' },
];

export default function LibraryScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const queryClient = useQueryClient();
  const { activePid, setActivePid, ready } = useActiveProject();
  const baseUrl = useBaseUrl();
  const hasUrl = !!baseUrl;
  const projectsQuery = useProjects();
  const projects = projectsQuery.data;
  const recentQuery = useRecentSessions();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The project pill floats over the list (like the composer): measured so the scroll content
  // gets a matching top inset and papers scroll clear behind it (R12.6).
  const [pillHeight, setPillHeight] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const { sort, sortDirection, setSort, setSortDirection } = usePaperSortPreference(activePid);
  const [expandedSort, setExpandedSort] = useState<SortKey | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  // Multi-select (R8.1 → R9.13): long-press a paper to enter; the action bar offers Move (to a
  // new OR existing project) and Delete.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [splitOpen, setSplitOpen] = useState(false);
  const [moveDestOpen, setMoveDestOpen] = useState(false);  // the destination chooser
  const [moveDest, setMoveDest] = useState<{ pid: string; name: string } | null>(null);
  const [relocationMode, setRelocationMode] = useState<'move' | 'copy'>('move');

  function toggleSelected(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }
  function enterSelect(slug: string) {
    setSelectMode(true);
    setSelected(new Set([slug]));
  }
  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }
  // Leaving the project or the papers vanishing must not strand select mode.
  useEffect(() => {
    exitSelect();
  }, [activePid]);

  // Auto-select the first project if none is active yet.
  useEffect(() => {
    if (ready && !activePid && projects && projects.length > 0) {
      setActivePid(projects[0].id);
    }
  }, [ready, activePid, projects, setActivePid]);

  // Warm covers for pre-existing papers once the app has a server, so a resume/Continue-reading
  // panel never waits on an on-demand render. Mark the URL done only after the POST succeeds, so a
  // transient failure retries on the next mount. Server dedups, so an extra attempt is harmless.
  useEffect(() => {
    if (baseUrl && coverBackfillDoneFor !== baseUrl) {
      backfillCovers()
        .then(() => {
          coverBackfillDoneFor = baseUrl;
        })
        .catch(() => undefined);
    }
  }, [baseUrl]);

  const stateQuery = useProjectState(activePid);
  const activeProject = projects?.find((p) => p.id === activePid);
  const removePaper = useRemovePaper(activePid);
  const removePapers = useRemovePapers(activePid);

  // Batch-delete the multi-selection (R9.13). One confirmed destructive action → one atomic
  // server request (all removals in a single commit), so a disconnect can't half-apply it.
  // Notes are kept + marked removed, same as the single-paper swipe-remove.
  function confirmBatchDelete() {
    const slugs = [...selected];
    if (slugs.length === 0) return;
    Alert.alert(
      `Delete ${slugs.length} paper${slugs.length === 1 ? '' : 's'}?`,
      'They are removed from this project; their notes are kept and marked as removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            removePapers.mutate(slugs, {
              onError: (e) =>
                Alert.alert('Could not remove the papers', (e as Error).message),
            });
            exitSelect();
          },
        },
      ],
    );
  }

  // Swipe reveals the trash; this confirm is the human approval the backend's git commit
  // rides on ("agent proposes, human commits" — here the human does both).
  function confirmRemove(paper: Paper) {
    Alert.alert(
      'Remove paper?',
      `“${paper.title}” will be removed from this project. Its notes are kept and marked as removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            removePaper.mutate(paper.slug, {
              onError: (e) => Alert.alert('Could not remove the paper', (e as Error).message),
            });
          },
        },
      ],
    );
  }

  const papers = useMemo(() => stateQuery.data?.papers ?? [], [stateQuery.data]);
  const selectedHaveNotes = useMemo(
    () => papers.some((paper) => selected.has(paper.slug) && paper.has_notes),
    [papers, selected],
  );
  const counts = useMemo(() => {
    const c = { all: papers.length, toread: 0, inprogress: 0, done: 0 };
    for (const p of papers) c[filterBucket(p)] += 1;
    return c;
  }, [papers]);
  // Flat list, no reading-list category headers (polish plan F.6): the sections were
  // hand-written for the first project and no reliable categorization method exists for new
  // ones — `Paper.group` stays in the API for when one is defined.
  const visiblePapers = useMemo(() => {
    const filtered = filter === 'all' ? papers : papers.filter((p) => filterBucket(p) === filter);
    return sortPapers(filtered, sort, sortDirection);
  }, [papers, filter, sort, sortDirection]);
  const { isDismissed, dismiss: dismissContinue, loaded: dismissalLoaded } =
    useContinueCardDismissal();
  const recentSession = recentQuery.data?.find(
    (session) => session.kind === 'paper' && session.state !== 'committed',
  );
  // Hidden when the reader dismissed THIS session, and hidden entirely for a project with no
  // papers: a new project's whole job is to send the reader to discovery, and a resume card
  // pointing into some other project is exactly the distraction that competes with it.
  // `dismissalLoaded` gates the first paint so a dismissed card does not flash before storage
  // answers.
  const continueSession =
    dismissalLoaded
    && recentSession
    && papers.length > 0
    && !isDismissed(recentSession.project_id, recentSession.slug)
      ? recentSession
      : undefined;

  // The hero identifies exactly one likely next destination. Warm what the paper screen blocks
  // on — the transcript AND the opening draft — while the reader is still looking at the
  // Library, so resuming renders from TanStack Query's cache immediately instead of spinning on
  // two round-trips; the normal queries still refresh stale data in the background. (The hero's
  // cover is already warmed by the visible ContinueCard's PaperCover.) This intentionally
  // prefetches only the single hero, not every paper row.
  //
  // Thread-aware (D39 + R12.2): the paper screen resumes on the LAST-OPENED thread, so the
  // prefetch must warm that same thread's cache keys — warming only 'main' left a non-main
  // resume spinning on a cache miss (the ~1s "not snappy" the tester saw). We resolve the
  // stored thread first, then warm it.
  useEffect(() => {
    if (!continueSession) return;
    const { project_id: projectId, slug } = continueSession;
    let cancelled = false;
    void loadLastThread(projectId, slug).then((stored) => {
      if (cancelled) return;
      const threadId = stored || 'main';
      void queryClient.prefetchQuery({
        queryKey: keys.session(projectId, slug, threadId),
        queryFn: () => getSession(projectId, slug, threadId),
      });
      void queryClient.prefetchQuery({
        queryKey: keys.opening(projectId, slug, threadId),
        queryFn: () => getOpeningDraft(projectId, slug, threadId),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [continueSession?.project_id, continueSession?.slug, queryClient]);

  const openRecentSession = (session: RecentSession) => {
    setActivePid(session.project_id);
    // Carry the project explicitly as well as updating the persisted project selection. React
    // state updates are asynchronous; without this, a cross-project Resume can briefly mount
    // the paper route against the old project and request the wrong session before context
    // catches up. The paper route adopts this project parameter immediately.
    router.push(
      `/paper/${encodeURIComponent(session.slug)}?project=${encodeURIComponent(session.project_id)}`,
    );
  };

  const header = (
    <TabHeader
      title="Scholiast"
      actions={[
        { name: 'settings', onPress: () => router.push('/settings'), accessibilityLabel: 'Settings' },
      ]}
    />
  );

  if (!hasUrl) {
    return (
      <Screen edges={['top']}>
        {header}
        <Empty
          heading="Connect to your server"
          body="Set your Scholiast server URL in Settings to load your library."
          action={<Button title="Open Settings" onPress={() => router.push('/settings')} />}
        />
      </Screen>
    );
  }

  return (
    <Screen edges={['top']}>
      {header}

      <View style={{ flex: 1 }}>
      {/* The pill floats over the list — papers scroll behind/around it, hidden only under the
          rounded card itself (R12.6). Rendered BEFORE the ScrollView so screen readers reach it
          first (it's visually at the top); an explicit zIndex keeps it painted above the list. */}
      <View
        style={styles.pillOverlay}
        onLayout={(e) => setPillHeight(e.nativeEvent.layout.height)}>
        <ProjectPill
          name={activeProject?.name ?? (activePid ? activePid : 'Select a project')}
          subtitle={activeProject ? undefined : 'Tap to choose or create'}
          onPress={() => setSwitcherOpen(true)}
        />
      </View>
      <ScrollView
        contentContainerStyle={[styles.list, { paddingTop: pillHeight + space.sm }]}
        refreshControl={
          <RefreshControl
            refreshing={stateQuery.isFetching || recentQuery.isFetching}
            onRefresh={() => {
              void Promise.all([stateQuery.refetch(), recentQuery.refetch()]);
            }}
            tintColor={t.mint}
          />
        }>
        {continueSession ? (
          <ContinueCard
            session={continueSession}
            onPress={() => openRecentSession(continueSession)}
            onDismiss={() => dismissContinue(continueSession.project_id, continueSession.slug)}
          />
        ) : null}

        {activeProject && activeProject.paper_count > 0 ? (
          <Card style={styles.progressCard}>
            <View style={styles.progressHead}>
              <Text variant="heading">Project progress</Text>
              <Text variant="caption">
                {activeProject.read_count} of {activeProject.paper_count} complete
              </Text>
            </View>
            <ProgressBar
              value={activeProject.paper_count ? activeProject.read_count / activeProject.paper_count : 0}
            />
          </Card>
        ) : null}

        {papers.length > 0 ? (
          <View style={styles.filterRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.filters}
              contentContainerStyle={{ gap: space.sm }}>
              {FILTERS.map((f) => (
                <Chip
                  key={f.key}
                  label={`${f.label} ${counts[f.key]}`}
                  dot={false}
                  selected={filter === f.key}
                  onPress={() => setFilter(f.key)}
                />
              ))}
            </ScrollView>
            {/* Sort is separate from the filter chips (R9.12): tap to reorder the shown list. */}
            <Pressable
              onPress={() => {
                setExpandedSort(null);
                setSortOpen(true);
              }}
              style={styles.sortBtn}
              accessibilityRole="button"
              accessibilityLabel={`Sort papers. Currently ${SORTS.find((s) => s.key === sort)?.label}.`}>
              <Icon
                name="sliders"
                size={15}
                color={sort === DEFAULT_SORT && sortDirection === DEFAULT_SORT_DIRECTION
                  ? t.muted : t.mint}
              />
              <Text
                variant="caption"
                color={sort === DEFAULT_SORT && sortDirection === DEFAULT_SORT_DIRECTION
                  ? t.muted : t.mint}>
                Sort
              </Text>
            </Pressable>
          </View>
        ) : null}

        {!activePid && projectsQuery.isError ? (
          // A baked default URL means fresh installs start "connected" — when the server is
          // unreachable (phone off the tailnet, backend down) that must read as a network
          // problem with a retry, not as an empty account.
          <Empty
            heading="Couldn't reach the server"
            body={`${(projectsQuery.error as Error)?.message ?? 'Request failed.'}\n\nCheck that you're connected (Tailscale on?) or set a different server URL in Settings.`}
            action={<Button title="Retry" onPress={() => projectsQuery.refetch()} />}
          />
        ) : !activePid && projectsQuery.isLoading ? (
          <ActivityIndicator color={t.mint} style={{ paddingVertical: space.xxl }} />
        ) : !activePid ? (
          <Empty
            heading={projects && projects.length === 0
              ? 'Create your first project'
              : 'No project selected'}
            body={projects && projects.length === 0
              ? 'A project is one reading list — a field, a question, a course. Papers, notes and '
                + 'the reference graph all live inside it.'
              : 'Choose a research project, or create a new one to start reading.'}
            action={
              <Button
                title={projects && projects.length === 0 ? 'New project' : 'Choose project'}
                onPress={() => setSwitcherOpen(true)}
              />
            }
          />
        ) : stateQuery.isLoading ? (
          <ActivityIndicator color={t.mint} style={{ paddingVertical: space.xxl }} />
        ) : stateQuery.isError ? (
          <Empty
            heading="Couldn't load papers"
            body={(stateQuery.error as Error)?.message ?? 'Request failed.'}
            action={<Button title="Retry" onPress={() => stateQuery.refetch()} />}
          />
        ) : papers.length === 0 ? (
          <EmptyProjectHub
            onAddSpecific={() => router.push('/discover?specific=1')}
            onDiscover={() => router.push('/discover')}
          />
        ) : visiblePapers.length === 0 ? (
          <Text variant="caption" style={{ textAlign: 'center', paddingVertical: space.xl }}>
            No papers match this filter.
          </Text>
        ) : (
          <View style={{ gap: space.sm }}>
            {visiblePapers.map((p) => (
              <PaperRow
                key={p.slug}
                paper={p}
                selectMode={selectMode}
                selected={selected.has(p.slug)}
                onPress={() =>
                  selectMode
                    ? toggleSelected(p.slug)
                    : router.push(`/paper/${encodeURIComponent(p.slug)}`)
                }
                onLongPress={() => !selectMode && enterSelect(p.slug)}
                onRemove={() => confirmRemove(p)}
              />
            ))}
          </View>
        )}
      </ScrollView>
      </View>

      {selectMode ? (
        <View style={styles.selectBar}>
          <IconButton name="x" accessibilityLabel="Cancel selection" onPress={exitSelect} />
          <Text
            variant="label"
            color={t.text}
            numberOfLines={1}
            style={styles.selectionCount}>
            {selected.size} selected
          </Text>
          <View style={styles.selectActions}>
            <SelectionAction
              label="Move"
              icon="corner-up-right"
              onPress={() => {
                setRelocationMode('move');
                setMoveDestOpen(true);
              }}
              disabled={selected.size === 0}
            />
            <SelectionAction
              label="Copy"
              icon="copy"
              onPress={() => {
                setRelocationMode('copy');
                setMoveDestOpen(true);
              }}
              disabled={selected.size === 0}
            />
            <SelectionAction
              label="Delete"
              icon="trash-2"
              onPress={confirmBatchDelete}
              disabled={selected.size === 0}
              destructive
            />
          </View>
        </View>
      ) : null}

      <ProjectSwitcher
        visible={switcherOpen}
        activePid={activePid}
        onSelect={setActivePid}
        onClose={() => setSwitcherOpen(false)}
      />

      <SplitProjectSheet
        visible={splitOpen}
        pid={activePid}
        slugs={[...selected]}
        notesEligible={selectedHaveNotes && !!stateQuery.data?.has_key}
        operation={relocationMode}
        onClose={() => setSplitOpen(false)}
        onDone={(result) => {
          setSplitOpen(false);
          exitSelect();
          setActivePid(result.new_pid);
          if (result.notes_jobs?.destination) router.push('/notes/working');
        }}
      />

      {/* Move destination chooser (R9.13): a new project, or any existing one but the active. */}
      <OptionsSheet
        visible={moveDestOpen}
        onClose={() => setMoveDestOpen(false)}
        title={`${relocationMode === 'move' ? 'Move' : 'Copy'} ${selected.size} paper${selected.size === 1 ? '' : 's'} to`}
        options={[
          {
            key: 'new',
            title: 'New project…',
            icon: 'plus' as const,
            accent: t.mint,
            onPress: () => setSplitOpen(true),
          },
          ...(projects ?? [])
            .filter((p) => p.id !== activePid)
            .map((p, i) => ({
              key: p.id,
              title: p.name,
              icon: 'folder' as const,
              section: i === 0,  // divider between "New project…" and existing projects
              onPress: () => setMoveDest({ pid: p.id, name: p.name }),
            })),
        ]}
      />

      <MoveToProjectSheet
        visible={moveDest !== null}
        pid={activePid}
        destPid={moveDest?.pid ?? null}
        destName={moveDest?.name ?? ''}
        slugs={[...selected]}
        notesEligible={selectedHaveNotes && !!stateQuery.data?.has_key}
        operation={relocationMode}
        onClose={() => setMoveDest(null)}
        onDone={(result) => {
          setMoveDest(null);
          exitSelect();
          setActivePid(result.new_pid);
          if (result.notes_jobs?.destination) router.push('/notes/working');
        }}
      />

      <OptionsSheet
        visible={sortOpen}
        onClose={() => setSortOpen(false)}
        title="Sort papers"
        options={SORTS.flatMap((s) => {
          const primary = {
            key: s.key,
            title: s.label,
            icon: s.icon,
            selected: sort === s.key,
            closeOnPress: !s.directions,
            onPress: () => {
              setSort(s.key, s.defaultDirection ?? 'asc');
              setExpandedSort(s.directions ? s.key : null);
            },
          };
          if (expandedSort !== s.key || !s.directions) return [primary];
          return [
            primary,
            ...s.directions.map((direction) => ({
              key: `${s.key}-${direction.key}`,
              title: direction.label,
              icon: direction.icon,
              selected: sort === s.key && sortDirection === direction.key,
              level: 1,
              onPress: () => setSortDirection(direction.key),
            })),
          ];
        })}
      />
    </Screen>
  );
}

function SelectionAction({
  label,
  icon,
  onPress,
  disabled,
  destructive = false,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const color = destructive ? t.danger : t.mint;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.selectionAction,
        pressed && !disabled && { backgroundColor: t.elevated },
        disabled && { opacity: 0.4 },
      ]}>
      <Icon name={icon} size={17} color={color} />
      <Text variant="caption" color={color} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function ProjectPill({
  name,
  subtitle,
  onPress,
}: {
  name: string;
  subtitle?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Switch project"
      style={({ pressed }) => [styles.projectPill, pressed && { opacity: 0.85 }]}>
      <Icon name="folder" size={18} color={t.muted} />
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
        <Text variant="heading" numberOfLines={1}>
          {name}
        </Text>
        {subtitle ? (
          <Text variant="caption" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-down" size={18} color={t.muted} />
    </Pressable>
  );
}

function ContinueCard({
  session,
  onPress,
  onDismiss,
}: {
  session: RecentSession;
  onPress: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const paperUrl = fullPaperUrl(session);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.continueWrap, pressed && { opacity: 0.85 }]}>
      <Card style={styles.continueCard}>
        <View style={styles.continueHead}>
          <Text variant="title" color={t.mint}>
            Continue reading
          </Text>
          <IconButton
            name="x"
            accessibilityLabel="Dismiss continue reading"
            onPress={(event) => {
              // Required, not defensive: the whole card is a Pressable that navigates, so without
              // this the X both dismisses AND opens the paper it just dismissed. The sibling
              // external-link button below already does exactly this for the same reason.
              // Optional-chained because a press can arrive without an event object (React
              // Native Testing Library's `fireEvent.press` does exactly that), and the dismissal
              // must not throw just because nothing needed stopping.
              event?.stopPropagation?.();
              onDismiss();
            }}
          />
        </View>
        <View style={styles.continueBody}>
          <PaperCover projectId={session.project_id} slug={session.slug} width={84} height={104} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text variant="serifTitle" numberOfLines={3}>
              {session.title}
            </Text>
            {/* Project name over paper status: the status is almost always "Discussing" here
               (noise), while the project is what disambiguates a cross-project resume. */}
            <Text variant="caption" numberOfLines={1}>
              {session.project_name} · {formatActivityTime(session.updated_at)}
            </Text>
            <View style={styles.continueActions}>
              <Button title="Resume" icon="play" onPress={onPress} style={styles.resumeBtn} />
              {paperUrl ? (
                <IconButton
                  name="external-link"
                  accessibilityLabel={`Open full paper for ${session.title}`}
                  onPress={(event) => {
                    event.stopPropagation();
                    void Linking.openURL(paperUrl).catch(() => undefined);
                  }}
                />
              ) : null}
            </View>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Recently active';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function PaperRow({
  paper,
  onPress,
  onLongPress,
  onRemove,
  selectMode,
  selected,
}: {
  paper: Paper;
  onPress: () => void;
  onLongPress: () => void;
  onRemove: () => void;
  selectMode: boolean;
  selected: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const stateKey = paperStateKey(paper);
  const sm = stateMetaFor(t);
  const meta = sm[stateKey] ?? sm.unread;
  const action =
    stateKey === 'committed' || stateKey === 'read'
      ? 'Open'
      : stateKey === 'unread' || stateKey === 'retrieving'
        ? 'Read'
        : 'Resume';
  // Completed/fresh rows keep the mint action; an in-progress "Resume" is amber, matching
  // the state-chip rule (R7.4): green = done, yellow = ongoing.
  const actionColor = action === 'Resume' ? t.amber : t.mint;
  const paperUrl = fullPaperUrl(paper);

  const rowBody = (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={280}
      style={({ pressed }) => pressed && { opacity: 0.8 }}>
      <Card style={[styles.paperRow, selectMode && selected && styles.paperRowSelected]}>
        {selectMode ? (
          <View
            style={[styles.checkbox, selected && styles.checkboxOn]}
            accessibilityLabel={selected ? 'Selected' : 'Not selected'}>
            {selected ? <Icon name="check" size={14} color={t.mintInk} /> : null}
          </View>
        ) : null}
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={styles.paperMeta}>
            <View style={[styles.stateDot, { backgroundColor: meta.color }]} />
            <Text variant="caption" color={meta.color}>
              {meta.label}
            </Text>
            {paper.year ? (
              // The year anchors the paper on the corpus timeline at a glance (U.17).
              <Text variant="caption" color={t.muted}>
                {'· '}{paper.year}
              </Text>
            ) : null}
          </View>
          <Text variant="heading" numberOfLines={3}>
            {paper.title}
          </Text>
          {paper.affiliations?.length ? (
            <Text variant="caption" color={t.muted} numberOfLines={1}>
              {paper.affiliations.slice(0, 2).join(' · ')}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowAction}>
          {!selectMode && paperUrl ? (
            <IconButton
              name="external-link"
              filled={false}
              accessibilityLabel={`Open full paper for ${paper.title}`}
              onPress={(event) => {
                event.stopPropagation();
                void Linking.openURL(paperUrl).catch(() => undefined);
              }}
            />
          ) : null}
          {!selectMode ? (
            <>
              <Text variant="label" color={actionColor} style={{ fontFamily: fonts.bodySemiBold }}>
                {action}
              </Text>
              <Icon name="chevron-right" size={16} color={actionColor} />
            </>
          ) : null}
        </View>
      </Card>
    </Pressable>
  );

  // Swipe-to-remove is disabled in select mode — the horizontal gesture belongs to selection
  // there, and remove is a single-paper action anyway.
  if (selectMode) return rowBody;
  return (
    <ReanimatedSwipeable
      overshootRight={false}
      rightThreshold={40}
      renderRightActions={(_progress, _translation, methods) => (
        <Pressable
          onPress={() => {
            methods.close();
            onRemove();
          }}
          style={styles.removeAction}
          accessibilityLabel={`Remove ${paper.title}`}>
          <View style={styles.removeActionInner}>
            <Icon name="trash-2" size={19} color={t.danger} />
          </View>
        </Pressable>
      )}>
      {rowBody}
    </ReanimatedSwipeable>
  );
}

function Empty({ heading, body, action }: { heading: string; body: string; action?: React.ReactNode }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Text variant="title" style={{ textAlign: 'center', marginBottom: space.sm }}>
        {heading}
      </Text>
      <Text variant="body" color={t.muted} style={{ textAlign: 'center', marginBottom: space.lg }}>
        {body}
      </Text>
      {action}
    </View>
  );
}

function EmptyProjectHub({
  onAddSpecific,
  onDiscover,
}: {
  onAddSpecific: () => void;
  onDiscover: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.emptyProject}>
      <View style={styles.emptyProjectMark}>
        <Icon name="book-open" size={22} color={t.mint} />
      </View>
      <Text variant="title" style={{ textAlign: 'center' }}>
        Add your first papers
      </Text>
      <Text variant="body" color={t.muted} style={styles.emptyProjectIntro}>
        Start with a paper you know, or explore ranked suggestions for this project.
      </Text>
      <View style={styles.entryChoices}>
        <Pressable
          onPress={onAddSpecific}
          accessibilityRole="button"
          style={({ pressed }) => [styles.entryChoice, pressed && { opacity: 0.82 }]}>
          <View style={styles.entryChoiceIcon}>
            <Icon name="file-plus" size={19} color={t.mint} />
          </View>
          <View style={styles.entryChoiceText}>
            <Text variant="heading">Add a specific paper</Text>
            <Text variant="caption" color={t.muted} numberOfLines={2}>
              Use a title, arXiv ID, DOI, or PDF link
            </Text>
          </View>
          <Icon name="chevron-right" size={18} color={t.muted} />
        </Pressable>
        <Pressable
          onPress={onDiscover}
          accessibilityRole="button"
          style={({ pressed }) => [styles.entryChoice, pressed && { opacity: 0.82 }]}>
          <View style={[styles.entryChoiceIcon, { backgroundColor: t.elevated }]}>
            <Icon name="compass" size={19} color={t.violet} />
          </View>
          <View style={styles.entryChoiceText}>
            <Text variant="heading">Discover papers</Text>
            <Text variant="caption" color={t.muted} numberOfLines={2}>
              Search and rank work for your research goal
            </Text>
          </View>
          <Icon name="chevron-right" size={18} color={t.muted} />
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  return StyleSheet.create({
  // Transparent absolute holder so the pill floats over the scrolling list (R12.6). Rendered
  // before the list for screen-reader order, so an explicit zIndex keeps it painted on top.
  pillOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, backgroundColor: 'transparent' },
  projectPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tight ? space.sm : space.md,
    marginHorizontal: tight ? space.md : space.lg,
    marginBottom: space.sm,
    paddingHorizontal: tight ? space.md : space.lg,
    paddingVertical: tight ? space.sm : space.md,
    backgroundColor: t.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: t.line,
    // Clip the fill to the rounded border so it can't bleed past the corners on Android (R12.6).
    overflow: 'hidden',
    ...floatShadow,
  },
  list: {
    padding: tight ? space.md : space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
  },
  continueWrap: { marginBottom: tight ? space.sm : space.md },
  continueCard: { gap: tight ? space.sm : space.md, borderColor: t.line2 },
  continueHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  continueBody: { flexDirection: 'row', gap: tight ? space.md : space.lg },
  continueActions: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: space.sm, marginTop: space.xs },
  resumeBtn: { height: 42, paddingHorizontal: space.lg },
  progressCard: {
    gap: tight ? space.sm : space.md,
    marginBottom: tight ? space.sm : space.md,
  },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: tight ? space.md : space.lg,
  },
  filters: { flexGrow: 0, flexShrink: 1 },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.elevated,
  },
  paperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  paperRowSelected: { borderColor: t.mint },
  checkbox: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: t.line2,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: t.mint, borderColor: t.mint },
  selectBar: {
    flexDirection: 'row', alignItems: 'center',
    gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.xs,
    borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.surface,
  },
  selectionCount: { flex: 1, minWidth: 64 },
  selectActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  selectionAction: {
    width: 52,
    minHeight: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  paperMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stateDot: { width: 6, height: 6, borderRadius: 3 },
  rowAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  removeAction: { justifyContent: 'center', alignItems: 'center', width: 76 },
  removeActionInner: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.danger,
    backgroundColor: t.dangerWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    paddingVertical: tight ? space.xxl : space.xxl * 1.5,
    paddingHorizontal: space.lg,
    alignItems: 'center',
  },
  emptyProject: {
    paddingVertical: tight ? space.lg : space.xl,
    paddingHorizontal: space.sm,
    alignItems: 'center',
  },
  emptyProjectMark: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: t.mintWash,
    borderWidth: 1,
    borderColor: t.mint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: tight ? space.sm : space.md,
  },
  emptyProjectIntro: {
    textAlign: 'center',
    maxWidth: 320,
    marginTop: space.xs,
    marginBottom: tight ? space.md : space.lg,
  },
  entryChoices: { alignSelf: 'stretch', gap: tight ? space.xs : space.sm },
  entryChoice: {
    minHeight: tight ? 68 : 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: tight ? space.sm : space.md,
    paddingHorizontal: space.md,
    paddingVertical: tight ? space.xs : space.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.surface,
  },
  entryChoiceIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    backgroundColor: t.mintWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryChoiceText: { flex: 1, minWidth: 0, gap: 2 },
  });
};
