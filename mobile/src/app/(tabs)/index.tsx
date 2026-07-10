// Library — the home tab. Project-scoped: a project switcher pill over a continue-reading
// hero, project progress, status filters, and the flat list of papers in the active
// project. Tapping a paper opens its Discussion. Layout follows Figma frame `01 · Library`.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import {
  useBaseUrl,
  useProjectState,
  useProjects,
  useRecentSessions,
  useRemovePaper,
} from '@/api/queries';
import type { Paper, RecentSession } from '@/api/types';
import { TabHeader } from '@/components/TopBar';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';
import { useActiveProject } from '@/store/project';
import { Button, Card, Chip, Icon, ProgressBar, Screen, Text } from '@/ui';
import { colors, fonts, radius, space, stateMeta } from '@/theme/tokens';

type StatusFilter = 'all' | 'toread' | 'inprogress' | 'done';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'toread', label: 'To read' },
  { key: 'inprogress', label: 'In progress' },
  { key: 'done', label: 'Done' },
];

function paperStateKey(p: Paper): string {
  return p.session_state ?? (p.list_status === 'read' ? 'committed' : 'unread');
}

function filterBucket(p: Paper): Exclude<StatusFilter, 'all'> {
  const s = paperStateKey(p);
  if (s === 'committed' || s === 'read') return 'done';
  if (s === 'in_discussion' || s === 'notes_drafted') return 'inprogress';
  return 'toread';
}

