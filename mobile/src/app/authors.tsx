// Authors & Labs — the U.9 v1 ranked board. Reached from the Map header (users icon). Two
// modes over the same in-project author data: a flat activity-ranked card board, and the same
// cards grouped under affiliation headers (patchy S2/OpenAlex coverage collapses into a final
// "Independent / unknown" group so nobody is hidden). Tapping a card opens the author's papers;
// a project paper opens its Discussion. A hidden-by-default explainer states how activity is
// scored (the factors, not the formula).

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import * as api from '@/api/endpoints';
import type { AuthorPaper, BoardAuthor, LabsBoard, LabsResearchJob } from '@/api/types';
import { keys, useGraphAuthors } from '@/api/queries';
import { showToast } from '@/ui/Toast';
import { BottomSheet } from '@/components/BottomSheet';
import { ExternalRefSheet, type ExternalRef } from '@/components/ExternalRefSheet';
import { TopBar } from '@/components/TopBar';
import { useActiveProject } from '@/store/project';
import { Button, Chip, Icon, Screen, Text, type IconName } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

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
export const AUTHORS_PAGE_SIZE = 10;
export const LABS_PAGE_SIZE = 5;

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
  const [authorLimit, setAuthorLimit] = useState(AUTHORS_PAGE_SIZE);

  const authors = board.data?.authors ?? [];
  useEffect(() => {
    setAuthorLimit(AUTHORS_PAGE_SIZE);
  }, [pid, authors.length]);

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
            <>
              <View style={styles.cardGrid}>
                {authors.slice(0, authorLimit).map((a) => (
                  <AuthorCard key={a.name} author={a} onPress={() => setSelected(a)} />
                ))}
              </View>
              {authorLimit < authors.length ? (
                <Button
                  title={`Show more authors (${Math.min(authorLimit, authors.length)} of ${authors.length})`}
                  variant="ghost"
                  onPress={() => setAuthorLimit((n) => n + AUTHORS_PAGE_SIZE)}
                />
              ) : null}
            </>
          ) : (
            <LabsView
              pid={pid}
              authors={authors}
              labs={board.data?.labs}
              runningJob={board.data?.labs_job ?? null}
              onSelectAuthor={setSelected}
            />
          )}
        </ScrollView>
      )}

      <BottomSheet visible={!!selected} onClose={() => setSelected(null)} scrollable>
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

/** Icon + count, with the words carried by the accessibility label rather than the layout.
 *
 *  Three text chips reading "4 in project · 2 significant · 9 referenced" wrapped to two lines on
 *  a phone and pushed the name out of view, which is what DR-008 was about. The counts are the
 *  signal; the nouns are the same on every card. */
function CountStat({ icon, count, color }: { icon: IconName; count: number; color: string }) {
  const styles = useThemedStyles(makeStyles);
  // No label of its own: the card is one accessible unit and its label already names all three
  // counts in words. Labelling them here too would read every number twice.
  return (
    <View style={styles.countStat}>
      <Icon name={icon} size={13} color={color} />
      <Text variant="caption" color={color} style={styles.countStatValue}>{count}</Text>
    </View>
  );
}

function AuthorCard({ author, onPress }: { author: BoardAuthor; onPress: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // `active_years` is deliberately not shown. A bare "2019–2024" under a name reads as a career
  // span; it is actually the range of publication years among THIS project's papers, which is a
  // fact about the reading list rather than about the person (DR-008).
  const parts = [`${author.in_project_count} in project`];
  if (author.significant_count > 0) parts.push(`${author.significant_count} significant`);
  if (author.external_count > 0) parts.push(`${author.external_count} referenced`);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityLabel={`${author.name}. ${parts.join(', ')}.`}>
      <Text variant="heading" numberOfLines={2}>{author.name}</Text>
      {author.affiliation ? (
        <Text variant="caption" color={t.muted} numberOfLines={1}>{author.affiliation}</Text>
      ) : null}
      <View style={styles.chipRow}>
        <CountStat icon="file-text" count={author.in_project_count} color={t.mint} />
        {author.significant_count > 0 ? (
          <CountStat icon="star" count={author.significant_count} color={t.amber} />
        ) : null}
        {author.external_count > 0 ? (
          <CountStat icon="link" count={author.external_count} color={t.muted} />
        ) : null}
      </View>
    </Pressable>
  );
}

