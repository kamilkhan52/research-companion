const unexpected = (name: string) =>
  jest.fn(async () => {
    throw new Error(`Unexpected API call in test: ${name}`);
  });

export const getAuthConfig = unexpected('getAuthConfig');
export const getHealth = jest.fn(async () => ({ ok: true, title: 'Test', dev: false }));
export const getSettings = unexpected('getSettings');
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
export const paperCoverImageUrl = jest.fn(() => '');
export const createProject = unexpected('createProject');
export const getProjectState = unexpected('getProjectState');
export const getUsage = unexpected('getUsage');
export const getSession = unexpected('getSession');
export const getOpeningDraft = unexpected('getOpeningDraft');
export const startPaper = unexpected('startPaper');
export const reopen = unexpected('reopen');
export const approve = unexpected('approve');
export const addPaper = unexpected('addPaper');
export const switchBranch = unexpected('switchBranch');
export const streamPaths = jest.fn(() => ({}));
export const turnJobPaths = jest.fn(() => ({}));
export const getChatJob = unexpected('getChatJob');
export const getActiveChatJob = unexpected('getActiveChatJob');
export const getPreviewJob = unexpected('getPreviewJob');
export const getNotes = unexpected('getNotes');
export const saveNotes = unexpected('saveNotes');
export const startNotesAgent = unexpected('startNotesAgent');
export const getNotesJob = unexpected('getNotesJob');
export const getActiveNotesJob = unexpected('getActiveNotesJob');
export const startDiscovery = unexpected('startDiscovery');
export const getDiscovery = unexpected('getDiscovery');
export const getGraph = unexpected('getGraph');
export const getGraphAuthors = unexpected('getGraphAuthors');
export const getRelated = unexpected('getRelated');
export const startGraphBuild = unexpected('startGraphBuild');
export const getGraphBuildStatus = unexpected('getGraphBuildStatus');
export const mediaUrl = jest.fn((path: string) => `https://api.test${path}`);
