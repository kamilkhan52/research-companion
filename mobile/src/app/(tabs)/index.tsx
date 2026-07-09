// Library — the home tab. Project-scoped: a project switcher pill over a continue-reading
// hero, project progress, status filters, and the grouped list of papers in the active
// project. Tapping a paper opens its Discussion. Layout follows Figma frame `01 · Library`.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { useBaseUrl, useProjectState, useProjects, useRecentSessions } from '@/api/queries';
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
  const { data: projects } = useProjects();
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

  const papers = useMemo(() => stateQuery.data?.papers ?? [], [stateQuery.data]);
  const counts = useMemo(() => {
    const c = { all: papers.length, toread: 0, inprogress: 0, done: 0 };
    for (const p of papers) c[filterBucket(p)] += 1;
    return c;
  }, [papers]);
  const grouped = useMemo(
    () => groupPapers(filter === 'all' ? papers : papers.filter((p) => filterBucket(p) === filter)),
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
      title="Research Companion"
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

      <ProjectPill
        name={activeProject?.name ?? (activePid ? activePid : 'Select a project')}
        subtitle={
          activeProject
            ? `${activeProject.paper_count} papers · ${activeProject.read_count} complete`
            : 'Tap to choose or create'
        }
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

        {!activePid ? (
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
        ) : grouped.length === 0 ? (
          <Text variant="caption" style={{ textAlign: 'center', paddingVertical: space.xl }}>
            No papers match this filter.
          </Text>
        ) : (
          grouped.map(({ group, papers: papersInGroup }) => (
            <View key={group} style={{ marginBottom: space.lg }}>
              <Text variant="overline" style={styles.groupLabel}>
                {group}
              </Text>
              <View style={{ gap: space.sm }}>
                {papersInGroup.map((p) => (
                  <PaperRow
                    key={p.slug}
                    paper={p}
                    onPress={() => router.push(`/paper/${encodeURIComponent(p.slug)}`)}
                  />
                ))}
              </View>
            </View>
          ))
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
  subtitle: string;
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
        <Text variant="caption" numberOfLines={1}>
          {subtitle}
        </Text>
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

function PaperRow({ paper, onPress }: { paper: Paper; onPress: () => void }) {
  const stateKey = paperStateKey(paper);
  const meta = stateMeta[stateKey] ?? stateMeta.unread;
  const action =
    stateKey === 'committed' || stateKey === 'read'
      ? 'Open'
      : stateKey === 'unread' || stateKey === 'retrieving'
        ? 'Read'
        : 'Resume';
  return (
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

interface Group {
  group: string;
  papers: Paper[];
}

function groupPapers(papers: Paper[]): Group[] {
  const map = new Map<string, Paper[]>();
  for (const p of papers) {
    const g = p.group || 'Ungrouped';
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(p);
  }
  return Array.from(map, ([group, ps]) => ({ group, papers: ps }));
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
  groupLabel: { marginBottom: space.sm, marginLeft: space.xs },
  paperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  paperMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stateDot: { width: 6, height: 6, borderRadius: 3 },
  rowAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  empty: { paddingVertical: space.xxl * 1.5, paddingHorizontal: space.lg, alignItems: 'center' },
});
