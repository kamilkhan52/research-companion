const unexpected = (name: string) =>
  jest.fn(async () => {
    throw new Error(`Unexpected API call in test: ${name}`);
  });

export const getAuthConfig = unexpected('getAuthConfig');
export const getAccountDeletion = jest.fn(async () => ({ deletion: null }));
export const startAccountDeletion = unexpected('startAccountDeletion');
// Defaults to failing loudly: a test that reports content without saying so is a test that
// silently exercises the network path it thinks it stubbed.
export const reportContent = unexpected('reportContent');
export const getHealth = jest.fn(async () => ({ ok: true, title: 'Test', dev: false }));
export const getSettings = unexpected('getSettings');
// Fails loudly by default: a screen that reads the allowance must say which allowance it read.
export const getPlan = unexpected('getPlan');
export const saveSettings = unexpected('saveSettings');
export const getModels = unexpected('getModels');
export const getFavoriteModels = jest.fn(async () => ({ models: [] }));
export const getPrompts = jest.fn(async (_project?: string | null) => ({ prompts: [] }));
export const savePrompt = jest.fn(async (key: string, value: string) => ({ key, value, is_overridden: true }));
export const resetPrompt = jest.fn(async (key: string) => ({ key, value: '', is_overridden: false }));
export const speak = unexpected('speak');
export const narrate = unexpected('narrate');
export const startAudioJob = unexpected('startAudioJob');
export const getAudioJob = unexpected('getAudioJob');
export const cancelAudioJob = jest.fn(async (id: string) => ({
  job: { id, status: 'cancelled' },
}));
export const listProjects = jest.fn(async () => ({ projects: [] }));
export const getRecentSessions = jest.fn(async () => ({ sessions: [] }));
export const backfillCovers = jest.fn(async () => ({ status: 'running' }));
export const getPaperCover = jest.fn(async () => ({ status: 'unavailable' as const }));
export const paperCoverImageSource = jest.fn(() => ({ uri: '', headers: {} }));
export const getPaperFigures = jest.fn(async () => ({ status: 'none' as const, figures: [] }));
export const figureAssetSource = jest.fn(
  (pid: string, slug: string, asset: string, version?: number | null) =>
    ({
      uri: `https://api.test/fig/${pid}/${slug}/${asset}${version ? `?v=${version}` : ''}`,
      headers: {},
    }),
);
export const createProject = unexpected('createProject');
export const getProjectState = unexpected('getProjectState');
export const getUsage = unexpected('getUsage');
export const getSession = unexpected('getSession');
export const createDiscussionThread = unexpected('createDiscussionThread');
export const getOpeningDraft = unexpected('getOpeningDraft');
export const startPaper = unexpected('startPaper');
export const startRetrievalJob = unexpected('startRetrievalJob');
export const getRetrievalJob = unexpected('getRetrievalJob');
export const getLatestRetrievalJob = jest.fn(async () => ({ job: null }));
export const uploadPaper = unexpected('uploadPaper');
export const updatePaper = unexpected('updatePaper');
export const removePaper = unexpected('removePaper');
export const reopen = unexpected('reopen');
export const approve = unexpected('approve');
export const getReview = unexpected('getReview');
export const addPaper = unexpected('addPaper');
export const findPaperMatches = jest.fn(async (_pid: string, candidate: { title: string }) => ({
  target_project: { id: _pid, name: 'Project' },
  can_update_notes: true,
  matches: [],
  candidate,
}));
export const switchBranch = unexpected('switchBranch');
export const turnJobPaths = jest.fn(() => ({}));
export const getChatJob = unexpected('getChatJob');
export const getActiveChatJob = unexpected('getActiveChatJob');
export const getPreviewJob = unexpected('getPreviewJob');
export const markPreviewPlayed = unexpected('markPreviewPlayed');
export const getNotes = unexpected('getNotes');
export const saveNotes = unexpected('saveNotes');
export const startNotesAgent = unexpected('startNotesAgent');
export const getNotesJob = unexpected('getNotesJob');
export const getActiveNotesJob = unexpected('getActiveNotesJob');
export const getLatestNotesJob = unexpected('getLatestNotesJob');
export const discardNotesJob = unexpected('discardNotesJob');
export const startDiscovery = unexpected('startDiscovery');
export const cancelDiscovery = unexpected('cancelDiscovery');
export const getDiscovery = unexpected('getDiscovery');
export const hideSuggestion = unexpected('hideSuggestion');
export const unhideSuggestion = unexpected('unhideSuggestion');
export const getGraph = unexpected('getGraph');
export const getGraphAuthors = unexpected('getGraphAuthors');
export const getRelated = unexpected('getRelated');
export const startGraphBuild = unexpected('startGraphBuild');
export const getGraphBuildStatus = unexpected('getGraphBuildStatus');
export const moveProject = jest.fn(
  async (_pid: string, body: {
    dest_pid: string;
    slugs: string[];
    remove_from_source: boolean;
    draft_destination_notes: boolean;
    cleanup_source_notes: boolean;
  }) => ({
    new_pid: body.dest_pid,
    name: 'Destination',
    moved: body.slugs.length,
    removed: body.remove_from_source,
    notes_jobs: {
      destination: null,
      source_cleanup: null,
      destination_error: null,
      source_cleanup_error: null,
    },
  }),
);
