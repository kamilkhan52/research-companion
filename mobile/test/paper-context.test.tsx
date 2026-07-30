import { renderAsync, screen } from '@testing-library/react-native';

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));

import { PaperContext } from '@/app/paper/[slug]';
import type { Paper } from '@/api/types';

const paper = (over: Partial<Paper> = {}): Paper => ({
  slug: 'orca', title: 'Orca', group: 'G', list_status: 'unread', cites: [],
  retrieved: false, has_notes: false, session_state: null, arxiv_id: '', ...over,
} as Paper);

test('shows what is known before the paper has been read', async () => {
  await renderAsync(<PaperContext paper={paper({
    year: 2022,
    affiliations: ['Seoul National University'],
    abstract: 'Iteration-level scheduling for transformer serving.',
    project_links: { cites_in_project: 0, cited_by_in_project: 3, cited_by_read: 2 },
  })} />);

  expect(screen.getByText(/2022/)).toBeTruthy();
  expect(screen.getByText(/Seoul National University/)).toBeTruthy();
  expect(screen.getByText(/Iteration-level scheduling/)).toBeTruthy();
  // The read count is called out: a citation from a paper the reader actually read is a stronger
  // reason to care than one from another unread entry.
  expect(screen.getByText(/Cited by 3 here, 2 you've read/)).toBeTruthy();
});

test('drops the read clause when none of the citing papers have been read', async () => {
  await renderAsync(<PaperContext paper={paper({
    project_links: { cites_in_project: 0, cited_by_in_project: 2, cited_by_read: 0 },
  })} />);
  expect(screen.getByText('Cited by 2 here')).toBeTruthy();
});

test('renders NOTHING when nothing is known yet', async () => {
  // A row of blanks on exactly the papers the reader has not opened is worse than no row at all:
  // it reads as the app failing rather than as the fact not being known yet.
  const { toJSON } = await renderAsync(<PaperContext paper={paper()} />);
  expect(toJSON()).toBeNull();
});

test('renders nothing at all without a paper', async () => {
  const { toJSON } = await renderAsync(<PaperContext paper={null} />);
  expect(toJSON()).toBeNull();
});

test('omits the citation line when the paper is unconnected in this project', async () => {
  await renderAsync(<PaperContext paper={paper({
    year: 2020,
    project_links: { cites_in_project: 0, cited_by_in_project: 0, cited_by_read: 0 },
  })} />);
  expect(screen.queryByText(/Cited by/)).toBeNull();
  expect(screen.getByText('2020')).toBeTruthy();
});

test('a paper known only by what it cites is not treated as unknown', async () => {
  // `cites_in_project` was computed and then never rendered, so this paper — which the reader can
  // usefully place in their reading list — showed nothing at all.
  await renderAsync(<PaperContext paper={paper({
    project_links: { cites_in_project: 3, cited_by_in_project: 0, cited_by_read: 0 },
  })} />);
  expect(screen.getByText('Cites 3 here')).toBeTruthy();
});
