import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { GraphRecommendation, Paper, ProjectState } from '@/api/types';
import { RecommendationsPanel } from '@/components/graph/RecommendationsPanel';
import { NodeDetailSheet } from '@/components/graph/NodeDetailSheet';

const inProjectPaper: Paper = {
  slug: 'gpt4',
  title: 'GPT-4 Technical Report',
  group: 'Core',
  list_status: 'unread',
  cites: [],
  retrieved: true,
  has_notes: false,
  session_state: null,
  arxiv_id: '2303.08774',
};

const projectState = {
  project: { id: 'proj', name: 'Proj' },
  has_key: true,
  model: null,
  narration_model: null,
  preview_model: null,
  speech_provider: null,
  has_openai_key: false,
  papers: [inProjectPaper],
} as ProjectState;

const baseRec: GraphRecommendation = {
  id: 'ext:gpt4',
  kind: 'external',
  slug: null,
  title: 'GPT-4 Technical Report',
  authors: [],
  venue: '',
  year: 2023,
  arxiv_id: '2303.08774v2', // version suffix must not defeat the match
  doi: null,
  url: null,
  group: null,
  list_status: null,
  cited_by_project_count: 3,
  significant_cited_by_count: 1,
  cites_count: 0,
  recommend_score: 4.2,
  recommend_reasons: ['Cited by 3 project papers'],
  betweenness_centrality: 0,
};

function wrap(children: React.ReactNode) {
  const client = createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getProjectState).mockResolvedValue(projectState as never);
});

test('a recommendation already in the reading list shows In project, not + Add', async () => {
  await renderAsync(
    wrap(
      <RecommendationsPanel
        pid="proj"
        visible
        recommendations={[baseRec, { ...baseRec, id: 'ext:other', title: 'Some Other Work', arxiv_id: '2401.00001' }]}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    ),
  );

  // Membership arrives with the live project state.
  await waitFor(() => expect(screen.getByText('In project')).toBeTruthy());
  expect(screen.getByLabelText('GPT-4 Technical Report is in this project')).toBeTruthy();
  // The paper NOT in the project keeps its Add affordance.
  expect(screen.getByLabelText('Add Some Other Work to project')).toBeTruthy();
});

// U.17 — surfaces that know a paper's year must forward it, so a non-arXiv addition
// still lands dated in the reading list.
test('adding a recommendation forwards its year', async () => {
  jest.mocked(api.addPaper).mockResolvedValue({ paper: inProjectPaper } as never);
  await renderAsync(
    wrap(
      <RecommendationsPanel
        pid="proj"
        visible
        recommendations={[{ ...baseRec, id: 'ext:other', title: 'Some Other Work', arxiv_id: '2401.00001' }]}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    ),
  );
  // The Add press handler stops propagation (the row underneath opens the node); supply the
  // event object the real Pressable would.
  await fireEventAsync.press(await screen.findByLabelText('Add Some Other Work to project'), {
    stopPropagation: () => {},
  });
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith('proj', 'Some Other Work', undefined, '2401.00001', undefined, 2023),
  );
});

test('an external graph node already in the project (matched by title) cannot be re-added', async () => {
  await renderAsync(
    wrap(
      <NodeDetailSheet
        pid="proj"
        node={{
          ...baseRec,
          id: 'ext:by-title',
          arxiv_id: null, // graph metadata lacks the id -> exact-title match must still catch it
          title: 'gpt-4 technical report', // case-insensitive
        }}
        edges={[]}
        nodesById={{}}
        onClose={() => {}}
        onOpenPaper={() => {}}
      />,
    ),
  );

  await waitFor(() => expect(screen.getByText('Already in this project')).toBeTruthy());
});