/** Lab-centric Labs mode (R7.7): researched lab cards first — the actual groups behind the
 *  project's top authors, found by an explicit agentic web pass — then everyone not yet
 *  mapped, grouped by plain paper-metadata affiliation as before. Concentration of the
 *  project's papers in a few labs is the signal this view exists for; when the research ran
 *  and found none, it says so instead of pretending. */
function LabsView({
  pid,
  authors,
  labs,
  runningJob,
  onSelectAuthor,
}: {
  pid: string | null;
  authors: BoardAuthor[];
  labs: LabsBoard | undefined;
  runningJob: LabsResearchJob | null;
  onSelectAuthor: (a: BoardAuthor) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const qc = useQueryClient();
  const [job, setJob] = useState<LabsResearchJob | null>(runningJob);
  const [starting, setStarting] = useState(false);
  const [labLimit, setLabLimit] = useState(LABS_PAGE_SIZE);
  const [unmappedLimit, setUnmappedLimit] = useState(AUTHORS_PAGE_SIZE);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Reattach to a pass already running server-side (the board response carries it).
  useEffect(() => {
    if (runningJob && !job) setJob(runningJob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningJob]);

  // Poll the running pass; findings persist per author server-side, so refresh the board on
  // settle (and toast) — closing the screen only loses the toast.
  useEffect(() => {
    if (!pid || !job || job.status !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = (await api.getLabsResearchJob(pid, job.id)).job;
        if (cancelled || !alive.current) return;
        setJob(next);
        if (next.status !== 'running') {
          qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });
          showToast(
            next.status === 'done'
              // `stopped_reason` means the pass ended early even though it found something —
              // out of allowance, typically. Reporting only the mapped count would call an
              // interrupted pass finished, and re-running it produces the same partial result.
              ? next.stopped_reason
                ? `Mapped ${next.found} of ${next.total} — ${next.stopped_reason}`
                : `Lab research done — ${next.found} of ${next.total} top authors mapped`
              // The server's own message, not a generic retry prompt: a pass can stop because the
              // account is out of allowance, and "try again" is the one thing that will not help.
              : next.error || 'Lab research failed — try again',
          );
        }
      } catch {
        /* transient poll failure; next tick retries */
      }
    };
    const iv = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [pid, job, qc]);

  async function startResearch() {
    if (!pid || starting) return;
    setStarting(true);
    try {
      setJob((await api.startLabsResearch(pid)).job);
    } catch (e) {
      showToast((e as Error).message ?? 'Could not start lab research.');
    } finally {
      setStarting(false);
    }
  }

  const covered = new Set(labs?.covered_authors ?? []);
  const uncovered = authors.filter((a) => !covered.has(a.name));
  const visibleLabs = (labs?.labs ?? []).slice(0, labLimit);
  const visibleUncovered = uncovered.slice(0, unmappedLimit);
  const groups = groupByAffiliation(visibleUncovered);
  const researching = job?.status === 'running';
  const byName = new Map(authors.map((a) => [a.name, a]));

  useEffect(() => {
    setLabLimit(LABS_PAGE_SIZE);
    setUnmappedLimit(AUTHORS_PAGE_SIZE);
  }, [pid, labs?.labs.length, uncovered.length]);

  return (
    <>
      {researching ? (
        <View style={styles.researchRow}>
          <ActivityIndicator size="small" color={t.mint} />
          <Text variant="caption" color={t.muted} style={{ flex: 1 }}>
            Researching labs · {job!.done}/{job!.total}
            {job!.current ? ` · ${job!.current}` : ''}
          </Text>
        </View>
      ) : (
        <Button
          title={labs?.researched ? 'Re-run lab research' : 'Research labs (web pass)'}
          variant="ghost"
          icon="globe"
          onPress={() => void startResearch()}
          loading={starting}
          disabled={!pid}
        />
      )}

      {labs?.researched && labs.labs.length === 0 && !researching ? (
        <Text variant="caption" color={t.muted} style={styles.labsNote}>
          No distinct labs surfaced for this project's top authors — not every topic
          concentrates in labs. Individual affiliations continue below.
        </Text>
      ) : null}

      {visibleLabs.map((lab) => (
        <View key={lab.lab_name} style={styles.labCard}>
          <Text variant="heading">{lab.lab_name}</Text>
          {lab.institution ? (
            <Text variant="caption" color={t.muted}>{lab.institution}</Text>
          ) : null}
          {lab.focus ? (
            <Text variant="body" color={t.text} style={{ marginTop: 2 }}>{lab.focus}</Text>
          ) : null}
          <View style={styles.chipRow}>
            <Chip label={`${lab.in_project_count} in project`} color={t.mint} dot={false} />
            {lab.significant_count > 0 ? (
              <Chip label={`${lab.significant_count} significant`} color={t.amber} dot={false} />
            ) : null}
          </View>
          <View style={styles.chipRow}>
            {lab.members.map((name) => {
              const author = byName.get(name);
              return (
                <Pressable
                  key={name}
                  onPress={() => author && onSelectAuthor(author)}
                  style={({ pressed }) => pressed && { opacity: 0.7 }}>
                  <Chip label={name} color={t.violet} dot={false} />
                </Pressable>
              );
            })}
          </View>
          {lab.url ? (
            <Pressable
              onPress={() => void Linking.openURL(lab.url).catch(() => undefined)}
              accessibilityRole="link">
              <Text variant="caption" color={t.mint}>{lab.url} ↗</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {labLimit < (labs?.labs.length ?? 0) ? (
        <Button
          title={`Show more labs (${visibleLabs.length} of ${labs!.labs.length})`}
          variant="ghost"
          onPress={() => setLabLimit((n) => n + LABS_PAGE_SIZE)}
        />
      ) : null}

      {uncovered.length ? (
        <>
          {labs?.labs.length ? (
            <Text variant="caption" color={t.muted} style={[styles.groupHeader, { marginTop: space.lg }]}>
              NOT YET MAPPED TO A LAB
            </Text>
          ) : null}
          {groups.length === 1 && groups[0].affiliation === UNKNOWN_LABEL && !labs?.researched ? (
            <Text variant="caption" color={t.muted} style={styles.labsNote}>
              Affiliations fill in as the map is rebuilt; the web pass above finds the actual
              groups behind the top authors.
            </Text>
          ) : null}
          {groups.map((g) => (
            <View key={g.affiliation} style={{ marginTop: space.md }}>
              <Text variant="caption" color={t.muted} style={styles.groupHeader}>
                {g.affiliation.toUpperCase()}
              </Text>
              <View style={styles.cardGrid}>
                {g.authors.map((a) => (
                  <AuthorCard key={a.name} author={a} onPress={() => onSelectAuthor(a)} />
                ))}
              </View>
            </View>
          ))}
          {unmappedLimit < uncovered.length ? (
            <Button
              title={`Show more unmapped authors (${visibleUncovered.length} of ${uncovered.length})`}
              variant="ghost"
              onPress={() => setUnmappedLimit((n) => n + AUTHORS_PAGE_SIZE)}
            />
          ) : null}
        </>
      ) : null}
    </>
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
        title={state === 'running' ? 'Writing profile…' : 'Get profile'}
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
    <View style={{ gap: space.sm }}>
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
    </View>
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
  // Icon + number, sized so three fit on one line of a phone-width card.
  countStat: { flexDirection: 'row', alignItems: 'center', gap: 3, marginRight: 10 },
  countStatValue: { fontVariant: ['tabular-nums'] },
  researchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  labCard: {
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.lg,
    padding: space.md,
    gap: 6,
    marginTop: space.sm,
  },
  groupHeader: { marginBottom: 6, letterSpacing: 0.5 },
  labsNote: { lineHeight: 18, marginBottom: space.xs },
  sheetSection: { marginTop: space.sm, letterSpacing: 0.5 },
  paperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
});
