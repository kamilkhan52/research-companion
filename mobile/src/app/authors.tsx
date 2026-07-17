// Authors & Labs — the U.9 v1 ranked board. Reached from the Map header (users icon). Two
// modes over the same in-project author data: a flat activity-ranked card board, and the same
// cards grouped under affiliation headers (patchy S2/OpenAlex coverage collapses into a final
// "Independent / unknown" group so nobody is hidden). Tapping a card opens the author's papers;
// a project paper opens its Discussion. A hidden-by-default explainer states how activity is
// scored (the factors, not the formula).

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import * as api from '@/api/endpoints';
import type { AuthorPaper, BoardAuthor } from '@/api/types';
import { keys, useGraphAuthors } from '@/api/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { ExternalRefSheet, type ExternalRef } from '@/components/ExternalRefSheet';
import { TopBar } from '@/components/TopBar';
import { useActiveProject } from '@/store/project';
import { Button, Chip, Icon, Screen, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, space, type ThemePalette } from '@/theme/tokens';

/** The same target a chat's external reference would open: arXiv abs page when the id is
 *  known, DOI resolver, the extracted URL, else a Scholar title search. */
function externalHref(p: AuthorPaper): string {
  if (p.arxiv_id) return `https://arxiv.org/abs/${p.arxiv_id}`;
  if (p.doi) return `https://doi.org/${p.doi}`;
  if (p.url) return p.url;
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(p.title ?? '')}`;
}

type Mode = 'authors' | 'labs';
const UNKNOWN_LABEL = 'Independent / unknown';

export default function AuthorsScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { activePid: pid } = useActiveProject();
  const board = useGraphAuthors(pid);
  const [mode, setMode] = useState<Mode>('authors');
  const [showExplainer, setShowExplainer] = useState(false);
  const [selected, setSelected] = useState<BoardAuthor | null>(null);
  const [extRef, setExtRef] = useState<ExternalRef | null>(null);

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
            <Icon name="info" size={13} color={t.muted} />
            <Text variant="caption" color={t.muted}>How is this ranked?</Text>
          </Pressable>
          {showExplainer ? (
            <Text variant="caption" color={t.muted} style={styles.explainerBody}>
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
            <>
            {/* Labs coverage is inherently patchy — arXiv metadata carries no affiliation, so
                it comes from OpenAlex per rebuild. When most authors have none, Labs looks like
                Authors; say why rather than leave it a mystery (R.6). */}
            {groups.length === 1 && groups[0].affiliation === UNKNOWN_LABEL ? (
              <Text variant="caption" color={t.muted} style={styles.labsNote}>
                No affiliations yet. They fill in as the map is rebuilt (from the Map screen) —
                many arXiv papers list none, so coverage stays patchy.
              </Text>
            ) : null}
            {groups.map((g) => (
              <View key={g.affiliation} style={{ marginTop: space.md }}>
                <Text variant="caption" color={t.muted} style={styles.groupHeader}>
                  {g.affiliation.toUpperCase()}
                </Text>
                <View style={styles.cardGrid}>
                  {g.authors.map((a) => (
                    <AuthorCard key={a.name} author={a} onPress={() => setSelected(a)} />
                  ))}
                </View>
              </View>
            ))}
            </>
          )}
        </ScrollView>
      )}

      <BottomSheet visible={!!selected} onClose={() => setSelected(null)}>
        {selected ? (
          <AuthorSheet
            pid={pid}
            author={selected}
            significantExplainer={board.data?.explainers.significant ?? ''}
            onOpenPaper={(slug) => {
              setSelected(null);
              router.push(`/paper/${encodeURIComponent(slug)}`);
            }}
            onOpenExternal={(paper) => {
              // Close the author sheet first — two sibling Modals visible at once are
              // unreliable on Android.
              setSelected(null);
              setExtRef({ href: externalHref(paper), label: paper.title ?? undefined });
            }}
          />
        ) : null}
      </BottomSheet>

      {/* The exact menu external references get in a discussion: open link / add to list. */}
      <ExternalRefSheet pid={pid} refItem={extRef} onClose={() => setExtRef(null)} />
    </Screen>
  );
}

function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.segment, active && styles.segmentActive]}>
      <Text
        variant="label"
        color={active ? t.mint : t.muted}
        style={{ fontFamily: active ? fonts.bodySemiBold : fonts.bodyMedium }}>
        {label}
      </Text>
    </Pressable>
  );
}

function AuthorCard({ author, onPress }: { author: BoardAuthor; onPress: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const years = author.active_years;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityLabel={`${author.name}, ${author.in_project_count} papers in project`}>
      <Text variant="heading" numberOfLines={2}>{author.name}</Text>
      {author.affiliation ? (
        <Text variant="caption" color={t.muted} numberOfLines={1}>{author.affiliation}</Text>
      ) : null}
      <View style={styles.chipRow}>
        <Chip label={`${author.in_project_count} in project`} color={t.mint} dot={false} />
        {author.significant_count > 0 ? (
          <Chip label={`${author.significant_count} significant`} color={t.amber} dot={false} />
        ) : null}
        {author.external_count > 0 ? (
          <Chip label={`${author.external_count} referenced`} color={t.muted} dot={false} />
        ) : null}
      </View>
      {years ? (
        <Text variant="caption" color={t.muted}>
          {years[0] === years[1] ? `${years[0]}` : `${years[0]}–${years[1]}`}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** The one-paragraph LLM profile: shows the cached paragraph when the board carries one,
 *  else offers to generate it (background job + polling, like every LLM op). */
function AuthorProfile({ pid, author }: { pid: string | null; author: BoardAuthor }) {
  const t = useTheme();
  const qc = useQueryClient();
  const [profile, setProfile] = useState(author.profile ?? null);
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function generate() {
    if (!pid || state === 'running') return;
    setState('running');
    setError(null);
    try {
      let job = (await api.startAuthorProfile(pid, author.name)).job;
      const deadline = Date.now() + 3 * 60 * 1000;
      while (job.status === 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        job = (await api.getAuthorProfileJob(pid, job.id)).job;
      }
      if (!alive.current) return;
      if (job.status === 'done' && job.profile) {
        setProfile(job.profile);
        setState('idle');
        // The board merges cached profiles server-side; refetch so reopening the sheet
        // (and the Labs view) sees it without regenerating.
        qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });
      } else {
        setState('error');
        setError(job.error ?? 'Profile generation timed out — try again.');
      }
    } catch (e) {
      if (!alive.current) return;
      setState('error');
      setError((e as Error).message ?? 'Could not generate the profile.');
    }
  }

  if (profile) {
    return (
      <Text variant="body" color={t.text} style={{ marginTop: space.xs }}>
        {profile}
      </Text>
    );
  }
  return (
    <View style={{ marginTop: space.xs, gap: space.xs }}>
      <Button
        title={state === 'running' ? 'Writing profile…' : 'Generate profile'}
        variant="ghost"
        icon="user"
        onPress={() => void generate()}
        loading={state === 'running'}
        disabled={!pid || state === 'running'}
      />
      {error ? (
        <Text variant="caption" color={t.danger}>{error}</Text>
      ) : null}
    </View>
  );
}

function AuthorSheet({
  pid,
  author,
  significantExplainer,
  onOpenPaper,
  onOpenExternal,
}: {
  pid: string | null;
  author: BoardAuthor;
  significantExplainer: string;
  onOpenPaper: (slug: string) => void;
  onOpenExternal: (paper: AuthorPaper) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
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
        <Text variant="caption" color={t.muted}>{author.affiliation}</Text>
      ) : null}

      <AuthorProfile pid={pid} author={author} />

      {projectPapers.length ? (
        <>
          <Text variant="caption" color={t.mint} style={styles.sheetSection}>IN THIS PROJECT</Text>
          {projectPapers.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => p.slug && onOpenPaper(p.slug)}
              style={({ pressed }) => [styles.paperRow, pressed && { opacity: 0.7 }]}>
              <Icon name="book-open" size={14} color={t.violet} />
              <Text variant="body" style={{ flex: 1 }} numberOfLines={2}>
                {p.title}{p.year ? ` · ${p.year}` : ''}
              </Text>
              <Icon name="chevron-right" size={16} color={t.muted} />
            </Pressable>
          ))}
        </>
      ) : null}

      {externalPapers.length ? (
        <>
          <Text variant="caption" color={t.muted} style={styles.sheetSection}>
            REFERENCED IN THIS PROJECT
          </Text>
          {externalPapers.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => onOpenExternal(p)}
              style={({ pressed }) => [styles.paperRow, pressed && { opacity: 0.7 }]}>
              <Icon name="file-text" size={14} color={t.muted} />
              <Text variant="body" color={t.muted} style={{ flex: 1 }} numberOfLines={2}>
                {p.title}{p.year ? ` · ${p.year}` : ''}
              </Text>
              <Icon name="chevron-right" size={16} color={t.muted} />
            </Pressable>
          ))}
        </>
      ) : null}

      {author.significant_count > 0 ? (
        <Text variant="caption" color={t.muted} style={{ marginTop: space.sm }}>
          {significantExplainer}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function Centered({ text, loading }: { text?: string; loading?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.centered}>
      {loading ? <ActivityIndicator color={t.mint} /> : null}
      {text ? (
        <Text variant="caption" color={t.muted} style={{ textAlign: 'center' }}>{text}</Text>
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

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  segmentRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm },
  segment: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: t.line },
  segmentActive: { borderColor: t.mint, backgroundColor: t.mintWash },
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
    borderColor: t.line,
    backgroundColor: t.surface,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  groupHeader: { marginBottom: 6, letterSpacing: 0.5 },
  labsNote: { lineHeight: 18, marginBottom: space.xs },
  sheetSection: { marginTop: space.sm, letterSpacing: 0.5 },
  paperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
});
