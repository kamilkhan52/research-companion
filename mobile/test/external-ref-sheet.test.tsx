import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { ProjectState } from '@/api/types';
import { ExternalRefSheet, parseArxivId } from '@/components/ExternalRefSheet';
import { rcSearchLink } from '@/lib/paperLinks';

const projectState = {
  project: { id: 'proj', name: 'Proj' },
  has_key: true,
  model: null,
  narration_model: null,
  preview_model: null,
  speech_provider: null,
  has_openai_key: false,
  papers: [
    {
      slug: 'gpt4', title: 'GPT-4 Technical Report', group: 'Core', list_status: 'unread',
      cites: [], retrieved: true, has_notes: false, session_state: null, arxiv_id: '2303.08774',
    },
  ],
} as ProjectState;

function wrap(children: React.ReactNode) {
  const client = createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getProjectState).mockResolvedValue(projectState as never);
});

test('parseArxivId reads abs and pdf urls only', () => {
  expect(parseArxivId('https://arxiv.org/abs/2303.08774')).toBe('2303.08774');
  expect(parseArxivId('https://arxiv.org/pdf/2303.08774v2')).toBe('2303.08774');
  expect(parseArxivId('https://example.com/paper')).toBeNull();
});

test('a web-found paper can be added straight from the sheet', async () => {
  jest.mocked(api.addPaper).mockResolvedValue({ paper: { slug: 'new' } } as never);
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: 'https://arxiv.org/abs/2401.12345', label: 'A New Related Work' }}
        onClose={() => {}}
      />,
    ),
  );
  expect(screen.getByText('A New Related Work')).toBeTruthy();
  expect(screen.getByText('Open link')).toBeTruthy();

  await fireEventAsync.press(screen.getByText('Add to reading list'));
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith('proj', 'A New Related Work', undefined, '2401.12345', undefined, undefined),
  );
  expect(screen.getByText('Added to reading list')).toBeTruthy();
});

test('a reference already in the project cannot be re-added', async () => {
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: 'https://arxiv.org/abs/2303.08774v1', label: 'GPT-4 Technical Report' }}
        onClose={() => {}}
      />,
    ),
  );
  await waitFor(() => expect(screen.getByText('Already in this project')).toBeTruthy());
  expect(screen.queryByText('Add to reading list')).toBeNull();
});

test('a URL-shaped label is not treated as a title; add uses the arXiv placeholder', async () => {
  jest.mocked(api.addPaper).mockResolvedValue({ paper: { slug: 'new' } } as never);
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: 'https://arxiv.org/abs/2211.10438', label: 'arxiv.org/abs/2211.10438' }}
        onClose={() => {}}
      />,
    ),
  );
  await fireEventAsync.press(screen.getByText('Add to reading list'));
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith('proj', 'arXiv 2211.10438', undefined, '2211.10438', undefined, undefined),
  );
});

// DR-054 — a citation the model has no sourceable URL for arrives as `rc-search:<title>`
// instead of a real link. There's nothing to "Open" (no source was ever found), so the sheet
// must offer a title search instead, and never store the pseudo-href as a pdfUrl on add.

test('a name-only reference (rc-search) offers a Scholar search, not "Open link"', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: rcSearchLink('LoongServe'), label: 'LoongServe' }}
        onClose={() => {}}
      />,
    ),
  );
  expect(screen.getAllByText('LoongServe').length).toBeGreaterThan(0);
  expect(screen.queryByText('Open link')).toBeNull();
  expect(screen.getByText('Search Scholar')).toBeTruthy();

  await fireEventAsync.press(screen.getByText('Search Scholar'));
  expect(openURL).toHaveBeenCalledWith('https://scholar.google.com/scholar?q=LoongServe');
});

test('adding a name-only reference never carries the rc-search marker as a source_url', async () => {
  // Opus review, PR #377: `pdfUrl` is never one of api.addPaper's own arguments — it only
  // reaches the wire as `source_url` on the PREFLIGHT duplicate-check call
  // (useAddPaper -> api.findPaperMatches). Asserting on api.addPaper's call shape (the
  // original version of this test) can't observe the guard at all; it passed even before the
  // guard existed.
  jest.mocked(api.addPaper).mockResolvedValue({ paper: { slug: 'new' } } as never);
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: rcSearchLink('LoongServe'), label: 'LoongServe' }}
        onClose={() => {}}
      />,
    ),
  );
  await fireEventAsync.press(screen.getByText('Add to reading list'));
  await waitFor(() =>
    expect(api.findPaperMatches).toHaveBeenCalledWith('proj', {
      title: 'LoongServe',
      arxiv_id: undefined,
      source_url: undefined,
    }),
  );
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith('proj', 'LoongServe', undefined, undefined, undefined, undefined),
  );
});

// DR-104 (Kamil: "It is almost impossible to find Tesseract or PAPI just from these titles") —
// the analyst now writes the work's COMPLETE title into the `rc-search:` target and keeps the
// short name as link text. For a name-only citation the target therefore outranks the label:
// it is the identifying string, and it is what a search and an add both need.
test('a name-only reference searches and files under its full target title, not its short label', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  jest.mocked(api.addPaper).mockResolvedValue({ paper: { slug: 'new' } } as never);
  const full = 'Tesseract: A Scalable Processing-in-Memory Accelerator for Parallel Graph Processing';
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: rcSearchLink(full), label: 'Tesseract' }}
        onClose={() => {}}
      />,
    ),
  );
  expect(screen.getAllByText(full).length).toBeGreaterThan(0);

  await fireEventAsync.press(screen.getByText('Search Scholar'));
  expect(openURL).toHaveBeenCalledWith(
    `https://scholar.google.com/scholar?q=${encodeURIComponent(full)}`,
  );

  await fireEventAsync.press(screen.getByText('Add to reading list'));
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith('proj', full, undefined, undefined, undefined, undefined),
  );
});

// A real URL keeps label-first behaviour: there the label is the human title and the href is a
// source, so nothing about DR-104 applies.
test('a real-URL reference still files under its label', async () => {
  jest.mocked(api.addPaper).mockResolvedValue({ paper: { slug: 'new' } } as never);
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: 'https://arxiv.org/abs/2401.99999', label: 'A Web-Found Paper' }}
        onClose={() => {}}
      />,
    ),
  );
  await fireEventAsync.press(screen.getByText('Add to reading list'));
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith(
      'proj', 'A Web-Found Paper', undefined, '2401.99999', undefined, undefined,
    ),
  );
});

// Opus review, PR #377 (F4): `title` derived from `refItem.label` is null whenever the label
// is missing, URL-shaped, or equal to the href — every `title ?? refItem.href` fallback in the
// component would then store or display the raw `rc-search:<title>` marker verbatim (a
// reading-list entry literally titled "rc-search:LoongServe: A..."). The href itself must be
// decoded as the next-best title before ever falling all the way to the bare marker.
test('a name-only reference with no usable label still adds under its decoded title, never the raw marker', async () => {
  jest.mocked(api.addPaper).mockResolvedValue({ paper: { slug: 'new' } } as never);
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: rcSearchLink('LoongServe: A Distributed Serving System') }}
        onClose={() => {}}
      />,
    ),
  );
  expect(screen.getAllByText('LoongServe: A Distributed Serving System').length).toBeGreaterThan(0);
  expect(screen.queryByText(/^rc-search:/)).toBeNull();

  await fireEventAsync.press(screen.getByText('Add to reading list'));
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith(
      'proj', 'LoongServe: A Distributed Serving System', undefined, undefined, undefined, undefined,
    ),
  );
});
