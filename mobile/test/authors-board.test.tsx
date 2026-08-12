import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Linking, StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { AuthorBoardResponse } from '@/api/types';
import AuthorsScreen, { labFallbackDescription } from '@/app/authors';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));
jest.mock('@/store/project', () => ({ useActiveProject: () => ({ activePid: 'proj' }) }));

const board: AuthorBoardResponse = {
  authors: [
    {
      name: 'Song Han', affiliation: 'MIT', in_project_count: 2, significant_count: 3,
      external_count: 5, active_years: [2022, 2023], activity: 17,
      papers: [
        { id: 'awq', slug: 'awq', title: 'AWQ', kind: 'project', year: 2023 },
        { id: 'ext:s', slug: null, title: 'StreamingLLM', kind: 'external', year: 2023 },
      ],
    },
    {
      name: 'Tri Dao', affiliation: '', in_project_count: 1, significant_count: 0,
      external_count: 2, active_years: [2022, 2022], activity: 5,
      papers: [{ id: 'flash', slug: 'flash', title: 'FlashAttention', kind: 'project', year: 2022 }],
    },
  ],
  explainers: {
    activity: 'Activity blends three signals: papers in this project (weight 3)…',
    significant: 'A citation is marked significant when the citing paper engages substantively…',
  },
  built_at: '2026-07-15T00:00:00Z',
  labs: { labs: [], covered_authors: [], researched: false, researched_at: null },
  labs_job: null,
};

function wrap(children: React.ReactNode) {
  const client = createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  mockPush.mockClear();
  jest.mocked(api.getGraphAuthors).mockResolvedValue(board);
});

test('renders the ranked author board with counts and affiliation', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  expect(screen.getByText('MIT')).toBeTruthy();
  // Counts as compact icon+number, not wrapped text chips (DR-008). Asserted through the card's
  // label: the bare numerals are ambiguous across cards, which is the point of the label.
  screen.getByLabelText('Song Han. 2 in project, 3 significant, 5 referenced.');
  expect(screen.getByText('Tri Dao')).toBeTruthy();
});

test('the card carries counts as numbers and the words in its label (DR-008)', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());

  // The nouns are identical on every card, so they belong to the screen reader rather than to
  // three chips that wrapped to a second line and pushed the name out of view.
  expect(screen.queryByText('2 in project')).toBeNull();
  expect(screen.queryByText('3 significant')).toBeNull();
  screen.getByLabelText('Song Han. 2 in project, 3 significant, 5 referenced.');
});

test('the publication-year range is not shown under the name (DR-008)', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());

  // `active_years` is the span of THIS project's papers, not the person's career, so under a name
  // it reads as a claim the data does not make. It stays in the API — `author_profiles` uses it.
  expect(screen.queryByText('2022–2023')).toBeNull();
  expect(screen.queryByText('2022')).toBeNull();
});

test('the scoring explainer is hidden until tapped', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  expect(screen.queryByText(/Activity blends three signals/)).toBeNull();
  await fireEventAsync.press(screen.getByText('How is this ranked?'));
  expect(screen.getByText(/Activity blends three signals/)).toBeTruthy();
});

test('tapping an author opens their papers; a project paper navigates to its discussion', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Song Han'));
  await waitFor(() => expect(screen.getByText(/AWQ/)).toBeTruthy());
  await fireEventAsync.press(screen.getByText(/AWQ/));
  expect(mockPush).toHaveBeenCalledWith('/paper/awq');
});

test('Labs mode groups by affiliation with unknowns last', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  // MIT appears as both a group header and a card affiliation line now.
  expect(screen.getAllByText('MIT').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('INDEPENDENT / UNKNOWN')).toBeTruthy();
});

test('Authors initially shows ten ranked cards and reveals the next page on demand', async () => {
  const template = board.authors[0];
  const manyAuthors = Array.from({ length: 12 }, (_, i) => ({
    ...template,
    name: `Author ${String(i + 1).padStart(2, '0')}`,
    activity: 100 - i,
    papers: [],
  }));
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: manyAuthors,
  });

  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Author 01')).toBeTruthy());
  expect(screen.getByText('Author 10')).toBeTruthy();
  expect(screen.queryByText('Author 11')).toBeNull();

  await fireEventAsync.press(screen.getByText('Show more authors (10 of 12)'));
  expect(screen.getByText('Author 11')).toBeTruthy();
  expect(screen.getByText('Author 12')).toBeTruthy();
});

