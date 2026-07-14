import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderAsync, screen } from '@testing-library/react-native';

import type { GraphNode } from '@/api/types';
import { NodeDetailSheet } from '@/components/graph/NodeDetailSheet';

const projectNode: GraphNode = {
  id: 'paper-slug',
  kind: 'project',
  slug: 'paper-slug',
  title: 'A Project Paper',
  authors: ['A. Author'],
  venue: 'arXiv',
  year: 2026,
  arxiv_id: '2601.00001',
  doi: null,
  url: null,
  group: null,
  list_status: 'read',
  cited_by_project_count: 10,
  significant_cited_by_count: 3,
  cites_count: 24,
  citation_count: 1204,
};

async function renderSheet(node: GraphNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  await renderAsync(
    <QueryClientProvider client={client}>
      <NodeDetailSheet
        pid="proj"
        node={node}
        edges={[]}
        nodesById={{}}
        onClose={() => {}}
        onOpenPaper={() => {}}
      />
    </QueryClientProvider>,
  );
}

test('stat tiles read label-first with unambiguous in-project vs overall labels', async () => {
  await renderSheet(projectNode);

  // Each tile is one accessibility node phrased label-first, so it can never be read as
  // "10 Significant in".
  expect(screen.getByLabelText('Cited in project: 10')).toBeTruthy();
  expect(screen.getByLabelText('Significant citations: 3')).toBeTruthy();
  expect(screen.getByLabelText('Cites: 24')).toBeTruthy();
  expect(screen.getByLabelText('Overall citations: 1,204')).toBeTruthy();

  // "Significant" is defined right below the tiles.
  expect(
    screen.getByText('Significant: cited as a baseline, extension, or dependency'),
  ).toBeTruthy();
});

test('external node hides the outgoing Cites tile and unknown overall citations', async () => {
  await renderSheet({
    ...projectNode,
    id: 'ext:key',
    kind: 'external',
    slug: null,
    list_status: null,
    citation_count: null,
  });

  expect(screen.getByLabelText('Cited in project: 10')).toBeTruthy();
  expect(screen.queryByLabelText(/^Cites:/)).toBeNull();
  expect(screen.queryByLabelText(/^Overall citations:/)).toBeNull();
});