export default function LibraryScreen() {
  const router = useRouter();
  const { activePid, setActivePid, ready } = useActiveProject();
  const hasUrl = !!useBaseUrl();
  const projectsQuery = useProjects();
  const projects = projectsQuery.data;
  const recentQuery = useRecentSessions();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');

  // Auto-select the first project if none is active yet.
  useEffect(() => {
    if (ready && !activePid && projects && projects.length > 0) {
      setActivePid(projects[0].id);
    }
  }, [ready, activePid, projects, setActivePid]);

  const stateQuery = useProjectState(activePid);
  const activeProject = projects?.find((p) => p.id === activePid);
  const removePaper = useRemovePaper(activePid);

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
  const counts = useMemo(() => {
    const c = { all: papers.length, toread: 0, inprogress: 0, done: 0 };
    for (const p of papers) c[filterBucket(p)] += 1;
    return c;
  }, [papers]);
  // Flat list, no reading-list category headers (polish plan F.6): the sections were
  // hand-written for the first project and no reliable categorization method exists for new
  // ones — `Paper.group` stays in the API for when one is defined.
  const visiblePapers = useMemo(
    () => (filter === 'all' ? papers : papers.filter((p) => filterBucket(p) === filter)),
    [papers, filter],
  );
  const continueSession = recentQuery.data?.find(
    (session) => session.kind === 'paper' && session.state !== 'committed',
  );

  const openRecentSession = (session: RecentSession) => {
    setActivePid(session.project_id);
    router.push(`/paper/${encodeURIComponent(session.slug)}`);
  };

  const header = (
    <TabHeader
      title="Paradigm"
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
          body="Set your backend URL (the Cloudflare tunnel link) in Settings to load your library."
          action={<Button title="Open Settings" onPress={() => router.push('/settings')} />}
        />
      </Screen>
    );
  }

  return (
    <Screen edges={['top']}>
      {header}

      {/* Counts live in the progress card right below; the pill stays single-line once a
          project is selected and only hints when there is nothing selected yet. */}
      <ProjectPill
        name={activeProject?.name ?? (activePid ? activePid : 'Select a project')}
        subtitle={activeProject ? undefined : 'Tap to choose or create'}
        onPress={() => setSwitcherOpen(true)}
      />

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={stateQuery.isFetching || recentQuery.isFetching}
            onRefresh={() => {
              void Promise.all([stateQuery.refetch(), recentQuery.refetch()]);
            }}
            tintColor={colors.mint}
          />
        }>
        {continueSession ? (
          <ContinueCard session={continueSession} onPress={() => openRecentSession(continueSession)} />
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
          <ActivityIndicator color={colors.mint} style={{ paddingVertical: space.xxl }} />
        ) : !activePid ? (
          <Empty
            heading="No project selected"
            body="Choose a research project, or create a new one to start reading."
            action={<Button title="Choose project" onPress={() => setSwitcherOpen(true)} />}
          />
        ) : stateQuery.isLoading ? (
          <ActivityIndicator color={colors.mint} style={{ paddingVertical: space.xxl }} />
        ) : stateQuery.isError ? (
          <Empty
            heading="Couldn't load papers"
            body={(stateQuery.error as Error)?.message ?? 'Request failed.'}
            action={<Button title="Retry" onPress={() => stateQuery.refetch()} />}
          />
        ) : papers.length === 0 ? (
          <Empty
            heading="Start this project"
            body="Describe your research goals to get suggested foundational readings from arXiv — or bring a specific paper by name or link."
            action={<Button title="Find foundational papers" onPress={() => router.push('/discover')} />}
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
                onPress={() => router.push(`/paper/${encodeURIComponent(p.slug)}`)}
                onRemove={() => confirmRemove(p)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <ProjectSwitcher
        visible={switcherOpen}
        activePid={activePid}
        onSelect={setActivePid}
        onClose={() => setSwitcherOpen(false)}
      />
    </Screen>
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
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Switch project"
      style={({ pressed }) => [styles.projectPill, pressed && { opacity: 0.85 }]}>
      <Icon name="folder" size={18} color={colors.muted} />
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
      <Icon name="chevron-down" size={18} color={colors.muted} />
    </Pressable>
  );
}

function ContinueCard({ session, onPress }: { session: RecentSession; onPress: () => void }) {
  const meta = stateMeta[session.state ?? 'unread'] ?? stateMeta.unread;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.continueWrap, pressed && { opacity: 0.85 }]}>
      <Card style={styles.continueCard}>
        <Text variant="title" color={colors.mint}>
          Continue reading
        </Text>
        <View style={styles.continueBody}>
          <View style={styles.thumb}>
            <Icon name="file-text" size={26} color={colors.bg} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text variant="serifTitle" numberOfLines={3}>
              {session.title}
            </Text>
            <Text variant="caption" numberOfLines={1}>
              {meta.label} · {session.project_name} · {formatActivityTime(session.updated_at)}
            </Text>
            <Button title="Resume" icon="play" onPress={onPress} style={styles.resumeBtn} />
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
  onRemove,
}: {
  paper: Paper;
  onPress: () => void;
  onRemove: () => void;
}) {
  const stateKey = paperStateKey(paper);
  const meta = stateMeta[stateKey] ?? stateMeta.unread;
  const action =
    stateKey === 'committed' || stateKey === 'read'
      ? 'Open'
      : stateKey === 'unread' || stateKey === 'retrieving'
        ? 'Read'
        : 'Resume';
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
            <Icon name="trash-2" size={19} color={colors.danger} />
          </View>
        </Pressable>
      )}>
    <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.8 }}>
      <Card style={styles.paperRow}>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={styles.paperMeta}>
            <View style={[styles.stateDot, { backgroundColor: meta.color }]} />
            <Text variant="caption" color={meta.color}>
              {meta.label}
            </Text>
          </View>
          <Text variant="heading" numberOfLines={3}>
            {paper.title}
          </Text>
        </View>
        <View style={styles.rowAction}>
          <Text variant="label" color={colors.mint} style={{ fontFamily: fonts.bodySemiBold }}>
            {action}
          </Text>
          <Icon name="chevron-right" size={16} color={colors.mint} />
        </View>
      </Card>
    </Pressable>
    </ReanimatedSwipeable>
  );
}

function Empty({ heading, body, action }: { heading: string; body: string; action?: React.ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text variant="title" style={{ textAlign: 'center', marginBottom: space.sm }}>
        {heading}
      </Text>
      <Text variant="body" color={colors.muted} style={{ textAlign: 'center', marginBottom: space.lg }}>
        {body}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  projectPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.line,
  },
  list: { padding: space.lg, paddingTop: space.sm, paddingBottom: space.xxl },
  continueWrap: { marginBottom: space.md },
  continueCard: { gap: space.md, borderColor: colors.line2 },
  continueBody: { flexDirection: 'row', gap: space.lg },
  thumb: {
    width: 84,
    height: 104,
    borderRadius: radius.md,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resumeBtn: { alignSelf: 'flex-end', height: 42, paddingHorizontal: space.lg, marginTop: space.xs },
  progressCard: { gap: space.md, marginBottom: space.md },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  filters: { marginBottom: space.lg, flexGrow: 0 },
  paperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  paperMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stateDot: { width: 6, height: 6, borderRadius: 3 },
  rowAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  removeAction: { justifyContent: 'center', alignItems: 'center', width: 76 },
  removeActionInner: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: 'rgba(229, 115, 140, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { paddingVertical: space.xxl * 1.5, paddingHorizontal: space.lg, alignItems: 'center' },
});