test('Labs initially shows five researched groups and reveals more on demand', async () => {
  const template = board.authors[0];
  const labAuthors = Array.from({ length: 7 }, (_, i) => ({
    ...template,
    name: `Lab Member ${i + 1}`,
    papers: [],
  }));
  const labs = labAuthors.map((author, i) => ({
    lab_name: `Research Lab ${i + 1}`,
    institution: `Institute ${i + 1}`,
    url: '',
    focus: `Focus ${i + 1}`,
    members: [author.name],
    in_project_count: author.in_project_count,
    significant_count: author.significant_count,
  }));
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: labAuthors,
    labs: {
      labs,
      covered_authors: labAuthors.map((a) => a.name),
      researched: true,
      researched_at: '2026-07-18T00:00:00Z',
    },
  });

  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Lab Member 1')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  expect(screen.getByText('Research Lab 5')).toBeTruthy();
  expect(screen.queryByText('Research Lab 6')).toBeNull();

  await fireEventAsync.press(screen.getByText('Show more labs (5 of 7)'));
  expect(screen.getByText('Research Lab 6')).toBeTruthy();
  expect(screen.getByText('Research Lab 7')).toBeTruthy();
});

// DR-048 — Kamil, refining DR-008: "one per row rather than two; the stat icons need a key...
// Research Lab's placement and labelling do not say what it is doing."

test('the icon key renders once above the author list, not per card', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  expect(screen.getAllByText('Papers in project')).toHaveLength(1);
  expect(screen.getAllByText('Significant citations')).toHaveLength(1);
  expect(screen.getAllByText('Referenced works')).toHaveLength(1);
});

test('author cards render one per row (full width), not two-up', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  let node: ReactTestInstance | null = screen.getByText('Song Han');
  let width: unknown;
  let flexBasis: unknown;
  while (node) {
    const flat = StyleSheet.flatten(node.props?.style) as
      { width?: unknown; flexBasis?: unknown } | undefined;
    width = flat?.width;
    flexBasis = flat?.flexBasis;
    if (width != null || flexBasis != null) break;
    node = node.parent;
  }
  expect(width).toBe('100%');
  expect(flexBasis).toBeUndefined();
});

test('the Labs callout names the actual scope, not a bare button', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  expect(screen.getByText('Find labs behind top authors')).toBeTruthy();
  expect(screen.getByText('Checks up to 10 top authors on the web. Results are saved.')).toBeTruthy();
  expect(screen.getByText("Research top authors' labs")).toBeTruthy();
});

test('the Labs icon key omits "Referenced works" — lab data carries no such count', async () => {
  const labAuthors = [{ ...board.authors[0], papers: [] }];
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: labAuthors,
    labs: {
      labs: [{
        lab_name: 'Han Lab', institution: 'MIT', url: '', focus: '',
        members: ['Song Han'], in_project_count: 2, significant_count: 1,
      }],
      covered_authors: ['Song Han'], researched: true, researched_at: '2026-07-18T00:00:00Z',
    },
  });
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  await waitFor(() => expect(screen.getByText('Han Lab')).toBeTruthy());
  expect(screen.getByText('Papers in project')).toBeTruthy();
  expect(screen.getByText('Significant citations')).toBeTruthy();
  expect(screen.queryByText('Referenced works')).toBeNull();
});

test('a lab with a persisted focus shows it, ranked, without falling back', async () => {
  const labAuthors = [{ ...board.authors[0], papers: [] }];
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: labAuthors,
    labs: {
      labs: [{
        lab_name: 'Han Lab', institution: 'MIT', url: '', focus: 'Efficient LLM inference systems.',
        // significant_count deliberately 0: a CountStat chip only renders past zero, so a "1"
        // there would collide with the rank number "1" this test asserts against.
        members: ['Song Han'], in_project_count: 2, significant_count: 0,
      }],
      covered_authors: ['Song Han'], researched: true, researched_at: '2026-07-18T00:00:00Z',
    },
  });
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  expect(screen.getByText('1')).toBeTruthy(); // rank
  expect(screen.getByText('Efficient LLM inference systems.')).toBeTruthy();
  expect(screen.queryByText(labFallbackDescription({ institution: 'MIT', members: ['Song Han'] }))).toBeNull();
});

