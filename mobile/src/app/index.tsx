// Library — the home screen. Project-scoped: a project bar (tap to switch/create) over the
// list of papers in the active project. Tapping a paper opens its Discussion.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useBaseUrl, useProjectState, useProjects } from '@/api/queries';
import type { Paper } from '@/api/types';
import { IconButton, TopBar } from '@/components/TopBar';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';
import { useActiveProject } from '@/store/project';
import { Button, Card, Chip, Screen, Text } from '@/ui';
import { colors, radius, space, stateMeta } from '@/theme/tokens';

export default function LibraryScreen() {
  const router = useRouter();
  const { activePid, setActivePid, ready } = useActiveProject();
  const hasUrl = !!useBaseUrl();
  const { data: projects } = useProjects();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Auto-select the first project if none is active yet.
  useEffect(() => {
    if (ready && !activePid && projects && projects.length > 0) {
      setActivePid(projects[0].id);
    }
  }, [ready, activePid, projects, setActivePid]);

  const stateQuery = useProjectState(activePid);
  const activeProject = projects?.find((p) => p.id === activePid);

  const grouped = useMemo(() => groupPapers(stateQuery.data?.papers ?? []), [stateQuery.data]);

  const settingsBtn = (
    <IconButton glyph="⚙" onPress={() => router.push('/settings')} accessibilityLabel="Settings" />
  );

  if (!hasUrl) {
    return (
      <Screen>
        <TopBar title="Reading Companion" right={settingsBtn} />
        <Empty
          heading="Connect to your server"
          body="Set your backend URL (the Cloudflare tunnel link) in Settings to load your library."
          action={<Button title="Open Settings" onPress={() => router.push('/settings')} />}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title="Reading Companion" right={settingsBtn} />

      <ProjectBar
        name={activeProject?.name ?? (activePid ? activePid : 'Select a project')}
        subtitle={
          activeProject
            ? `${activeProject.paper_count} papers · ${activeProject.read_count} read`
            : 'Tap to choose or create'
        }
        onPress={() => setSwitcherOpen(true)}
        onGraphPress={activePid ? () => router.push('/graph') : undefined}
        onDiscoverPress={activePid ? () => router.push('/discover') : undefined}
      />

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={stateQuery.isFetching}
            onRefresh={() => stateQuery.refetch()}
            tintColor={colors.cyan}
          />
        }>
        {!activePid ? (
          <Empty
            heading="No project selected"
            body="Choose a research project, or create a new one to start reading."
            action={<Button title="Choose project" onPress={() => setSwitcherOpen(true)} />}
          />
        ) : stateQuery.isLoading ? (
          <ActivityIndicator color={colors.cyan} style={{ paddingVertical: space.xxl }} />
        ) : stateQuery.isError ? (
          <Empty
            heading="Couldn't load papers"
            body={(stateQuery.error as Error)?.message ?? 'Request failed.'}
            action={<Button title="Retry" onPress={() => stateQuery.refetch()} />}
          />
        ) : grouped.length === 0 ? (
          <Empty
            heading="Start this project"
            body="Describe your research goals to get suggested foundational readings from arXiv — or bring a specific paper by name or link."
            action={<Button title="Find foundational papers" onPress={() => router.push('/discover')} />}
          />
        ) : (
          grouped.map(({ group, papers }) => (
            <View key={group} style={{ marginBottom: space.lg }}>
              <Text variant="label" style={styles.groupLabel}>
                {group.toUpperCase()}
              </Text>
              <View style={{ gap: space.sm }}>
                {papers.map((p) => (
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

function ProjectBar({
  name,
  subtitle,
  onPress,
  onGraphPress,
  onDiscoverPress,
}: {
  name: string;
  subtitle: string;
  onPress: () => void;
  onGraphPress?: () => void;
  onDiscoverPress?: () => void;
}) {
  return (
    <View style={styles.projectBarRow}>
      <Pressable onPress={onPress} style={({ pressed }) => [styles.projectBar, pressed && { opacity: 0.85 }]}>
        <View style={{ flex: 1 }}>
          <Text variant="caption" color={colors.muted}>
            PROJECT
          </Text>
          <Text variant="heading" color={colors.violet} numberOfLines={1}>
            {name}
          </Text>
          <Text variant="caption" style={{ marginTop: 1 }}>
            {subtitle}
          </Text>
        </View>
        <Text style={{ color: colors.muted, fontSize: 18 }}>⌄</Text>
      </Pressable>
      {onDiscoverPress ? (
        <Pressable
          onPress={onDiscoverPress}
          style={({ pressed }) => [styles.graphBtn, pressed && { opacity: 0.85 }]}
          accessibilityLabel="Discover readings">
          <Text style={{ fontSize: 20 }}>⌕</Text>
          <Text variant="caption" style={{ marginTop: 2 }}>
            Discover
          </Text>
        </Pressable>
      ) : null}
      {onGraphPress ? (
        <Pressable
          onPress={onGraphPress}
          style={({ pressed }) => [styles.graphBtn, pressed && { opacity: 0.85 }]}
          accessibilityLabel="View reference graph">
          <Text style={{ fontSize: 20 }}>✦</Text>
          <Text variant="caption" style={{ marginTop: 2 }}>
            Graph
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PaperRow({ paper, onPress }: { paper: Paper; onPress: () => void }) {
  const stateKey = paper.session_state ?? (paper.list_status === 'read' ? 'committed' : 'unread');
  const meta = stateMeta[stateKey] ?? stateMeta.unread;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.8 }}>
      <Card style={styles.paperRow}>
        <View style={{ flex: 1, gap: 8 }}>
          <Text variant="heading" numberOfLines={3}>
            {paper.title}
          </Text>
          <Chip label={meta.label} color={meta.color} />
        </View>
        <Text style={{ color: colors.muted, fontSize: 20, marginTop: 2 }}>›</Text>
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
  projectBarRow: {
    flexDirection: 'row',
    gap: space.sm,
    marginHorizontal: space.md,
    marginTop: space.md,
  },
  projectBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.md,
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  graphBtn: {
    width: 72,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  list: { padding: space.md, paddingBottom: space.xxl },
  groupLabel: { marginBottom: space.sm, marginLeft: space.xs },
  paperRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  empty: { paddingVertical: space.xxl * 1.5, paddingHorizontal: space.lg, alignItems: 'center' },
});
