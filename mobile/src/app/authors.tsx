// Authors & Labs — the U.9 v1 ranked board. Reached from the Map header (users icon). Two
// modes over the same in-project author data: a flat activity-ranked card board, and the same
// cards grouped under affiliation headers (patchy S2/OpenAlex coverage collapses into a final
// "Independent / unknown" group so nobody is hidden). Tapping a card opens the author's papers;
// a project paper opens its Discussion. A hidden-by-default explainer states how activity is
// scored (the factors, not the formula).

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { BoardAuthor } from '@/api/types';
import { useGraphAuthors } from '@/api/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { TopBar } from '@/components/TopBar';
import { useActiveProject } from '@/store/project';
import { Chip, Icon, Screen, Text } from '@/ui';
import { colors, fonts, space } from '@/theme/tokens';

type Mode = 'authors' | 'labs';
const UNKNOWN_LABEL = 'Independent / unknown';

export default function AuthorsScreen() {
  const router = useRouter();
  const { activePid: pid } = useActiveProject();
  const board = useGraphAuthors(pid);
  const [mode, setMode] = useState<Mode>('authors');
  const [showExplainer, setShowExplainer] = useState(false);
  const [selected, setSelected] = useState<BoardAuthor | null>(null);

  const authors = board.data?.authors ?? [];
  const groups = useMemo(() => groupByAffiliation(authors), [authors]);

  return (
    <Screen edges={['top']}>
      <TopBar title="Authors & Labs" subtitle="Most active in this project" onBack={() => router.back()} />

      <View style={styles.segmentRow}>
        <Segment label="Authors" active={mode === 'authors'} onPress={() => setMode('authors')} />
        <Segment label="Labs" active={mode === 'labs'} onPress={() => setMode('labs')} />
      </View>

      {!pid ? (
        <Centered text="No active project selected." />
      ) : board.isLoading ? (
        <Centered loading />
      ) : board.isError ? (
        <Centered text="Could not load authors." />
      ) : authors.length === 0 ? (
        <Centered text="No author data yet. Build or rebuild the map to gather authors for this project's papers." />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Pressable onPress={() => setShowExplainer((v) => !v)} style={styles.explainerToggle}>
            <Icon name="info" size={13} color={colors.muted} />
            <Text variant="caption" color={colors.muted}>How is this ranked?</Text>
          </Pressable>
          {showExplainer ? (
            <Text variant="caption" color={colors.muted} style={styles.explainerBody}>
              {board.data?.explainers.activity}
            </Text>
          ) : null}

          {mode === 'authors' ? (
            <View style={styles.cardGrid}>
              {authors.map((a) => (
                <AuthorCard key={a.name} author={a} onPress={() => setSelected(a)} />
              ))}
            </View>
          ) : (
            groups.map((g) => (
              <View key={g.affiliation} style={{ marginTop: space.md }}>
                <Text variant="caption" color={colors.muted} style={styles.groupHeader}>
                  {g.affiliation.toUpperCase()}
                </Text>
                <View style={styles.cardGrid}>
                  {g.authors.map((a) => (
                    <AuthorCard key={a.name} author={a} onPress={() => setSelected(a)} />
                  ))}
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}

      <BottomSheet visible={!!selected} onClose={() => setSelected(null)}>
        {selected ? (
          <AuthorSheet
            author={selected}
            significantExplainer={board.data?.explainers.significant ?? ''}
            onOpenPaper={(slug) => {
              setSelected(null);
              router.push(`/paper/${encodeURIComponent(slug)}`);
            }}
          />
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.segment, active && styles.segmentActive]}>
      <Text
        variant="label"
        color={active ? colors.mint : colors.muted}
        style={{ fontFamily: active ? fonts.bodySemiBold : fonts.bodyMedium }}>
        {label}
      </Text>
    </Pressable>
  );
}

function AuthorCard({ author, onPress }: { author: BoardAuthor; onPress: () => void }) {
  const years = author.active_years;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityLabel={`${author.name}, ${author.in_project_count} papers in project`}>
      <Text variant="heading" numberOfLines={2}>{author.name}</Text>
      {author.affiliation ? (
        <Text variant="caption" color={colors.muted} numberOfLines={1}>{author.affiliation}</Text>
      ) : null}
      <View style={styles.chipRow}>
        <Chip label={`${author.in_project_count} in project`} color={colors.mint} dot={false} />
        {author.significant_count > 0 ? (
          <Chip label={`${author.significant_count} significant`} color={colors.amber} dot={false} />
        ) : null}
        {author.external_count > 0 ? (
          <Chip label={`${author.external_count} referenced`} color={colors.muted} dot={false} />
        ) : null}
      </View>
      {years ? (
        <Text variant="caption" color={colors.muted}>
          {years[0] === years[1] ? `${years[0]}` : `${years[0]}–${years[1]}`}
        </Text>
      ) : null}
    </Pressable>
  );
}

function AuthorSheet({
  author,
  significantExplainer,
  onOpenPaper,
}: {
  author: BoardAuthor;
  significantExplainer: string;
  onOpenPaper: (slug: string) => void;
}) {
  const projectPapers = author.papers.filter((p) => p.kind === 'project');
  const externalPapers = author.papers.filter((p) => p.kind === 'external');
  return (
    // flexGrow:0 / flexShrink:1 / minHeight:0 bound this ScrollView against the sheet's
    // height cap (RN's default flexShrink is 0), so a prolific author's papers scroll inside
    // the sheet instead of overflowing — same pattern as the other BottomSheet consumers.
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}
      contentContainerStyle={{ padding: space.lg, gap: space.sm }}>
      <Text variant="title">{author.name}</Text>
      {author.affiliation ? (
        <Text variant="caption" color={colors.muted}>{author.affiliation}</Text>
      ) : null}

      {projectPapers.length ? (
        <>
          <Text variant="caption" color={colors.mint} style={styles.sheetSection}>IN THIS PROJECT</Text>
          {projectPapers.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => p.slug && onOpenPaper(p.slug)}
              style={({ pressed }) => [styles.paperRow, pressed && { opacity: 0.7 }]}>
              <Icon name="book-open" size={14} color={colors.violet} />
              <Text variant="body" style={{ flex: 1 }} numberOfLines={2}>
                {p.title}{p.year ? ` · ${p.year}` : ''}
              </Text>
              <Icon name="chevron-right" size={16} color={colors.muted} />
            </Pressable>
          ))}
        </>
      ) : null}

      {externalPapers.length ? (
        <>
          <Text variant="caption" color={colors.muted} style={styles.sheetSection}>
            REFERENCED IN THIS PROJECT
          </Text>
          {externalPapers.map((p) => (
            <View key={p.id} style={styles.paperRow}>
              <Icon name="file-text" size={14} color={colors.muted} />
              <Text variant="body" color={colors.muted} style={{ flex: 1 }} numberOfLines={2}>
                {p.title}{p.year ? ` · ${p.year}` : ''}
              </Text>
            </View>
          ))}
        </>
      ) : null}

      {author.significant_count > 0 ? (
        <Text variant="caption" color={colors.muted} style={{ marginTop: space.sm }}>
          {significantExplainer}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function Centered({ text, loading }: { text?: string; loading?: boolean }) {
  return (
    <View style={styles.centered}>
      {loading ? <ActivityIndicator color={colors.mint} /> : null}
      {text ? (
        <Text variant="caption" color={colors.muted} style={{ textAlign: 'center' }}>{text}</Text>
      ) : null}
    </View>
  );
}

/** Group authors under their affiliation, headers ordered by summed activity; unknowns last. */
function groupByAffiliation(authors: BoardAuthor[]): { affiliation: string; authors: BoardAuthor[] }[] {
  const byAff = new Map<string, BoardAuthor[]>();
  for (const a of authors) {
    const key = a.affiliation || UNKNOWN_LABEL;
    (byAff.get(key) ?? byAff.set(key, []).get(key)!).push(a);
  }
  const activity = (list: BoardAuthor[]) => list.reduce((s, a) => s + a.activity, 0);
  return [...byAff.entries()]
    .map(([affiliation, list]) => ({ affiliation, authors: list }))
    .sort((x, y) => {
      if (x.affiliation === UNKNOWN_LABEL) return 1;
      if (y.affiliation === UNKNOWN_LABEL) return -1;
      return activity(y.authors) - activity(x.authors);
    });
}

const styles = StyleSheet.create({
  segmentRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm },
  segment: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: colors.line },
  segmentActive: { borderColor: 'rgba(101, 214, 180, 0.4)', backgroundColor: 'rgba(101, 214, 180, 0.1)' },
  scroll: { padding: space.lg, paddingTop: space.sm, gap: space.sm },
  explainerToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  explainerBody: { lineHeight: 18 },
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  card: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 0,
    gap: 6,
    padding: space.md,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  groupHeader: { marginBottom: 6, letterSpacing: 0.5 },
  sheetSection: { marginTop: space.sm, letterSpacing: 0.5 },
  paperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
});