// The description Kamil asked for "does not have to be generated" (DR-048) — this is the case
// where the web pass genuinely found no summary; the row must still be legible.
test('a lab with no persisted focus falls back to a deterministic description, never a fresh call', async () => {
  const labAuthors = [{ ...board.authors[0], papers: [] }];
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: labAuthors,
    labs: {
      labs: [{
        lab_name: 'Han Lab', institution: 'MIT', url: '', focus: '',
        members: ['Song Han'], in_project_count: 2, significant_count: 1,
      }],
      covered_authors: ['Song Han'], researched: true, researched_at: '2026-07-18T00:00:00Z',
    },
  });
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  expect(screen.getByText('Research group at MIT; represented in this project by Song Han.')).toBeTruthy();
});

test('the lab card offers a globe URL action instead of a bare link line', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  const labAuthors = [{ ...board.authors[0], papers: [] }];
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: labAuthors,
    labs: {
      labs: [{
        lab_name: 'Han Lab', institution: 'MIT', url: 'https://hanlab.mit.edu', focus: 'Focus.',
        members: ['Song Han'], in_project_count: 2, significant_count: 1,
      }],
      covered_authors: ['Song Han'], researched: true, researched_at: '2026-07-18T00:00:00Z',
    },
  });
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  expect(screen.queryByText(/hanlab\.mit\.edu/)).toBeNull();
  await fireEventAsync.press(screen.getByLabelText("Open Han Lab's website"));
  expect(openURL).toHaveBeenCalledWith('https://hanlab.mit.edu');
  openURL.mockRestore();
});

// Opus review, PR #386, Finding 1: the ranked-labs section's LAB_ICON_KEY only renders once
// `visibleLabs.length` is nonzero — every project starts with `labs: { labs: [], researched:
// false }` (the `board` fixture's default), so this is the state most projects are in when a
// reader first opens Labs mode. The "not yet mapped to a lab" section below reuses AuthorCard's
// full three-icon vocabulary (including `link`, which LAB_ICON_KEY omits) and had no key of its
// own before this fix.
test('the unmapped-authors section carries its own icon key, even before any lab research has run', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  // The default fixture never researches labs, so TOP LABS/LAB_ICON_KEY never render — the only
  // "Referenced works" label possible here comes from AUTHOR_ICON_KEY above the unmapped groups.
  expect(screen.queryByText('TOP LABS')).toBeNull();
  expect(screen.getByText('Papers in project')).toBeTruthy();
  expect(screen.getByText('Significant citations')).toBeTruthy();
  expect(screen.getByText('Referenced works')).toBeTruthy();
});

// Opus review, PR #386, Finding 2: swapping the old Chip row (readable text: "2 in project") for
// bare-icon CountStats dropped the accessibility label that named the counts in words — unlike
// AuthorCard, which carries its own full label.
test('a lab card names its counts in words for a screen reader, not just bare icons', async () => {
  const labAuthors = [{ ...board.authors[0], papers: [] }];
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: labAuthors,
    labs: {
      labs: [{
        lab_name: 'Han Lab', institution: 'MIT', url: '', focus: 'Focus.',
        members: ['Song Han'], in_project_count: 2, significant_count: 3,
      }],
      covered_authors: ['Song Han'], researched: true, researched_at: '2026-07-18T00:00:00Z',
    },
  });
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  screen.getByLabelText('2 in project, 3 significant.');
});

test('a lab card with no significant citations omits that clause from the counts label', async () => {
  const labAuthors = [{ ...board.authors[0], papers: [] }];
  jest.mocked(api.getGraphAuthors).mockResolvedValueOnce({
    ...board,
    authors: labAuthors,
    labs: {
      labs: [{
        lab_name: 'Han Lab', institution: 'MIT', url: '', focus: 'Focus.',
        members: ['Song Han'], in_project_count: 2, significant_count: 0,
      }],
      covered_authors: ['Song Han'], researched: true, researched_at: '2026-07-18T00:00:00Z',
    },
  });
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  screen.getByLabelText('2 in project.');
});
