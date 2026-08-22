// Discussion — the streaming chat with the analyst over one paper (or the Project Notes review).
// Compose-first: edit the opening prompt, then start. Mid-discussion: reply with streaming
// responses. Wrap-up: draft notes, then approve / request changes. Turns run as server-side
// background jobs (polled, not held open), so a turn survives leaving this screen, the app
// backgrounding, or the tunnel dropping — on entry we reattach to any turn still in flight,
// and after each turn we refetch the canonical transcript the server recorded.
//
// The thread itself (inverted message list, keyboard handling, composer shell, scroll-to-
// bottom) is the chat library's; we plug in domain renderers: Markdown assistant messages
// with listen/copy, the live turn's interleaved text/tool items, and the lifecycle-dependent
// input toolbar (reply → draft notes → request changes / approve → committed).

import {
  Bubble,
  Chat,
  InputToolbar,
  type BubbleProps,
  type InputToolbarProps,
  type LeftRightStyle,
  type MessageTextProps,
} from '@kesha-antonov/react-native-chat';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsPlaying } from 'react-native-track-player';

import * as Clipboard from 'expo-clipboard';

import * as api from '@/api/endpoints';
import { turnJobPaths } from '@/api/endpoints';
import { useFavoriteModels, useOpeningDraft, usePaperFigures, useSession, useSettings } from '@/api/queries';
import { keys } from '@/api/queries';
import type {
  ChatJob,
  DiscussionThreadSummary,
  FavoriteModel,
  Paper,
  ProjectState,
  ReadingMode,
  RecentSession,
  RetrievalJob,
  Session,
  SessionState,
  StreamItem,
  TranscriptEntry,
} from '@/api/types';
import { READING_MODE_LABELS } from '@/api/types';
import { useAudio } from '@/audio/AudioProvider';
import { messageAudioId, useListeningHandoffRecovery } from '@/audio/identity';
import { isHandoffEligible } from '@/audio/handoffState';
import { usePreviewCues } from '@/audio/usePreviewCues';
import {
  toDiscussionMessages,
  isPaperSummaryTurn,
  DISCUSSION_USER,
  type DiscussionMessage,
} from '@/components/chat/discussionMessages';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { ReportContentSheet, reportReference } from '@/components/ReportContentSheet';
import { BottomSheet, BottomSheetTextInput } from '@/components/BottomSheet';
import { SentenceCommentComposer } from '@/components/chat/SentenceCommentComposer';
import { GrowingComposer } from '@/components/chat/GrowingComposer';
import { DiscussionEdgeFade } from '@/components/chat/DiscussionEdgeFade';
import {
  discussionChromeLayout,
  discussionComposerPadding,
} from '@/components/chat/discussionLayout';
import { NotesReviewSheet } from '@/components/NotesReviewSheet';
import { presentSpendJobRefusal, presentSpendRefusal } from '@/components/SpendRefusalSheet';
import { showToast } from '@/ui/Toast';
import { AgentActivity } from '@/components/AgentActivity';
import { ConnectionNotice } from '@/components/ConnectionNotice';
import { AgentTrail, ToolLine } from '@/components/AgentTrail';
import { ProgressSteps } from '@/components/ProgressSteps';
import { finishSteps } from '@/lib/finishSteps';
import { retrievalProgress } from '@/lib/retrievalSteps';
import { ExternalRefSheet, type ExternalRef } from '@/components/ExternalRefSheet';
import {
  PaperSummaryRetrySheet,
  OPENING_TEMPLATE_OPTIONS,
  type PaperSummaryRetryConfig,
  type OpeningTemplateKey,
} from '@/components/PaperSummaryRetrySheet';
import {
  LinkHandlerContext,
  Markdown,
  type FigureContext,
  type LinkHandler,
  type SentenceAnnotations,
} from '@/components/Markdown';
import { usePaperActions } from '@/components/PaperEntityProvider';
import { PromptTemplateOption } from '@/components/PromptTemplateOption';
import { GeneratingBar } from '@/components/NarrationTranscript';
import { RelatedWorksSheet } from '@/components/RelatedWorksSheet';
import {
  DiscussionLoadingSkeleton,
  PaperSetupLoadingSkeleton,
} from '@/components/LoadingSkeletons';
import { TopBar } from '@/components/TopBar';
import {
  DISCUSSION_SKELETON_DELAY_MS,
  INITIAL_SKELETON_DELAY_MS,
  useDelayedInitialSkeleton,
} from '@/hooks/useDelayedInitialSkeleton';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { useReviewAutoOpen } from '@/hooks/useReviewAutoOpen';
import { useSmoothText } from '@/hooks/useSmoothText';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';
import {
  RevealPausedContext,
  useReaderAwayFromLive,
  useRevealPaused,
} from '@/hooks/useStreamPinnedScroll';
import { useActiveProject } from '@/store/project';
import { useListeningMode } from '@/store/listening';
import { clearLastThread, loadLastThread, saveLastThread } from '@/lib/lastThread';
import { fullPaperUrl, titleFromRcSearchLink } from '@/lib/paperLinks';
import {
  composeSentenceReply,
  removeSentenceComment,
  sameSentence,
  sentenceCommentPayload,
  sentenceCommentsDraftKey,
  upsertSentenceComment,
  type PendingSentenceComment,
  type SelectedSentence,
} from '@/lib/sentenceComments';
import {
  Button,
  Card,
  Chip,
  Icon,
  IconButton,
  makeTextStyles,
  Screen,
  Text,
  type IconName,
} from '@/ui';
import {
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  TEXT_SCALE_STEP,
  useTheme,
  useThemedStyles,
  useThemeMode,
  type DensityMode,
} from '@/theme/ThemeProvider';
import { control, floatShadow, fonts, radius, space, type ThemePalette } from '@/theme/tokens';

// The library caps each message row to Message/styles.js's default `maxWidth: '70%'` (a
// row of `flexDirection: 'row'`, so a plain width override on the child bubble can't stretch
// it — Yoga only stretches a flex child along the CROSS axis). Flipping the row to a column
// lets the default `alignItems: 'stretch'` fill the row's own (now unconstrained) width, which
// cascades down through Bubble's unstyled wrapper Views to the visible bubble. `containerStyle`
// is read by Message (Message/types.d.ts) via Chat's untyped prop pass-through, but isn't part
// of ChatProps' declared surface — the cast is the seam, not a type escape from our own code.
const FULL_WIDTH_ROW: ViewStyle = {
  flexDirection: 'column',
  alignItems: 'stretch',
  width: '100%',
  maxWidth: '100%',
  marginLeft: 0,
  marginRight: 0,
};
// User replies stay a floating right-aligned bubble (distinct from the assistant's document
// bands): keep the library's row layout, just widen its 70% cap and give it an edge margin.
const USER_ROW: ViewStyle = {
  maxWidth: '86%',
  marginRight: space.md,
  marginVertical: space.xs,
};
const ROW_STYLES_PROP = {
  containerStyle: { left: FULL_WIDTH_ROW, right: USER_ROW } as LeftRightStyle<ViewStyle>,
};

// A full-width band must be square on every corner, and `borderRadius: 0` alone does not achieve
// that. The library groups consecutive messages from the same user and adds corner-SPECIFIC radii
// for the grouping (`containerToNext_left: borderBottomLeftRadius: 3`, `containerToPrevious_left:
// borderTopLeftRadius: 3` in lib/Bubble/styles.js), and React Native resolves a specific corner
// ahead of the generic `borderRadius` no matter which style object comes last in the array. Two
// adjacent assistant rows therefore kept a 3px notch on the left edge. Zero all four explicitly.
const SQUARE_CORNERS = {
  borderRadius: 0,
  borderTopLeftRadius: 0,
  borderTopRightRadius: 0,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
} as const;

/** A durable discussion state is sufficient to render the existing thread even before its
 * transcript refetch settles. In particular, never send an in-flight/empty first turn back to
 * ComposeFirst merely because its title was updated while the session cache refreshed. */
export function hasStartedDiscussion(
  state: SessionState,
  transcriptLength: number,
  threadId: string,
): boolean {
  return transcriptLength > 0
    || threadId !== 'main'
    || state === 'in_discussion'
    || state === 'notes_drafted'
    || state === 'committed';
}

/** Pick a loading surface only when navigation/cache state makes the eventual screen knowable.
 * A cold main-thread deep link can resolve to either ComposeFirst or an existing discussion, so
 * guessing there creates the exact disconnected placeholder transition a skeleton should avoid. */
export function paperLoadingSurface(
  state: SessionState,
  threadId: string,
  hasSurfaceHint: boolean,
): 'discussion' | 'setup' | null {
  if (!hasSurfaceHint) return null;
  if (threadId !== 'main') return 'discussion';
  return hasStartedDiscussion(state, 0, threadId) ? 'discussion' : 'setup';
}

/** Select the lifecycle belonging to the route we are about to show. `null` is meaningful — it
 * means ComposeFirst — so only `undefined` may fall through to a less-authoritative cache. */
export function anticipatedPaperState(
  sessionState: SessionState | undefined,
  threadId: string,
  cachedPaperState: SessionState | undefined,
  cachedRecentState: SessionState | undefined,
  cachedThreadState: SessionState | undefined,
): SessionState {
  if (sessionState !== undefined) return sessionState;
  if (threadId !== 'main') return cachedThreadState ?? null;
  if (cachedPaperState !== undefined) return cachedPaperState;
  return cachedRecentState ?? null;
}

/** Merge a confirmed title response into the session the reader is actually viewing before
 * refetching it. The transcript/state/thread id stay intact; the old path invalidated a
 * main-shaped query prefix without applying the response to the active snapshot first. */
export async function applyPaperUpdateToActiveSession(
  qc: QueryClient,
  pid: string,
  slug: string,
  activeThread: string,
  paper: Paper,
): Promise<void> {
  const sessionKey = keys.session(pid, slug, activeThread);
  qc.setQueryData<Session>(sessionKey, (current) => (
    current ? { ...current, paper: { ...current.paper, ...paper } } : current
  ));
  await Promise.all([
    qc.invalidateQueries({ queryKey: sessionKey, exact: true }),
    qc.invalidateQueries({ queryKey: keys.projectState(pid) }),
  ]);
}
export default function DiscussionScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  // `source` (optional) carries a pasted arXiv id / PDF link from the Discover screen's
  // "specific paper" box, so the first fetch uses exactly that source.
  const { slug, source, project, thread, autoStart } = useLocalSearchParams<{
    slug: string;
    source?: string;
    project?: string;
    thread?: string;
    autoStart?: string;
  }>();
  const { activePid, setActivePid } = useActiveProject();
  // Continue Reading can target a session in a different project. Prefer its explicit route
  // parameter on the very first render, then synchronize the app-wide selection. That avoids
  // a transient request for the same slug under the previously-active project.
  const routePid = typeof project === 'string' && project ? project : null;
  const pid = routePid ?? activePid;
  useEffect(() => {
    if (routePid && routePid !== activePid) setActivePid(routePid);
  }, [activePid, routePid, setActivePid]);

  // Reference links in a response: in-project papers arrive as `rc-paper:<slug>` (or get
  // linkified from an exact title mention) and open the paper action sheet — hop to its
  // discussion, notes, or Map spot; external references (a URL/arXiv link) prompt to open
  // the source or add it to the reading list.
  const showPaperActions = usePaperActions();
  // External references open a real action sheet (ExternalRefSheet) with live membership,
  // replacing the old bare Alert — the flow Kamil asked for: agent cites a web-found paper,
  // the reader taps it and adds it to the project right from the discussion.
  const [externalRef, setExternalRef] = useState<ExternalRef | null>(null);
  const handleReferenceLink = useCallback<LinkHandler>((href, label) => {
    if (href.startsWith('rc-paper:')) {
      const s = href.slice('rc-paper:'.length);
      if (s) showPaperActions(s);
      return;
    }
    // DR-054: a citation the model has no sourceable URL for. Opens the same sheet as an
    // external URL reference, with a title-search fallback in place of "Open link".
    const searchTitle = titleFromRcSearchLink(href);
    if (searchTitle) {
      setExternalRef({ href, label: label ?? searchTitle });
      return;
    }
    if (!/^https?:\/\//i.test(href)) return;
    setExternalRef({ href, label });
  }, [showPaperActions]);

  const explicitThread = typeof thread === 'string' && thread ? thread : null;
  const [activeThread, setActiveThread] = useState(explicitThread ?? 'main');
  // Set once the thread for this screen visit is decided by the route or the user; a stored
  // last-opened thread restore must never override either.
  const threadChosenRef = useRef(false);
  useEffect(() => {
    threadChosenRef.current = !!explicitThread;
    setActiveThread(explicitThread ?? 'main');
    if (!pid || !slug) return;
    if (explicitThread) {
      // An explicit navigation IS an open: remember it for the next plain resume.
      saveLastThread(pid, slug, explicitThread);
      return;
    }
    // Plain resume: return to the thread last open on this paper (usage note R12.2).
    let active = true;
    void loadLastThread(pid, slug).then((stored) => {
      if (!active || !stored || stored === 'main' || threadChosenRef.current) return;
      setActiveThread(stored);
    });
    return () => {
      active = false;
    };
  }, [slug, explicitThread, pid]);
  // The user's own pick (thread sheet, new thread) both wins over any pending restore and
  // becomes the remembered thread.
  const selectThread = useCallback(
    (threadId: string) => {
      threadChosenRef.current = true;
      setActiveThread(threadId);
      if (pid && slug) saveLastThread(pid, slug, threadId);
    },
    [pid, slug],
  );
  // Session and opening-draft requests are two stages of one route bootstrap. Anchor both
  // placeholders to the same deadline so ComposeFirst never starts a second 500 ms blank window
  // after the session request settles. useMemo scopes the clock to this route without mutating a
  // ref during render; revisiting another paper/thread earns a fresh initial-load gate.
  const bootstrapKey = `${pid ?? ''}\u0000${slug ?? ''}\u0000${activeThread}`;
  const bootstrapStartedAt = useMemo(() => Date.now(), [bootstrapKey]);
  const session = useSession(pid, slug ?? null, activeThread);
  const showSessionSkeleton = useDelayedInitialSkeleton(
    session.isLoading,
    session.data !== undefined,
    DISCUSSION_SKELETON_DELAY_MS,
  );
  // Project state and recents already describe whether this route is an unread setup or an
  // existing discussion. Reuse those warm caches while the heavier transcript request is empty,
  // so a delayed placeholder has the same chrome and body geometry as what will replace it.
  const cachedPaper = pid && slug
    ? qc.getQueryData<ProjectState>(keys.projectState(pid))?.papers.find((paper) => paper.slug === slug)
    : undefined;
  const cachedRecent = pid && slug
    ? qc.getQueryData<RecentSession[]>(keys.recentSessions)?.find(
        (recent) => recent.project_id === pid && recent.slug === slug,
      )
    : undefined;
  const cachedMainSession = pid && slug
    ? qc.getQueryData<Session>(keys.session(pid, slug))
    : undefined;
  const cachedThread = activeThread === 'main'
    ? undefined
    : cachedMainSession?.threads?.find((candidate) => candidate.id === activeThread);
  // A remembered thread can go stale (paper moved, project state rebuilt): fall back to main
  // instead of wedging the screen on a 404, and forget the stale id.
  useEffect(() => {
    const message = session.error ? String((session.error as Error).message ?? '') : '';
    if (activeThread !== 'main' && message.includes('Unknown discussion thread')) {
      threadChosenRef.current = false;
      setActiveThread('main');
      if (pid && slug) clearLastThread(pid, slug);
    }
  }, [session.error, activeThread, pid, slug]);
  const settings = useSettings();
  const favoriteModels = useFavoriteModels();
  // The model for the *next* new response in this discussion only (Gemini/ChatGPT-style
  // picker) — component state, never persisted to AsyncStorage or Settings, so it resets to
  // the account default whenever this screen is opened fresh. Threaded as a one-shot `model`
  // override into reply/finish/requestChanges/chatStart; never silently changes the default
  // (locked product decision).
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  useEffect(() => {
    setSelectedModel(null);
  }, [slug, activeThread]);
  const audio = useAudio();
  const { listeningMode, setListeningMode } = useListeningMode();
  // Bumped when a turn settles WITH a fresh Notes proposal — the authoritative signal the
  // review auto-open (D03) keys on. The thread component owns the review sheet.
  const [reviewReadyNonce, setReviewReadyNonce] = useState(0);
  const handleTurnDone = useCallback(async (job: ChatJob) => {
    // Detect a freshly drafted proposal FIRST, before any delivery-mode early return or the
    // audio-error throw below, so a Finish/Request-changes turn always arms the auto-open —
    // in reading mode too, and even if the subsequent audio handoff fails.
    if (job.turn?.proposed_commit && job.state === 'notes_drafted') {
      setReviewReadyNonce((n) => n + 1);
    }
    if (!listeningMode || job.delivery_mode !== 'listening') return;
    if (!(await isHandoffEligible(job.id))) return;
    // A REFUSED narration start opens the refusal sheet (device voice included) instead of
    // surfacing the raw server sentence as an error toast (DR-049).
    if (presentSpendJobRefusal(job.audio_refusal, { operation: 'narration' })) return;
    if (job.audio_error) throw new Error(job.audio_error);
    const canonical = job.turn?.canonical;
    if (!job.audio_job_id || !canonical || job.assistant_index == null || !pid || !slug) return;
    audio.enqueueJob(
      {
        id: messageAudioId(
          pid,
          activeThread === 'main' ? slug : `${slug}--${activeThread}`,
          job.assistant_index,
          canonical,
        ),
        title: session.data?.paper.title ?? 'Narration',
        text: canonical,
      },
      job.audio_job_id,
      pid,
      job.id,
    );
  }, [activeThread, audio, listeningMode, pid, session.data?.paper.title, slug]);
  const stream = useStreamingTurn(
    pid,
    slug ?? null,
    listeningMode ? 'listening' : 'reading',
    handleTurnDone,
    activeThread,
  );
  usePreviewCues({
    enabled: listeningMode,
    project: pid,
    title: session.data?.paper.title ?? 'Research update',
    jobIds: stream.previewJobIds,
    playPreview: audio.playPreview,
    parentJobId: stream.previewParentJobId,
  });

  const state = session.data?.state ?? null;
  const transcript = session.data?.transcript ?? [];
  const hasSession = hasStartedDiscussion(state, transcript.length, activeThread);
  const anticipatedState = anticipatedPaperState(
    session.data?.state,
    activeThread,
    cachedPaper?.session_state,
    cachedRecent?.state,
    cachedThread?.state,
  );
  const loadingSurface = session.isLoading
    ? paperLoadingSurface(
        anticipatedState,
        activeThread,
        activeThread === 'main'
          ? cachedPaper !== undefined || cachedRecent !== undefined
          : cachedThread !== undefined,
      )
    : null;
  const loadingExistingDiscussion = loadingSurface === 'discussion';
  // Only a setup-shaped stage-one placeholder can hand directly to ComposeFirst. A cold deep
  // link deliberately rendered no skeleton while its destination was unknown, so even after the
  // route deadline elapses it still gets a short flash guard for a fast opening-draft response.
  const cachedMainState = anticipatedPaperState(
    undefined,
    'main',
    cachedPaper?.session_state,
    cachedRecent?.state,
    undefined,
  );
  const bootstrapHadSetupSurface = activeThread === 'main'
    && (cachedPaper !== undefined || cachedRecent !== undefined)
    && paperLoadingSurface(cachedMainState, 'main', true) === 'setup';
  // Once a real transcript exists, the discussion owns the entire viewport and the header
  // becomes independent overlay chrome. Pre-discussion/setup/loading states keep the ordinary
  // in-flow top bar because their forms are not scroll-under reading surfaces. A known existing
  // discussion keeps that same overlay chrome during a delayed empty-cache skeleton, preventing
  // the header from jumping between two unrelated layouts when the transcript arrives.
  const immersiveDiscussion = !!pid
    && ((hasSession && !session.isLoading) || loadingExistingDiscussion);
  const paths = pid ? turnJobPaths(pid) : null;
  useListeningHandoffRecovery({
    enabled: listeningMode,
    project: pid,
    slug: slug
      ? (activeThread === 'main' ? slug : `${slug}--${activeThread}`)
      : null,
    title: session.data?.paper.title ?? 'Narration',
    transcript,
    enqueueJob: audio.enqueueJob,
  });

  // Reattach to a turn that's still generating for this paper (we navigated away mid-turn,
  // the app was backgrounded, the connection dropped…). The job kept running server-side.
  useEffect(() => {
    void stream.resume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, slug, activeThread]);

  const [showRelated, setShowRelated] = useState(false);
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);
  // Model + reading-mode pickers live behind the kebab menu (polish plan H.1) — the header
  // stays quiet: back, title, one menu button.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);
  const readingMode = session.data?.reading_mode ?? 'balanced';
  const paperUrl = session.data?.paper ? fullPaperUrl(session.data.paper) : null;
  const selectedModelLabel =
    selectedModel == null
      ? (settings.data?.model ?? 'Project default')
      : (favoriteModels.data?.find((m) => m.id === selectedModel)?.label ?? selectedModel);
  const switchMode = useCallback(async (mode: ReadingMode) => {
    if (!pid || !slug || mode === readingMode) return;
    try {
      await api.setSessionMode(pid, slug, mode, activeThread);
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug, activeThread) });
    } catch (e) {
      Alert.alert('Could not switch mode', (e as Error).message ?? 'Request failed.');
    }
  }, [activeThread, pid, qc, readingMode, slug]);
  // The measured height does two jobs. In ordinary setup states it corrects the chat library's
  // keyboard offset for the in-flow bar. In an immersive discussion it becomes the list's visual
  // top inset, so the oldest content can rest below the floating chrome while still scrolling
  // underneath it.
  const [headerHeight, setHeaderHeight] = useState(0);

  // Auto-analysis can fetch and open the first discussion while this screen is elsewhere.
  // On re-entry, surface the resolver's canonical title even though ComposeFirst is skipped.
  useEffect(() => {
    if (!hasSession || !pid || !slug || session.data?.paper.title_confirmed) {
      setSuggestedTitle(null);
      return;
    }
    let active = true;
    void api.getLatestRetrievalJob(pid, slug).then(
      ({ job }) => {
        const found = job?.retrieved ? job.matched_title?.trim() : null;
        if (active && shouldSuggestCanonicalTitle(session.data?.paper ?? null, found)) {
          setSuggestedTitle(found);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [hasSession, pid, session.data?.paper, slug]);

  async function finishReadingFromMenu() {
    if (!paths || !slug) return;
    await stream.run(paths.finish, { slug, model: selectedModel ?? undefined });
  }

  // DR-043 — a notes proposal from the discussion so far, any time. The job runs server-side;
  // the notes screen resumes it and hosts the review, so approval stays exactly where #345
  // put it. The agent can start the same job itself via its propose_notes_update tool.
  async function updateNotesFromDiscussion() {
    if (!pid || !slug) return;
    // DR-043 (Kamil, 2026-08-22): feedback BEFORE the network — an awaited POST with the
    // toast on the far side means a slow or dead request looks like a dead button.
    showToast('Drafting a Paper Notes update from the discussion…');
    try {
      await api.startNotesDiscussionUpdate(pid, slug, activeThread);
      router.push(`/notes/${encodeURIComponent(slug)}`);
    } catch (e) {
      if (presentSpendRefusal(e, { operation: 'other', retry: updateNotesFromDiscussion })) return;
      showToast((e as Error).message ?? 'Could not start the Paper Notes update.');
    }
  }

  // Committed -> back in discussion (polish plan H.2): the server keeps everything recorded;
  // only the state flips, so the composer returns and a later Finish proposes a fresh draft.
  async function continueFromCommitted() {
    if (!pid || !slug) return;
    try {
      await api.continueDiscussion(pid, slug, activeThread);
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug, activeThread) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    } catch (e) {
      Alert.alert('Could not continue the discussion', (e as Error).message ?? 'Request failed.');
    }
  }

  // DR-079 — "there should be a way to clear all chats". Two-step by design: the clear is
  // confirmed destructively, and the Project Notes retraction is a SEPARATE offer that goes
  // through the notes agent's propose/review flow (invariant 4 — removing committed notes
  // content is a proposal the human approves, never a side effect).
  function confirmClearChats() {
    if (!pid || !slug) return;
    Alert.alert(
      'Clear all chats for this paper?',
      'Every discussion thread is cleared. Committed notes and the paper itself are kept. This cannot be undone from the app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear chats',
          style: 'destructive',
          onPress: () => {
            void api.clearChats(pid, slug).then(
              async (result) => {
                await qc.invalidateQueries({ queryKey: keys.session(pid, slug, activeThread) });
                await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
                void qc.invalidateQueries({ queryKey: keys.sessionsIn(pid) });
                void qc.invalidateQueries({ queryKey: keys.recentSessions });
                if (result.contributed) {
                  Alert.alert(
                    'This paper contributed to Project Notes',
                    'Want to propose removing its contribution? You review the edit before anything changes.',
                    [
                      { text: 'Keep notes', style: 'cancel' },
                      {
                        text: 'Propose removal',
                        onPress: () => {
                          const title = session.data?.paper.title ?? slug;
                          void api.startNotesAgent(
                            pid,
                            'working',
                            `Remove the contribution of the paper “${title}” from the Project Notes. Take out claims, threads and references that exist only because of that paper, smooth the surrounding text, and keep anything other papers independently support.`,
                          ).then(
                            () => router.push('/notes/working'),
                            (e) => Alert.alert('Could not start the proposal', (e as Error).message),
                          );
                        },
                      },
                    ],
                  );
                }
              },
              (e) => Alert.alert('Could not clear chats', (e as Error).message),
            );
          },
        },
      ],
    );
  }

  function confirmDeletePaper() {
    if (!pid || !slug || !session.data?.paper) return;
    Alert.alert(
      'Delete paper from this project?',
      `“${session.data.paper.title}” will leave the reading list. Its notes and discussion history are kept for recovery.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void api.removePaper(pid, slug).then(
              () => {
                void qc.invalidateQueries({ queryKey: keys.projectState(pid) });
                // Deleting this paper changes the citation counts on every paper it cited or
                // that cited it — screens that are not this one.
                void qc.invalidateQueries({ queryKey: keys.sessionsIn(pid) });
                void qc.invalidateQueries({ queryKey: keys.recentSessions });
                router.back();
              },
              (e) => Alert.alert('Could not delete the paper', (e as Error).message),
            );
          },
        },
      ],
    );
  }

  async function createThread() {
    if (!pid || !slug || stream.streaming) return;
    try {
      const result = await api.createDiscussionThread(pid, slug);
      selectThread(result.thread.id);
      await qc.invalidateQueries({ queryKey: ['project', pid, 'session', slug] });
    } catch (e) {
      Alert.alert('Could not start a new thread', (e as Error).message ?? 'Request failed.');
    }
  }

  return (
    <LinkHandlerContext.Provider value={handleReferenceLink}>
    <ExternalRefSheet pid={pid} refItem={externalRef} onClose={() => setExternalRef(null)} />
    <Screen edges={immersiveDiscussion ? [] : ['top']}>
      {immersiveDiscussion ? (
        <DiscussionEdgeFade
          edge="top"
          height={headerHeight + 48}
          style={styles.discussionTopFade}
        />
      ) : null}
      <View
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
        pointerEvents="box-none"
        style={immersiveDiscussion
          ? [styles.discussionHeaderOverlay, { paddingTop: insets.top }]
          : undefined}>
      <TopBar
        floating={immersiveDiscussion}
        title={session.data?.paper.title ?? cachedPaper?.title ?? cachedRecent?.title ?? 'Discussion'}
        // Year first: it situates the paper on the timeline before the workflow state (U.17).
        subtitle={
          [
            session.data?.paper.year ?? cachedPaper?.year,
            (session.data?.paper.affiliations ?? cachedPaper?.affiliations)?.slice(0, 2).join(', '),
            activeThread === 'main'
              ? (state ? STATE_LABEL[state] : undefined)
              : session.data?.threads?.find((item) => item.id === activeThread)?.title,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        onBack={() => router.back()}
        right={
          <OverflowMenu
            listeningMode={listeningMode}
            onToggleListening={() => {
              if (listeningMode) audio.cancelPrep();
              setListeningMode(!listeningMode);
            }}
            hasNotes={!!session.data?.paper.has_notes}
            onViewNotes={() => slug && router.push(`/notes/${encodeURIComponent(slug)}`)}
            onRelatedWorks={() => setShowRelated(true)}
            onGraph={() => slug && router.push(`/paper-graph/${encodeURIComponent(slug)}`)}
            paperUrl={paperUrl}
            showFinishReading={
              hasSession
              && transcript.length > 0
              && state !== 'notes_drafted'
              && state !== 'committed'
            }
            finishReadingDisabled={stream.streaming}
            onFinishReading={() => void finishReadingFromMenu()}
            showUpdateNotes={hasSession && transcript.length > 0}
            updateNotesDisabled={stream.streaming}
            onUpdateNotes={() => void updateNotesFromDiscussion()}
            showContinue={state === 'committed'}
            onContinue={() => void continueFromCommitted()}
            modelLabel={
              selectedModelLabel
            }
            onPickModel={() => setModelPickerOpen(true)}
            showReadingMode={hasSession}
            readingModeLabel={READING_MODE_LABELS[readingMode]}
            onPickReadingMode={() => setModePickerOpen(true)}
            onRename={() => setRenameOpen(true)}
            onDelete={confirmDeletePaper}
            showClearChats={hasSession}
            clearChatsDisabled={stream.streaming}
            onClearChats={confirmClearChats}
            showThreads={hasSession}
            threadCount={session.data?.threads?.length ?? 0}
            onThreads={() => setThreadPickerOpen(true)}
          />
        }
      />
      </View>

      <ModelPickerSheet
        visible={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        selectedModel={selectedModel}
        defaultLabel={settings.data?.model ?? 'Default'}
        favorites={favoriteModels.data ?? []}
        onPick={setSelectedModel}
      />
      <ModePickerSheet
        visible={modePickerOpen}
        onClose={() => setModePickerOpen(false)}
        mode={readingMode}
        onPick={(m) => void switchMode(m)}
      />
      <RenamePaperSheet
        visible={renameOpen}
        pid={pid}
        slug={slug ?? null}
        title={session.data?.paper.title ?? ''}
        onClose={() => setRenameOpen(false)}
        onRenamed={(paper) => {
          setRenameOpen(false);
          if (pid && slug) {
            void applyPaperUpdateToActiveSession(qc, pid, slug, activeThread, paper);
          }
        }}
      />
      <CanonicalTitleSheet
        visible={!!suggestedTitle}
        pid={pid}
        slug={slug ?? null}
        currentTitle={session.data?.paper.title ?? ''}
        suggestedTitle={suggestedTitle ?? ''}
        onClose={() => setSuggestedTitle(null)}
        onUpdated={(paper) => {
          setSuggestedTitle(null);
          if (pid && slug) {
            void applyPaperUpdateToActiveSession(qc, pid, slug, activeThread, paper);
          }
        }}
      />
      <ThreadPickerSheet
        visible={threadPickerOpen}
        onClose={() => setThreadPickerOpen(false)}
        threads={session.data?.threads ?? []}
        selected={activeThread}
        disabled={stream.streaming}
        onPick={selectThread}
        onCreate={() => void createThread()}
      />

      <RelatedWorksSheet
        pid={pid}
        slug={slug ?? null}
        visible={showRelated}
        onClose={() => setShowRelated(false)}
        onOpenPaper={(target) => {
          setShowRelated(false);
          router.push(`/paper/${encodeURIComponent(target)}`);
        }}
      />

      {!pid ? (
        <Centered text="No active project." />
      ) : session.isLoading ? (
        showSessionSkeleton && loadingSurface
          ? loadingSurface === 'discussion'
            ? <DiscussionLoadingSkeleton state={anticipatedState} />
            : <PaperSetupLoadingSkeleton />
          : null
      ) : !hasSession ? (
        <ComposeFirst
          pid={pid}
          slug={slug!}
          title={session.data?.paper.title ?? 'This paper'}
          paper={session.data?.paper}
          stream={stream}
          chatStartPath={paths!.chatStart}
          initialSource={typeof source === 'string' && source ? source : undefined}
          autoStart={autoStart === '1'}
          sessionState={state}
          selectedModel={selectedModel}
          modelLabel={selectedModelLabel}
          onPickModel={() => setModelPickerOpen(true)}
          bootstrapStartedAt={bootstrapStartedAt}
          bootstrapHadSetupSurface={bootstrapHadSetupSurface}
          retrieved={!!session.data?.paper.retrieved}
          titleConfirmed={!!session.data?.paper.title_confirmed}
        />
      ) : (
        <DiscussionThread
          pid={pid}
          slug={slug!}
          threadId={activeThread}
          state={state}
          stream={stream}
          paths={paths!}
          transcript={transcript}
          pendingTurn={session.data?.pending_turn ?? null}
          acceptedDrafts={session.data?.accepted_drafts ?? []}
          title={session.data?.paper.title ?? 'Narration'}
          favorites={favoriteModels.data ?? []}
          selectedModel={selectedModel}
          defaultModelLabel={settings.data?.model ?? 'Project default'}
          readingMode={readingMode}
          onContinue={() => void continueFromCommitted()}
          headerHeight={headerHeight}
          reviewReadyNonce={reviewReadyNonce}
          onMutated={() => {
            // The whole project's sessions, not just this one: approving notes flips this paper
            // to `read`, which changes the "N you've read" count shown on every paper it cites.
            qc.invalidateQueries({ queryKey: keys.sessionsIn(pid) });
            qc.invalidateQueries({ queryKey: keys.projectState(pid) });
          }}
          headerOverlays={immersiveDiscussion}
        />
      )}
    </Screen>
    </LinkHandlerContext.Provider>
  );
}

const STATE_LABEL: Record<string, string> = {
  unread: 'Not started',
  retrieving: 'Fetching paper…',
  in_discussion: 'In discussion',
  notes_drafted: 'Notes drafted — review',
  committed: 'Notes committed',
};

// ---------- top bar: overflow menu + model picker ----------

// DR-068 — the readout is the percentage alone (Kamil, 2026-08-22: "Just keep the
// percentage, not size in the UI"); the resolved pt size stays out of the label.
function TextSizeStepperRow({
  scale,
  onChange,
}: {
  scale: number;
  onChange: (next: number) => void;
}) {
  const t = useTheme();
  const percent = Math.round(scale * 100);
  const atMin = scale <= MIN_TEXT_SCALE;
  const atMax = scale >= MAX_TEXT_SCALE;
  // Opus review, PR #385: each button's label now carries the CURRENT value, not just the
  // action — a screen reader focusing either button after a step announces the new percentage
  // in the same breath, rather than the reader having to swipe back to the value text to learn
  // what changed.
  return (
    <View style={stepperStyles.row}>
      <View style={[stepperStyles.badge, { backgroundColor: t.elevated }]}>
        <Text variant="heading" color={t.muted}>Aa</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="heading" numberOfLines={1}>Text size</Text>
        <Text variant="caption" color={t.muted} numberOfLines={1}>Discussion text</Text>
      </View>
      <View style={[stepperStyles.segmented, { borderColor: t.line2 }]}>
        <Pressable
          onPress={() => onChange(scale - TEXT_SCALE_STEP)}
          disabled={atMin}
          accessibilityRole="button"
          accessibilityLabel={`Decrease Discussion text size, currently ${percent} percent`}
          style={[stepperStyles.segBtn, atMin && { opacity: 0.4 }]}
        >
          <Icon name="minus" size={16} color={t.text} />
        </Pressable>
        <Text variant="caption" color={t.muted} style={stepperStyles.segValue} numberOfLines={1}>
          {`${percent}%`}
        </Text>
        <Pressable
          onPress={() => onChange(scale + TEXT_SCALE_STEP)}
          disabled={atMax}
          accessibilityRole="button"
          accessibilityLabel={`Increase Discussion text size, currently ${percent} percent`}
          style={[stepperStyles.segBtn, atMax && { opacity: 0.4 }]}
        >
          <Icon name="plus" size={16} color={t.text} />
        </Pressable>
      </View>
    </View>
  );
}

const stepperStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  // Matches OptionsSheet's own badge (38px, elevated fill) so this row's leading glyph lines
  // up with every ordinary row's icon badge rather than starting flush against the sheet edge.
  badge: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // One segmented control — minus, live value, plus — matching the mockup's "flanking" layout
  // (Kamil: "plus and minus signs besides current font size") rather than the value sitting
  // apart from the buttons as a caption.
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  segBtn: {
    width: control.minTouch,
    height: control.minTouch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segValue: { minWidth: 62, textAlign: 'center' },
});

// The single overflow trigger for every discussion-level action that isn't the composer
// itself: navigation into related works / graph / notes, then the quieter mode toggles —
// grouped per Figma `08c · Actions menu`.
export function OverflowMenu({
  listeningMode,
  onToggleListening,
  hasNotes,
  onViewNotes,
  onRelatedWorks,
  onGraph,
  paperUrl,
  showFinishReading,
  showUpdateNotes,
  updateNotesDisabled,
  onUpdateNotes,
  finishReadingDisabled,
  onFinishReading,
  showContinue,
  onContinue,
  modelLabel,
  onPickModel,
  showReadingMode,
  readingModeLabel,
  onPickReadingMode,
  onRename,
  onDelete,
  showClearChats,
  clearChatsDisabled,
  onClearChats,
  showThreads,
  threadCount,
  onThreads,
}: {
  listeningMode: boolean;
  onToggleListening: () => void;
  hasNotes: boolean;
  onViewNotes: () => void;
  onRelatedWorks: () => void;
  onGraph: () => void;
  paperUrl: string | null;
  showFinishReading: boolean;
  showUpdateNotes: boolean;
  updateNotesDisabled: boolean;
  onUpdateNotes: () => void;
  finishReadingDisabled: boolean;
  onFinishReading: () => void;
  showContinue: boolean;
  onContinue: () => void;
  modelLabel: string;
  onPickModel: () => void;
  showReadingMode: boolean;
  readingModeLabel: string;
  onPickReadingMode: () => void;
  onRename: () => void;
  onDelete: () => void;
  showClearChats: boolean;
  clearChatsDisabled: boolean;
  onClearChats: () => void;
  showThreads: boolean;
  threadCount: number;
  onThreads: () => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const { discussionTextScale, setDiscussionTextScale } = useThemeMode();

  const options: SheetOption[] = [
    {
      key: 'related',
      title: 'Related works',
      icon: 'layers',
      accent: t.mint,
      onPress: onRelatedWorks,
    },
    {
      key: 'graph',
      title: 'Reference graph',
      icon: 'share-2',
      accent: t.mint,
      onPress: onGraph,
    },
  ];
  if (paperUrl) {
    options.unshift({
      key: 'paper',
      title: 'Open full paper',
      subtitle: paperUrl.includes('arxiv.org/pdf/') ? 'PDF' : 'Source page',
      icon: 'external-link',
      accent: t.mint,
      onPress: () => void Linking.openURL(paperUrl).catch(() => undefined),
    });
  }
  if (showThreads) {
    options.push({
      key: 'threads',
      title: 'Discussion threads',
      subtitle: `${threadCount} independent ${threadCount === 1 ? 'thread' : 'threads'}`,
      icon: 'message-circle',
      accent: t.mint,
      onPress: onThreads,
    });
  }
  if (showFinishReading) {
    options.push({
      key: 'finish',
      title: 'Finish reading',
      subtitle: 'Draft notes to commit for this paper',
      icon: 'check-square',
      accent: t.mint,
      disabled: finishReadingDisabled,
      disabledHint: 'Wait for the current response to finish.',
      onPress: onFinishReading,
    });
  }
  if (showContinue) {
    options.push({
      key: 'continue',
      title: 'Continue discussion',
      subtitle: 'Reopen the composer — committed notes stay',
      icon: 'message-circle',
      accent: t.mint,
      onPress: onContinue,
    });
  }
  if (showUpdateNotes) {
    options.push({
      key: 'update-notes',
      title: 'Update Paper Notes from discussion',
      subtitle: 'Draft a proposal now — you review before anything is saved',
      icon: 'edit-3',
      accent: t.mint,
      disabled: updateNotesDisabled,
      disabledHint: 'Wait for the current response to finish.',
      onPress: onUpdateNotes,
    });
  }
  if (hasNotes) {
    options.push({ key: 'notes', title: 'Paper Notes', icon: 'file-text', accent: t.mint, onPress: onViewNotes });
  }
  // Session configuration (polish plan H.1: model + mode live here, not in the header).
  options.push({
    key: 'model',
    title: 'Model',
    subtitle: modelLabel,
    icon: 'zap',
    section: true,
    onPress: onPickModel,
  });
  if (showReadingMode) {
    options.push({
      key: 'mode',
      title: 'Reading mode',
      subtitle: readingModeLabel,
      icon: 'book-open',
      onPress: onPickReadingMode,
    });
  }
  // DR-068 — Kamil: "plus and minus signs besides current font size, and instant apply."
  // Custom compound row (OptionsSheet's `render` slot): two 48x48 targets plus a live label,
  // never closing the sheet, so trying a few steps doesn't mean reopening the menu each time.
  options.push({
    key: 'text-size',
    title: 'Text size',
    icon: 'type',
    closeOnPress: false,
    onPress: () => {},
    render: () => (
      <TextSizeStepperRow scale={discussionTextScale} onChange={setDiscussionTextScale} />
    ),
  });
  options.push({
    key: 'listening',
    title: listeningMode ? 'Turn off listening' : 'Turn on listening',
    icon: 'headphones',
    onPress: onToggleListening,
  });
  options.push(
    {
      key: 'rename',
      title: 'Rename paper',
      subtitle: 'Keep the same paper history and identity',
      icon: 'edit-3',
      section: true,
      onPress: onRename,
    },
  );
  if (showClearChats) {
    // DR-079: destructive, so it lives in the same section as Delete; the screen shows a
    // confirm before anything happens, and offers the Project Notes retraction separately.
    options.push({
      key: 'clear-chats',
      title: 'Clear all chats',
      subtitle: 'Every thread — committed notes and the paper are kept',
      icon: 'trash',
      accent: t.danger,
      disabled: clearChatsDisabled,
      disabledHint: 'Wait for the current response to finish.',
      onPress: onClearChats,
    });
  }
  options.push(
    {
      key: 'delete',
      title: 'Delete from project',
      subtitle: 'Notes and discussion history are retained',
      icon: 'trash-2',
      accent: t.danger,
      onPress: onDelete,
    },
  );

  return (
    <>
      <IconButton name="more-vertical" onPress={() => setOpen(true)} accessibilityLabel="More actions" />
      <OptionsSheet visible={open} onClose={() => setOpen(false)} options={options} />
    </>
  );
}

export function RenamePaperSheet({
  visible,
  pid,
  slug,
  title,
  onClose,
  onRenamed,
}: {
  visible: boolean;
  pid: string | null;
  slug: string | null;
  title: string;
  onClose: () => void;
  onRenamed: (paper: Paper) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setDraft(title);
      setError(null);
    }
  }, [title, visible]);

  // Echo native edits byte-for-byte. Transforming here makes a controlled RN TextInput replace
  // its value and re-anchor the selection during a mid-string edit.
  const onDraftChange = useCallback((raw: string) => setDraft(raw), []);

  async function save() {
    const next = normalizeTitleForSubmit(draft);
    if (!pid || !slug || !next || next === normalizeTitleForSubmit(title) || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Keep the TextInput state and submitted value verbatim. The backend owns title
      // normalization; echoing each onChangeText value exactly is what keeps RN's mid-string
      // selection stable on device.
      const { paper } = await api.updatePaper(pid, slug, draft);
      onRenamed(paper);
    } catch (e) {
      setError((e as Error).message ?? 'Could not rename the paper.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeightPct={70} scrollable>
      <Text variant="title">Rename paper</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: 2, marginBottom: space.md }}>
        The discussion, notes, and stable paper identity stay attached.
      </Text>
      <BottomSheetTextInput
        value={draft}
        onChangeText={onDraftChange}
        placeholder="Paper title"
        placeholderTextColor={t.muted}
        style={styles.renameInput}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={() => void save()}
      />
      {error ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: space.sm }}>
          {error}
        </Text>
      ) : null}
      <View style={styles.sheetActions}>
        <Button title="Cancel" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
        <Button
          title="Save name"
          onPress={() => void save()}
          loading={saving}
          disabled={
            !normalizeTitleForSubmit(draft)
            || normalizeTitleForSubmit(draft) === normalizeTitleForSubmit(title)
          }
          style={{ flex: 1 }}
        />
      </View>
    </BottomSheet>
  );
}

export function CanonicalTitleSheet({
  visible,
  pid,
  slug,
  currentTitle,
  suggestedTitle,
  onClose,
  onUpdated,
}: {
  visible: boolean;
  pid: string | null;
  slug: string | null;
  currentTitle: string;
  suggestedTitle: string;
  onClose: () => void;
  onUpdated: (paper: Paper) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) setError(null);
  }, [visible]);

  async function saveDecision(useSuggestedTitle: boolean) {
    if (!pid || !slug || (useSuggestedTitle && !suggestedTitle.trim()) || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { paper } = await api.updatePaper(
        pid,
        slug,
        useSuggestedTitle ? suggestedTitle : undefined,
        true,
      );
      onUpdated(paper);
    } catch (e) {
      setError((e as Error).message ?? 'Could not update the paper title.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeightPct={75} scrollable>
      <Text variant="overline" color={t.mint}>Paper found</Text>
      <Text variant="title" style={{ marginTop: space.xs }}>Use the source title?</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
        You added
      </Text>
      <Text variant="body">{currentTitle}</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
        The source reports
      </Text>
      <Text variant="serifTitle">{suggestedTitle}</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
        Updating the title keeps the same paper identity, notes, and discussion.
      </Text>
      {error ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: space.sm }}>
          {error}
        </Text>
      ) : null}
      <View style={styles.sheetActions}>
        <Button
          title="Keep mine"
          variant="ghost"
          onPress={() => void saveDecision(false)}
          disabled={saving}
          style={{ flex: 1 }}
        />
        <Button
          title="Update title"
          onPress={() => void saveDecision(true)}
          loading={saving}
          style={{ flex: 1 }}
        />
      </View>
    </BottomSheet>
  );
}

function ThreadPickerSheet({
  visible,
  onClose,
  threads,
  selected,
  disabled,
  onPick,
  onCreate,
}: {
  visible: boolean;
  onClose: () => void;
  threads: DiscussionThreadSummary[];
  selected: string;
  disabled: boolean;
  onPick: (threadId: string) => void;
  onCreate: () => void;
}) {
  const options: SheetOption[] = threads.map((thread, index) => ({
    key: thread.id,
    title: thread.title,
    subtitle: thread.message_count
      ? `${thread.message_count} message${thread.message_count === 1 ? '' : 's'}`
      : 'Ready for your first message',
    icon: index === 0 ? 'book-open' : 'message-circle',
    selected: thread.id === selected,
    disabled,
    onPress: () => onPick(thread.id),
  }));
  options.push({
    key: 'new-thread',
    title: 'Start a new thread',
    subtitle: 'Ask anything with the full paper in context',
    icon: 'plus',
    section: true,
    disabled,
    onPress: onCreate,
  });
  return (
    <OptionsSheet
      visible={visible}
      onClose={onClose}
      title="Discussion threads"
      options={options}
    />
  );
}

// The styled model picker (Figma `08b · Model + thinking picker`, minus thinking depth — the
// backend has no such parameter). One-shot override for this screen only (never persisted —
// see the `selectedModel` comment above). Opened from the kebab menu (H.1).
function ModelPickerSheet({
  visible,
  onClose,
  selectedModel,
  defaultLabel,
  favorites,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  selectedModel: string | null;
  defaultLabel: string;
  favorites: FavoriteModel[];
  onPick: (modelId: string | null) => void;
}) {
  const options: SheetOption[] = [
    {
      key: 'default',
      title: 'Project default',
      subtitle: defaultLabel,
      icon: 'check-circle',
      selected: selectedModel == null,
      onPress: () => onPick(null),
    },
    ...favorites.map((m) => ({
      key: m.id,
      title: m.label,
      subtitle: m.id,
      icon: 'zap' as IconName,
      selected: selectedModel === m.id,
      onPress: () => onPick(m.id),
    })),
  ];
  return (
    <OptionsSheet
      visible={visible}
      onClose={onClose}
      title="Model for next response"
      options={options}
    />
  );
}

// Reading-mode picker (polish plan H.3): one tap switches how the analyst pitches every
// subsequent turn — the on-the-go alternative to editing prompts.
const MODE_OPTIONS: { mode: ReadingMode; icon: IconName; subtitle: string }[] = [
  { mode: 'balanced', icon: 'circle', subtitle: 'The default register' },
  { mode: 'background', icon: 'book-open', subtitle: 'New to this area — explain the groundwork' },
  { mode: 'technical', icon: 'cpu', subtitle: 'Expert — skip basics, engage the math' },
  { mode: 'detailed', icon: 'list', subtitle: 'Thorough walkthrough, nothing skipped' },
];

function ModePickerSheet({
  visible,
  onClose,
  mode,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  mode: ReadingMode;
  onPick: (mode: ReadingMode) => void;
}) {
  return (
    <OptionsSheet
      visible={visible}
      onClose={onClose}
      title="Reading mode"
      options={MODE_OPTIONS.map((opt) => ({
        key: opt.mode,
        title: READING_MODE_LABELS[opt.mode],
        subtitle: opt.subtitle,
        icon: opt.icon,
        selected: mode === opt.mode,
        onPress: () => onPick(opt.mode),
      }))}
    />
  );
}

// ---------- the thread (library chat + lifecycle toolbar) ----------

/** Audio identity for an assistant turn — content-qualified via messageAudioId so EVERY
 *  turn on every branch (not just the fork point) is distinct when its text differs (U.14
 *  review: downstream replies inside a branch share indexes with the sibling branch too). */
function branchAudioId(
  pid: string,
  slug: string,
  entry: Extract<TranscriptEntry, { role: 'assistant' }>,
  threadId = 'main',
): string {
  const conversation = threadId === 'main' ? slug : `${slug}--${threadId}`;
  return messageAudioId(pid, conversation, entry.assistant_index, entry.canonical);
}

function discussionDraftKey(
  pid: string,
  slug: string,
  threadId: string,
  kind: string,
): string {
  // Preserve every pre-thread main draft under its original key; only additional threads add
  // a namespace component, so rollout cannot make an existing unsent reply appear lost.
  return threadId === 'main'
    ? draftKey(pid, 'discussion', slug, kind)
    : draftKey(pid, 'discussion', slug, threadId, kind);
}

function DiscussionThread({
  pid,
  slug,
  threadId,
  state,
  stream,
  paths,
  transcript,
  pendingTurn,
  acceptedDrafts,
  title,
  favorites,
  selectedModel,
  defaultModelLabel,
  readingMode,
  onContinue,
  headerHeight,
  headerOverlays,
  onMutated,
  reviewReadyNonce,
}: {
  pid: string;
  slug: string;
  threadId: string;
  state: string | null;
  stream: ReturnType<typeof useStreamingTurn>;
  paths: ReturnType<typeof turnJobPaths>;
  transcript: TranscriptEntry[];
  /** DR-083 interim: server-detected user turn whose worker vanished (see Session type). */
  pendingTurn: { kind: string; ts: string; error: string | null; stopped?: boolean } | null;
  acceptedDrafts: { kind: 'reply' | 'revision'; text: string }[];
  title: string;
  favorites: FavoriteModel[];
  selectedModel: string | null;
  defaultModelLabel: string;
  readingMode: ReadingMode;
  onContinue: () => void;
  headerHeight: number;
  /** True when the transcript is the base layer and the header floats above it. */
  headerOverlays: boolean;
  onMutated: () => void;
  /** Bumped by the parent when a turn settles with a fresh Notes proposal (D03 auto-open). */
  reviewReadyNonce: number;
}) {
  const theme = useTheme();
  const { themeName, discussionTextScale } = useThemeMode();
  const styles = useThemedStyles(makeStyles);
  const opening = useOpeningDraft(pid, slug, threadId);
  // The paper's arXiv-HTML figure manifest (R.10) — carded inline in committed responses.
  // `none`/absent = no cards, so this is purely additive; resolved at render time so a
  // manifest that lands after a turn was written still cards it on the next render.
  const figuresQuery = usePaperFigures(pid, slug);
  const figureContext = useMemo<FigureContext | undefined>(() => {
    const data = figuresQuery.data;
    if (data?.status !== 'done' || !data.figures.length) return undefined;
    return { pid, slug, figures: data.figures, version: data.fetched_ts };
  }, [figuresQuery.data, pid, slug]);
  // Keep lifecycle-specific keys: if the server advances to notes_drafted while a reply is
  // being authored elsewhere, that reply stays recoverable when the discussion is reopened
  // instead of being relabeled as request-changes feedback.
  const draftKind = state === 'notes_drafted' ? 'request-changes' : 'reply';
  const textDraft = usePersistedDraft(
    discussionDraftKey(pid, slug, threadId, draftKind),
    '',
  );
  // Message editing: which user reply is being edited + its draft. reply_index counts only
  // user turns (matching the backend, whose transcript surfaces only kind=="reply" users).
  // The edit happens in the composer (long-press a reply → Edit), prefilled with its text.
  const editDraft = usePersistedDraft<{ replyIndex: number; draft: string } | null>(
    discussionDraftKey(pid, slug, threadId, 'message-edit'),
    null,
  );
  const editing = editDraft.value;
  const setEditing = editDraft.setValue;
  const sentenceCommentsDraft = usePersistedDraft<PendingSentenceComment[]>(
    sentenceCommentsDraftKey(pid, slug, threadId),
    [],
  );
  const sentenceComments = sentenceCommentsDraft.value;
  const [annotatingAssistant, setAnnotatingAssistant] = useState<number | null>(null);
  const [selectedSentence, setSelectedSentence] = useState<SelectedSentence | null>(null);
  const [sentenceCommentText, setSentenceCommentText] = useState('');
  // The composer floats over the message list (Gemini/ChatGPT pattern): measured here so the
  // inverted list gets an equal bottom inset and content scrolls clear of the pill (R12.6).
  const [composerHeight, setComposerHeight] = useState(0);
  // Auto-open the Notes review when a proposal becomes ready (D03): Finish reading — and a
  // later Request changes — draft a fresh proposal; without this the reader was told notes were
  // written but had to hunt for "Review & commit" (or leave and reopen) to see them. The parent
  // bumps reviewReadyNonce from the turn-completion handler exactly when a settled turn carries
  // a fresh proposal — the authoritative signal (see useReviewAutoOpen).
  const [reviewOpen, setReviewOpen] = useReviewAutoOpen({
    readyNonce: reviewReadyNonce,
    editing: !!editing,
    conversationKey: threadId,
  });

  // The durable queue changes keys with the thread. Clear its ephemeral sentence picker and
  // editor at the same boundary so a selection from the previous discussion cannot linger.
  useEffect(() => {
    setAnnotatingAssistant(null);
    setSelectedSentence(null);
    setSentenceCommentText('');
  }, [threadId]);

  const disabled = stream.streaming;
  // An in-flow header consumes space above the library and belongs in its keyboard offset.
  // The immersive header is an overlay, so counting it would shrink the transcript twice.
  const insets = useSafeAreaInsets();
  const chromeLayout = discussionChromeLayout({
    topInset: insets.top,
    headerHeight,
    composerHeight,
    headerOverlays,
    listGap: space.sm,
    headerGap: space.lg,
  });
  // The library's prop is typed RefObject<TextInput> (non-null), predating React 19's
  // useRef nullability; the cast bridges that without changing runtime behavior.
  const inputRef = useRef<TextInput>(null) as RefObject<TextInput>;
  // DR-089 — is the reader away from the live edge? While they are, the streamed reveal
  // pauses (RevealPausedContext → SmoothMarkdown), so the transcript cannot drag under them.
  const readerPin = useReaderAwayFromLive();

  // Reconcile authored text against what the server accepted: once the submitted edit shows
  // up in the transcript, drop the local draft.
  useEffect(() => {
    if (!editDraft.submitted || !editing) return;
    const replies = transcript.filter((entry) => entry.role === 'user');
    const accepted = replies[editing.replyIndex];
    if (accepted?.role === 'user' && accepted.text === editing.draft.trim()) {
      void editDraft.clear(null);
    }
  }, [editDraft.clear, editDraft.submitted, editing, transcript]);

  useEffect(() => {
    if (!textDraft.submitted || !textDraft.value.trim()) return;
    const baseline = textDraft.acceptedBaseline ?? acceptedDrafts.length;
    const expectedKind = draftKind === 'reply' ? 'reply' : 'revision';
    if (acceptedDrafts.slice(baseline).some(
      (draft) => draft.kind === expectedKind && draft.text === textDraft.value.trim(),
    )) {
      void textDraft.clear('');
    }
  }, [acceptedDrafts, draftKind, textDraft.acceptedBaseline, textDraft.clear, textDraft.submitted, textDraft.value]);

  // If the start POST reached the server but its response was lost, onAccepted could not clear
  // the queue. The composed user turn is deterministic, so the transcript itself is the
  // authoritative recovery signal after useStreamingTurn's defensive refetch.
  useEffect(() => {
    if (!sentenceCommentsDraft.submitted || sentenceComments.length === 0) return;
    const expected = composeSentenceReply(sentenceComments, textDraft.value);
    if (transcript.some((entry) => entry.role === 'user' && entry.text === expected)) {
      void sentenceCommentsDraft.clear([]);
      setAnnotatingAssistant(null);
      setSelectedSentence(null);
      setSentenceCommentText('');
    }
  }, [
    sentenceComments,
    sentenceCommentsDraft.clear,
    sentenceCommentsDraft.submitted,
    textDraft.value,
    transcript,
  ]);

  // U.14: the moment a retry starts, the reader must see the conversation reset to the last
  // user message — not the old response lingering until the refetch. The old tail is hidden
  // client-side while the cached transcript still carries the exact entry that was forked
  // away; once the refetched transcript differs at that index (new response, or nothing after
  // a failure), hiding stops by itself. No timers, no cleanup races.
  const [retryHide, setRetryHide] = useState<{
    index: number;
    canonical: string;
    branchActive: number | null;
  } | null>(null);
  useEffect(() => setRetryHide(null), [slug]);
  // A retry that never reached the server (offline, 409) leaves the cached transcript
  // untouched — the content key below would hide the tail forever. The stream error is the
  // settle signal for that case.
  useEffect(() => {
    if (stream.error) setRetryHide(null);
  }, [stream.error]);
  // One-shot latch: the first refetch that no longer matches the forked-away entry clears the
  // marker for good — otherwise switching BACK to that branch later would re-match it and
  // hide a perfectly valid tail with no retry running.
  useEffect(() => {
    if (!retryHide) return;
    const entry = transcript.find(
      (e) => e.role === 'assistant' && e.assistant_index === retryHide.index,
    );
    const stillForkedAway = entry &&
      entry.role === 'assistant' &&
      entry.canonical === retryHide.canonical &&
      (entry.branch_active ?? null) === retryHide.branchActive;
    if (!stillForkedAway) setRetryHide(null);
  }, [retryHide, transcript]);
  const queryClient = useQueryClient();
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const handleSwitchBranch = useCallback(async (assistantIndex: number, branch: number) => {
    if (switchingBranch || stream.streaming) return;
    setSwitchingBranch(true);
    setRetryHide(null);  // switching is explicit navigation; never hide what it restores
    try {
      await api.switchBranch(pid, slug, assistantIndex, branch, threadId);
      await queryClient.invalidateQueries({ queryKey: keys.session(pid, slug, threadId) });
      await queryClient.invalidateQueries({ queryKey: keys.opening(pid, slug, threadId) });
      // A switch can flip session_state (in_discussion <-> notes_drafted); library rows and
      // paper actions read it from project state.
      await queryClient.invalidateQueries({ queryKey: keys.projectState(pid) });
    } catch (e) {
      Alert.alert('Could not switch branch', (e as Error).message ?? 'Request failed.');
    } finally {
      setSwitchingBranch(false);
    }
  }, [pid, queryClient, slug, stream.streaming, switchingBranch, threadId]);

  const hideFromIndex = useMemo(() => {
    if (!retryHide) return null;
    const entry = transcript.find(
      (e) => e.role === 'assistant' && e.assistant_index === retryHide.index,
    );
    // Hide only while the cached entry is EXACTLY the one forked away — same text AND same
    // branch ordinal. A regeneration that returns identical text still bumps branch_active,
    // so hiding always clears on the post-generation refetch.
    return entry &&
      entry.role === 'assistant' &&
      entry.canonical === retryHide.canonical &&
      (entry.branch_active ?? null) === retryHide.branchActive
      ? retryHide.index
      : null;
  }, [retryHide, transcript]);
  const editTranscriptIndex = useMemo(() => {
    if (!editing) return null;
    let replyIndex = -1;
    const cut = transcript.findIndex((entry) => {
      if (entry.role !== 'user') return false;
      replyIndex += 1;
      return replyIndex === editing.replyIndex;
    });
    return cut >= 0 ? cut : null;
  }, [editing, transcript]);
  const messages = useMemo(
    () => toDiscussionMessages(
      transcript,
      stream.pendingUser,
      stream.streaming ? stream.items : null,
      hideFromIndex,
      editTranscriptIndex,
    ),
    [
      transcript,
      stream.pendingUser,
      stream.streaming,
      stream.items,
      hideFromIndex,
      editTranscriptIndex,
    ],
  );

  // One composer, two persisted drafts: the in-place edit (when active) wins, otherwise the
  // lifecycle draft (reply / request-changes). Both persist until server acceptance.
  const inputText = editing ? editing.draft : textDraft.value;
  const openSentence = useCallback((assistantIndex: number, quote: string) => {
    const next = { assistantIndex, quote };
    if (selectedSentence && sameSentence(selectedSentence, next)) {
      setSelectedSentence(null);
      setSentenceCommentText('');
      return;
    }
    const existing = sentenceComments.find((comment) => sameSentence(comment, next));
    setAnnotatingAssistant(assistantIndex);
    setSelectedSentence(next);
    setSentenceCommentText(existing?.comment ?? '');
  }, [selectedSentence, sentenceComments]);

  const openQueuedComment = useCallback((comment: PendingSentenceComment) => {
    setAnnotatingAssistant(comment.assistantIndex);
    setSelectedSentence({ assistantIndex: comment.assistantIndex, quote: comment.quote });
    setSentenceCommentText(comment.comment);
  }, []);

  const saveSentenceComment = useCallback(() => {
    const comment = sentenceCommentText.trim();
    if (!selectedSentence || !comment) return;
    sentenceCommentsDraft.setValue((current) => upsertSentenceComment(current, {
      ...selectedSentence,
      comment,
    }));
    setSelectedSentence(null);
    setSentenceCommentText('');
  }, [selectedSentence, sentenceCommentText, sentenceCommentsDraft.setValue]);

  const removeQueuedComment = useCallback((comment: PendingSentenceComment) => {
    sentenceCommentsDraft.setValue((current) => removeSentenceComment(current, comment));
    if (selectedSentence && sameSentence(selectedSentence, comment)) {
      setSelectedSentence(null);
      setSentenceCommentText('');
    }
  }, [selectedSentence, sentenceCommentsDraft.setValue]);

  const sentenceAnnotationsFor = useCallback((
    assistantIndex: number,
  ): SentenceAnnotations | undefined => {
    const messageComments = sentenceComments.filter(
      (comment) => comment.assistantIndex === assistantIndex,
    );
    if (annotatingAssistant !== assistantIndex && messageComments.length === 0) return undefined;
    return {
      active: true,
      onSentencePress: (quote) => openSentence(assistantIndex, quote),
      stateForSentence: (quote) => {
        const sentence = { assistantIndex, quote };
        const count = messageComments.filter(
          (comment) => sameSentence(comment, sentence),
        ).length;
        return {
          selected: !!selectedSentence && sameSentence(selectedSentence, sentence),
          annotated: count > 0,
          commentCount: count,
        };
      },
    };
  }, [annotatingAssistant, openSentence, selectedSentence, sentenceComments]);

  // The library fires onChangeText('') once from its initial-layout input reset (and our
  // controlled `text` prop immediately overrides its internal state). Writing that '' into
  // the persisted draft would clobber the stored value mid-load — the exact draft-loss
  // roadmap 3.2 exists to prevent — so the first empty callback is swallowed.
  const sawFirstChangeRef = useRef(false);
  const onChangeText = useCallback((t: string) => {
    if (!sawFirstChangeRef.current) {
      sawFirstChangeRef.current = true;
      if (t === '') return;
    }
    if (editing) setEditing((e) => (e ? { ...e, draft: t } : e));
    else textDraft.setValue(t);
  }, [editing, setEditing, textDraft.setValue]);

  function startEdit(replyIndex: number, currentText: string, transcriptPos: number) {
    const begin = () => {
      setEditing({ replyIndex, draft: currentText });
      setTimeout(() => inputRef.current?.focus(), 50);
    };
    // Editing regenerates from this point, discarding later turns (no branch is kept). The
    // immediate answer is always redone; warn only when more work than that would be lost.
    if (transcript.length > transcriptPos + 2) {
      Alert.alert(
        'Edit and regenerate?',
        'This replaces your message and removes the responses after it.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Edit', style: 'destructive', onPress: begin },
        ],
      );
    } else {
      begin();
    }
  }

  async function submitEdit() {
    if (!editing) return;
    const text = editing.draft.trim();
    if (!text) return;
    const replyIndex = editing.replyIndex;
    const currentReply = transcript.filter((entry) => entry.role === 'user')[replyIndex];
    if (currentReply?.role === 'user' && currentReply.text === text) {
      await editDraft.clear(null);
      return;
    }
    await editDraft.markSubmitted();
    await stream.run(
      paths.edit,
      { slug, reply_index: replyIndex, text, model: selectedModel ?? undefined },
      text,
    );
  }

  async function send() {
    const t = textDraft.value.trim();
    if (!t && sentenceComments.length === 0) return;
    if (t) await textDraft.markSubmitted(acceptedDrafts.length);
    if (sentenceComments.length) await sentenceCommentsDraft.markSubmitted();
    const rendered = composeSentenceReply(sentenceComments, t);
    await stream.run(
      paths.reply,
      {
        slug,
        text: t,
        comments: sentenceCommentPayload(sentenceComments),
        model: selectedModel ?? undefined,
      },
      rendered,
      async () => {
        await textDraft.clear('');
        await sentenceCommentsDraft.clear([]);
        setAnnotatingAssistant(null);
        setSelectedSentence(null);
        setSentenceCommentText('');
      },
    );
  }

  async function requestChanges(feedback: string) {
    const t = feedback.trim();
    if (!t) return;
    await stream.run(
      paths.requestChanges,
      { slug, text: t, model: selectedModel ?? undefined },
    );
  }

  // Regenerate an assistant turn (optionally with a different model), from its per-message
  // overflow menu. Uses the already-implemented retry_job/RetryReq — this is its first mobile
  // caller. No optimistic user bubble: nothing new is "said" by the user for a retry.
  const canRetry = state !== 'committed';
  const [firstRetryOpen, setFirstRetryOpen] = useState(false);
  const handleRetry = useCallback((
    assistantIndex: number,
    config: { model?: string; prompt?: string; mode?: ReadingMode } = {},
  ) => {
    if (state === 'committed') return;
    const old = transcript.find(
      (e) => e.role === 'assistant' && e.assistant_index === assistantIndex,
    );
    if (old && old.role === 'assistant') {
      setRetryHide({
        index: assistantIndex,
        canonical: old.canonical,
        branchActive: old.branch_active ?? null,
      });
    }
    void stream.run(paths.retry, {
      slug,
      assistant_index: assistantIndex,
      ...config,
    }).finally(() => {
      void queryClient.invalidateQueries({ queryKey: keys.opening(pid, slug, threadId) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.retry, pid, queryClient, slug, state, stream.run, threadId, transcript]);

  const handleFirstRetry = useCallback((config: PaperSummaryRetryConfig) => {
    setFirstRetryOpen(false);
    handleRetry(0, config);
  }, [handleRetry]);

  const handleSend = useCallback(() => {
    if (editing) void submitEdit();
    else void send();
    // The handlers close over draft state; deps list the state they read. stream.run is a
    // dep because it captures the delivery mode — omitting it would send with a stale mode
    // after toggling Listening. selectedModel is a dep for the same reason — omitting it sent
    // a stale (or no) model override whenever the pill was picked after the last keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, state, textDraft.value, transcript, acceptedDrafts.length, stream.run, selectedModel, sentenceComments]);

  // DR-081 — fold ONE response's insight into the PROJECT Notes, on demand. A conservative
  // separate-editor pass server-side; the Project Notes screen resumes the job and hosts the
  // review, so approval stays where every notes proposal lives (invariant 4).
  const foldRouter = useRouter();
  const foldToProjectNotes = useCallback(async (assistantIndex: number) => {
    if (!pid || !slug) return;
    try {
      await api.startProjectNotesFold(pid, slug, assistantIndex, threadId);
      showToast('Drafting a Project Notes update from this response…');
      foldRouter.push('/notes/working');
    } catch (e) {
      if (presentSpendRefusal(e, {
        operation: 'other',
        retry: () => void foldToProjectNotes(assistantIndex),
      })) return;
      showToast((e as Error).message ?? 'Could not start the Project Notes update.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, slug, threadId]);

  // Long-press a message for its actions (copy everywhere; edit on user replies; the full
  // under-response row — Listen, Retry, Retry-with-model — on assistant responses, U.12: the
  // menu is a shortcut to the same actions, not a different set). Rendered through the app's
  // own OptionsSheet — the native action sheet ignores the design language (polish plan F.5:
  // OptionsSheet is the only menu idiom anywhere in the app).
  const audio = useAudio();
  const [msgMenu, setMsgMenu] = useState<SheetOption[] | null>(null);
  // The transcript index, so the report carries a pointer an operator can resolve to the exact
  // turn. Null means the sheet is closed.
  const [reporting, setReporting] = useState<string | null>(null);
  const onLongPressMessage = useCallback((_context: unknown, message: DiscussionMessage) => {
    const entry = message.entry;
    if (!entry) return;
    const copyText = entry.role === 'user' ? entry.text : entry.canonical;
    // No editing once committed: that state's toolbar has no composer, so an edit could
    // neither be typed nor cancelled (reopen the discussion instead).
    const canEdit =
      entry.role === 'user' &&
      state !== 'committed' &&
      !stream.streaming &&
      !editing &&
      message.replyIndex != null;
    const options: SheetOption[] = [
      {
        key: 'copy',
        title: 'Copy',
        icon: 'copy',
        onPress: () => void Clipboard.setStringAsync(copyText),
      },
    ];
    if (canEdit) {
      options.push({
        key: 'edit',
        title: 'Edit & regenerate',
        subtitle: 'Replaces the responses after this message',
        icon: 'edit-3',
        onPress: () => startEdit(message.replyIndex!, entry.text, message.transcriptIndex!),
      });
    }
    if (entry.role === 'assistant') {
      const audioId = branchAudioId(pid, slug, entry, threadId);
      if (state === 'in_discussion' && !stream.streaming && !editing) {
        options.push({
          key: 'comment',
          title: 'Comment on this',
          subtitle: 'Select a sentence to attach to your next reply',
          icon: 'message-square',
          onPress: () => {
            setAnnotatingAssistant(entry.assistant_index);
            setSelectedSentence(null);
            setSentenceCommentText('');
          },
        });
      }
      options.push({
        key: 'listen',
        title: audio.currentId === audioId ? 'Pause / resume' : 'Listen',
        icon: 'headphones',
        onPress: () => void audio.playText({ id: audioId, title, text: entry.canonical }),
      });
      // Required by Google Play's AI-Generated Content policy for every surface that shows model
      // output, and every assistant turn is model output. On the long-press menu because that is
      // where per-message actions live; a reader who has just read something objectionable should
      // not have to go looking for Settings.
      options.push({
        key: 'report',
        title: 'Report this response',
        subtitle: 'Flag offensive or harmful content',
        icon: 'flag',
        section: true,
        // The THREAD is part of the identity. Discussions are per-thread — `sessions/<slug>.threads/`
        // server-side, and a per-thread query key here — so `transcript:12` on `main` and on `t2`
        // are different turns that would otherwise produce byte-identical reports. An operator
        // resolving one against the wrong thread finds an innocuous turn and dismisses a real
        // report.
        //
        // The index is still the most volatile identifier available: a retry archives the old tail
        // and puts a new response at the same index, and an edit rewinds and regenerates it. Since
        // the backend deliberately stores no copy of the text, nothing can detect that rot. Living
        // with it for now because the alternative is storing content; M7's review queue is where a
        // sturdier handle should be designed, if the queue shows it is needed.
        onPress: () => setReporting(reportReference(threadId, message.transcriptIndex)),
      });
      if (!stream.streaming && canRetry) {
        if (entry.assistant_index === 0) {
          options.push({
            key: 'retry-first',
            title: 'Retry paper summary',
            subtitle: 'Choose prompt type and model',
            icon: 'rotate-ccw',
            section: true,
            onPress: () => setFirstRetryOpen(true),
          });
        } else {
          options.push({
            key: 'retry',
            title: 'Retry',
            subtitle: 'Regenerate with the current model',
            icon: 'rotate-ccw',
            section: true,
            onPress: () => handleRetry(entry.assistant_index),
          });
          for (const m of favorites) {
            options.push({
              key: `retry-${m.id}`,
              title: `Retry with ${m.label}`,
              icon: 'zap',
              onPress: () => handleRetry(entry.assistant_index, { model: m.id }),
            });
          }
        }
      }
    }
    setMsgMenu(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, state, stream.streaming, transcript, audio.currentId, audio.playText, favorites, handleRetry, pid, slug, threadId, title]);

  // A persisted edit can outlive its window (e.g. the notes were committed from another
  // device while an edit draft sat here). Committed state has no composer to show or cancel
  // it, so drop it rather than stranding an invisible editing mode.
  useEffect(() => {
    if (state === 'committed' && editing) void editDraft.clear(null);
  }, [editDraft.clear, editing, state]);
  useEffect(() => {
    if (state !== 'committed' || sentenceComments.length === 0) return;
    // A commit from another device removes this screen's composer. Pending sentence comments
    // are a reply overlay, not durable annotations, so do not strand invisible marks here.
    void sentenceCommentsDraft.clear([]);
    setAnnotatingAssistant(null);
    setSelectedSentence(null);
    setSentenceCommentText('');
  }, [sentenceComments.length, sentenceCommentsDraft.clear, state]);

  const renderMessageText = useCallback((props: MessageTextProps<DiscussionMessage>) => {
    const msg = props.currentMessage;
    if (msg?.streamItems) {
      return (
        <StreamingTurnBody
          items={msg.streamItems}
          activity={stream.activity}
          finishPhase={stream.proposalTurn ? stream.notesPhase ?? 'drafting' : null}
        />
      );
    }
    if (msg?.entry?.role === 'assistant') {
      return (
        <AssistantBody
          entry={msg.entry}
          isSummary={isPaperSummaryTurn(msg.entry, threadId, slug)}
          audioId={branchAudioId(pid, slug, msg.entry, threadId)}
          slug={slug}
          title={title}
          favorites={favorites}
          onRetry={handleRetry}
          onConfigureFirstRetry={() => setFirstRetryOpen(true)}
          canRetry={canRetry}
          onFoldToProjectNotes={foldToProjectNotes}
          onSwitchBranch={handleSwitchBranch}
          switchDisabled={switchingBranch || stream.streaming}
          figureContext={figureContext}
          sentenceAnnotations={sentenceAnnotationsFor(msg.entry.assistant_index)}
        />
      );
    }
    // DR-009 (Kamil, 2026-08-20): the reader's own sent bubble renders as Markdown, so a
    // sentence-comment reply — blockquoted passages plus the preamble — reads as quoted
    // passages instead of literal '>' markup. This replaces the chat library's plain-text
    // MessageText for user messages entirely (which also retires the margin-zeroing dance its
    // built-in container needed); the DR-068 text-size multiplier now reaches user text
    // through Markdown's own textScale, same as the assistant side.
    return (
      <View style={styles.userBody}>
        <Markdown text={msg?.text ?? ''} textScale={discussionTextScale} />
      </View>
    );
  }, [pid, slug, threadId, title, favorites, handleRetry, canRetry, foldToProjectNotes, handleSwitchBranch, switchingBranch, stream.streaming, stream.activity, stream.notesPhase, stream.proposalTurn, styles, figureContext, sentenceAnnotationsFor, discussionTextScale]);

  const renderBubble = useCallback((props: BubbleProps<DiscussionMessage>) => (
    <Bubble
      {...props}
      wrapperStyle={{
        left: isPaperSummaryTurn(props.currentMessage?.entry, threadId, slug)
          ? styles.summaryBubble
          : styles.analystBubble,
        right: styles.userBubble,
      }}
    />
  ), [styles, threadId, slug]);

  const renderSend = useCallback(() => {
    // While a response is generating, the send slot becomes Stop (polish plan F.1): the
    // server records whatever streamed so far marked as stopped, and the turn settles early.
    // Checked BEFORE the notes_drafted null return so a running request-changes turn can be
    // stopped too — that state hides the send button, not the ability to stop.
    if (stream.streaming) {
      return (
        <Pressable
          onPress={() => void stream.stop()}
          style={styles.sendBtn}
          accessibilityLabel="Stop generating">
          <Icon name="square" size={15} color={theme.mintInk} />
        </Pressable>
      );
    }
    if (state === 'notes_drafted' && !editing) return null;
    const canSend = (!!inputText.trim() || sentenceComments.length > 0) && !disabled;
    return (
      <Pressable
        onPress={handleSend}
        disabled={!canSend}
        style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
        accessibilityLabel={editing ? 'Save edit and regenerate' : 'Send'}>
        <Icon
          name={editing ? 'rotate-cw' : 'arrow-up'}
          size={18}
          color={canSend ? theme.mintInk : theme.muted}
        />
      </Pressable>
    );
  }, [disabled, editing, handleSend, inputText, sentenceComments.length, state, stream.streaming, stream.stop, styles, theme]);

  const renderAccessory = useCallback(() => {
    if (editing) {
      return (
        <View style={styles.accessoryRow}>
          <Text variant="caption" style={{ flex: 1 }}>
            Editing your message — later responses will be regenerated.
          </Text>
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => void editDraft.clear(null)}
          />
        </View>
      );
    }
    // "Finish reading" lives in the kebab menu only (polish plan H.1) — no composer chip.
    return null;
  }, [editing, styles, editDraft.clear]);

  const renderInputToolbar = useCallback((props: InputToolbarProps<DiscussionMessage>) => {
    if (state === 'committed') {
      // Committed is a resting point, not a dead end (polish plan H.2): the quiet inline
      // affordance reopens the composer; the same action lives in the kebab menu.
      return (
        <View
          style={styles.composerOverlay}
          onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}>
          <DiscussionEdgeFade
            edge="bottom"
            height={chromeLayout.bottomFadeHeight}
            transparentInset={chromeLayout.bottomFadeTransparentInset}
          />
          <View style={[styles.composerForeground, { paddingBottom: insets.bottom + space.sm }]}>
            <View style={styles.committedBar}>
              <Text variant="caption" style={{ textAlign: 'center' }}>
                Notes committed to this project's record.
              </Text>
              <Button
                title="Continue discussion"
                variant="ghost"
                onPress={onContinue}
                style={{ alignSelf: 'center', marginTop: space.xs }}
              />
            </View>
          </View>
        </View>
      );
    }
    if (state === 'notes_drafted') {
      return (
        <View
          style={styles.composerOverlay}
          onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}>
          <DiscussionEdgeFade
            edge="bottom"
            height={chromeLayout.bottomFadeHeight}
            transparentInset={chromeLayout.bottomFadeTransparentInset}
          />
          <View style={[styles.composerForeground, { paddingBottom: insets.bottom + space.sm }]}>
            <View style={styles.committedBar}>
              <Button
                title="Review notes"
                onPress={() => setReviewOpen(true)}
                disabled={stream.streaming}
                style={{ alignSelf: 'center' }}
              />
            </View>
          </View>
        </View>
      );
    }
    // R9.3 — one full-width rounded card (the `primary` row) with the send button INSIDE it,
    // floating on the plain chat background: the container is transparent with side margins (so
    // no full-width strip/separator shows), and the elevated rounded surface + border live on
    // the primary row that already holds [composer | send].
    return (
      <View
        style={styles.composerOverlay}
        onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}>
        <DiscussionEdgeFade
          edge="bottom"
          height={chromeLayout.bottomFadeHeight}
          transparentInset={chromeLayout.bottomFadeTransparentInset}
        />
        <View style={styles.composerForeground}>
          <SentenceCommentComposer
            active={annotatingAssistant !== null}
            comments={sentenceComments}
            selected={selectedSentence}
            draft={sentenceCommentText}
            onChangeDraft={setSentenceCommentText}
            onSave={saveSentenceComment}
            onCancelSelection={() => {
              setSelectedSentence(null);
              setSentenceCommentText('');
            }}
            onOpen={openQueuedComment}
            onRemove={removeQueuedComment}
            onDone={() => {
              setAnnotatingAssistant(null);
              setSelectedSentence(null);
              setSentenceCommentText('');
            }}
          />
          <InputToolbar
            {...props}
            containerStyle={[styles.toolbar, discussionComposerPadding(insets.bottom)]}
            primaryStyle={styles.composerCard}
            renderComposer={(composerProps) => <GrowingComposer {...composerProps} />}
            renderSend={renderSend}
            renderAccessory={renderAccessory}
          />
        </View>
      </View>
    );
  }, [
    onContinue,
    annotatingAssistant,
    openQueuedComment,
    removeQueuedComment,
    renderAccessory,
    renderSend,
    saveSentenceComment,
    selectedSentence,
    sentenceCommentText,
    sentenceComments,
    state,
    stream.streaming,
    styles,
    composerHeight,
    chromeLayout.bottomFadeHeight,
    chromeLayout.bottomFadeTransparentInset,
    insets.bottom,
  ]);

  // DR-083 interim: retry a turn whose worker vanished — continue_job re-runs the recorded
  // user turn (the finish/reply record is already durable) without recording anything new.
  const retryInterrupted = useCallback(() => {
    void stream.run(paths.continue, { slug, model: selectedModel ?? undefined });
  }, [paths.continue, selectedModel, slug, stream]);

  const renderChatFooter = useCallback(() => {
    // The chat footer renders below the message list at the physical bottom, where the composer
    // now floats absolutely (R12.6). Lift it above the composer by its measured height so the
    // terminal error or quiet reconnect status isn't hidden behind the pill.
    if (stream.error) return (
      <Card style={[styles.errorCard, { marginBottom: composerHeight + space.md }]}>
        <Text variant="body" color={theme.danger}>{stream.error}</Text>
        <Button title="Dismiss" variant="ghost" onPress={stream.clearError} style={{ marginTop: space.sm }} />
      </Card>
    );
    if (stream.connectionNotice) return (
      <ConnectionNotice
        message={stream.connectionNotice!}
        style={[styles.connectionNotice, { marginBottom: composerHeight + space.md }]}
      />
    );
    // DR-083 interim: the server found a recorded user turn with no response and no live job
    // (a restart or a dead worker) — the reader used to return to a silent screen with no
    // trace. Streaming/reattach suppresses it; a successful retry refetches the session and
    // the marker disappears with it.
    if (pendingTurn && !stream.streaming) {
      const finish = pendingTurn.kind === 'finish';
      // Honest cause attribution (PR #404 review): a cooperative Stop that recorded nothing
      // was the READER's action — never blame the server for it.
      const copy = pendingTurn.stopped
        ? (finish
            ? 'You stopped this Finish before it produced anything.'
            : 'You stopped this turn before it produced a response.')
        : (finish
            ? 'Finishing this paper was interrupted before anything could be saved — the server may have restarted mid-turn.'
            : 'Your last turn never got its response — the server may have restarted mid-turn.');
      return (
        <Card style={[styles.errorCard, { marginBottom: composerHeight + space.md }]}>
          <Text variant="body" color={pendingTurn.stopped ? theme.text : theme.danger}>
            {copy}
          </Text>
          {pendingTurn.error ? (
            <Text variant="caption" color={theme.muted} style={{ marginTop: space.xs }}>
              {pendingTurn.error}
            </Text>
          ) : null}
          <Button
            title={finish ? 'Run Finish again' : 'Retry'}
            onPress={retryInterrupted}
            style={{ marginTop: space.sm }}
          />
        </Card>
      );
    }
    return null;
  }, [pendingTurn, retryInterrupted, stream.clearError, stream.connectionNotice, stream.error,
      stream.streaming, styles, theme, composerHeight]);

  const placeholder = editing
    ? 'Edit your message…'
    : transcript.length === 0
        ? 'Start with any question about this paper…'
        : 'Reply';

  return (
    <>
    {/* DR-089 — while the reader is away from the live edge during a streaming turn, the
        streamed reveal (SmoothMarkdown) holds still so the transcript cannot drag under
        them. Streaming gates the flag so an idle reader browsing history pays nothing. */}
    <RevealPausedContext.Provider value={readerPin.away && stream.streaming}>
    <Chat<DiscussionMessage>
      messages={messages}
      user={DISCUSSION_USER}
      text={inputText}
      textInputRef={inputRef}
      textInputProps={{
        onChangeText,
        editable: !disabled,
        multiline: true,
        placeholder,
        placeholderTextColor: theme.muted,
        style: styles.composerInput,
      }}
      colorScheme={themeName === 'light' ? 'light' : 'dark'}
      disableKeyboardProvider
      keyboardAvoidingViewProps={{ keyboardVerticalOffset: chromeLayout.keyboardVerticalOffset }}
      isScrollToBottomEnabled
      // The library's default is a bare "V" text glyph on a white circle — restyle it into
      // the app's circular icon-button idiom.
      scrollToBottomComponent={() => <Icon name="chevron-down" size={18} color={theme.mint} />}
      scrollToBottomContentStyle={styles.scrollToBottomBtn}
      // The button is positioned absolutely against the list's bottom (library default 30px up).
      // The composer now floats there (R12.6), so lift the button above the measured composer so
      // it isn't hidden behind the pill.
      scrollToBottomStyle={{ bottom: chromeLayout.scrollButtonBottom }}
      isDayAnimationEnabled={false}
      renderDay={() => null}
      renderTime={() => null}
      renderAvatar={null}
      renderBubble={renderBubble}
      renderMessageText={renderMessageText}
      onLongPressMessage={onLongPressMessage}
      renderInputToolbar={renderInputToolbar}
      renderChatFooter={renderChatFooter}
      messagesContainerStyle={styles.messagesContainer}
      listProps={{
        keyboardShouldPersistTaps: 'handled',
        // DR-089 — track whether the reader is away from the live edge; while away, the
        // streamed reveal pauses (see useStreamPinnedScroll for why every viewport-side
        // correction lost to this list). The library forwards onScroll on the JS thread
        // in reanimated's event shape.
        onScroll: readerPin.onScroll,
        // The composer floats over the list, so pad the inverted list's visual bottom by the
        // composer's measured height — the newest message scrolls up clear of the pill instead
        // of sitting permanently under it (R12.6). Inverted list ⇒ paddingTop is visual-bottom.
        contentContainerStyle: chromeLayout.listContentPadding,
        // The inverted list has no explicit auto-scroll effect (see the library's own
        // MessagesContainer source) — it relies on staying at scroll offset 0 while the
        // streaming message (index 0) grows. Without this, RN's default FlatList still
        // corrects the viewport toward offset 0 as that off-screen content resizes, which
        // drags a reader back to the bottom mid-scroll. `autoscrollToTopThreshold` keeps
        // following only while already within that many px of the latest message; scrolling
        // further away holds position until the user scrolls back or taps scroll-to-bottom.
        // Matches the library's own scrollToBottomOffset default (200) so the two thresholds
        // agree: the scroll-to-bottom button and "still following" flip at the same point.
        maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: 200 },
        // The inverted list paints a second, motionless scrollbar thumb pinned at the top
        // (the RN "stuck scroll indicator" ghost, drawn alongside the real moving one —
        // R7.3). A non-zero indicator inset forces the native side to lay the indicator out
        // fresh, which suppresses the ghost; 1px is visually indistinguishable from 0.
        scrollIndicatorInsets: { right: 1 },
      }}
      {...ROW_STYLES_PROP}
    />
    </RevealPausedContext.Provider>
    <OptionsSheet
      visible={!!msgMenu}
      onClose={() => setMsgMenu(null)}
      options={msgMenu ?? []}
    />
    <ReportContentSheet
      visible={reporting !== null}
      onClose={() => setReporting(null)}
      surface="discussion"
      projectId={pid}
      paperSlug={slug}
      reference={reporting}
    />
    <PaperSummaryRetrySheet
      visible={firstRetryOpen}
      onClose={() => setFirstRetryOpen(false)}
      currentPrompt={opening.data?.prompt}
      templates={opening.data?.templates}
      currentMode={readingMode}
      selectedModel={selectedModel}
      defaultModelLabel={defaultModelLabel}
      favorites={favorites}
      onRetry={handleFirstRetry}
    />
    <NotesReviewSheet
      visible={reviewOpen}
      pid={pid}
      slug={slug}
      threadId={threadId}
      onClose={() => setReviewOpen(false)}
      onCommitted={() => { setReviewOpen(false); onMutated(); }}
      onRequestEdits={requestChanges}
      requesting={stream.streaming}
      requestPhase={stream.notesPhase}
      requestActivity={stream.activity}
      requestItems={stream.items}
      refreshNonce={reviewReadyNonce}
    />
    </>
  );
}

// ---------- compose-first ----------

// Interpret a pasted source string: an arXiv link or bare id resolves by id (an /abs/ page
// isn't a PDF, so never fetch it as one); any other URL is treated as a direct PDF link.
export function parseSource(s: string): { arxiv_id?: string; pdf_url?: string } {
  // abs, pdf AND html: an /html/ link sent as a raw pdf_url made the server parse the HTML
  // page as a PDF (DR-087). The server now canonicalizes too; this keeps the id visible
  // client-side. Version suffixes tolerated, id kept versionless as before. Old-style
  // (pre-2007) archive ids like cond-mat/0703185 are matched too.
  const arxiv = s.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (arxiv) return { arxiv_id: arxiv[1] };
  const oldStyle = s.match(/arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?/i);
  if (oldStyle) return { arxiv_id: oldStyle[1] };
  if (/^https?:\/\//i.test(s)) return { pdf_url: s };
  return { arxiv_id: s };
}

const RETRIEVAL_POLL_MS = 1500;
const RETRIEVAL_WAIT_MS = 25 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const normalizeTitleForSubmit = (value: string) => value.replace(/\s+/g, ' ').trim();
const comparableTitle = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function shouldSuggestCanonicalTitle(
  paper: Pick<Paper, 'title' | 'title_confirmed'> | null,
  found: string | null | undefined,
): found is string {
  return !!paper
    && !paper.title_confirmed
    && !!found
    && comparableTitle(found) !== comparableTitle(paper.title);
}

export function ComposeFirst({
  pid,
  slug,
  title,
  paper,
  stream,
  chatStartPath,
  initialSource,
  autoStart = false,
  sessionState,
  selectedModel,
  retrieved,
  titleConfirmed = false,
  modelLabel = 'Project default',
  onPickModel = () => undefined,
  bootstrapStartedAt,
  bootstrapHadSetupSurface = false,
}: {
  pid: string;
  slug: string;
  title: string;
  paper?: Paper | null;
  stream: ReturnType<typeof useStreamingTurn>;
  chatStartPath: string;
  initialSource?: string;
  autoStart?: boolean;
  sessionState: string | null;
  selectedModel: string | null;
  retrieved: boolean;
  titleConfirmed?: boolean;
  modelLabel?: string;
  onPickModel?: () => void;
  /** Start of the route's session bootstrap; the opening query shares its 500 ms deadline. */
  bootstrapStartedAt?: number;
  /** Whether stage one could already have painted this same setup-shaped placeholder. */
  bootstrapHadSetupSurface?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const qc = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);
  const opening = useOpeningDraft(pid, slug);
  // Only the first opening load shares the route deadline. Once real opening data has rendered,
  // a later data-less refetch gets a fresh delay instead of inheriting a permanently-open latch.
  const [initialOpeningLoad, setInitialOpeningLoad] = useState(opening.data === undefined);
  useEffect(() => {
    if (opening.data !== undefined) setInitialOpeningLoad(false);
  }, [opening.data]);
  const openingBootstrapStartedAt = useMemo(
    () => bootstrapStartedAt ?? Date.now(),
    [bootstrapStartedAt],
  );
  const initialOpeningDelayMs = useMemo(() => {
    const remaining = Math.max(
      0,
      DISCUSSION_SKELETON_DELAY_MS - (Date.now() - openingBootstrapStartedAt),
    );
    return bootstrapHadSetupSurface
      ? remaining
      : Math.max(remaining, INITIAL_SKELETON_DELAY_MS);
  }, [bootstrapHadSetupSurface, openingBootstrapStartedAt]);
  const showOpeningSkeleton = useDelayedInitialSkeleton(
    opening.isLoading,
    opening.data !== undefined,
    initialOpeningLoad ? initialOpeningDelayMs : DISCUSSION_SKELETON_DELAY_MS,
  );
  const promptDraft = usePersistedDraft(
    draftKey(pid, 'discussion', slug, 'opening'),
    opening.data?.prompt ?? '',
  );
  const sourceDraft = usePersistedDraft(
    draftKey(pid, 'discussion', slug, 'source'),
    initialSource ?? '',
  );
  const customPrompt = promptDraft.value;
  const setCustomPrompt = promptDraft.setValue;
  const [starting, setStarting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedReady, setUploadedReady] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [retrievalJob, setRetrievalJob] = useState<RetrievalJob | null>(null);
  const [titleDecisionConfirmed, setTitleDecisionConfirmed] = useState(titleConfirmed);
  const [updatingTitle, setUpdatingTitle] = useState(false);
  const autoStartAttempted = useRef(false);
  const manualSource = sourceDraft.value;
  const setManualSource = sourceDraft.setValue;
  // Every Reading Mode is a visible prompt template. Customize Prompt is a peer template
  // that exposes the complete composed prompt and deliberately applies no hidden mode layer.
  const [template, setTemplate] = useState<OpeningTemplateKey>('balanced');
  const presetPrompt = template === 'custom'
    ? ''
    : opening.data?.templates?.[template] ?? opening.data?.prompt ?? '';
  const prompt = template === 'custom' ? customPrompt : presetPrompt;
  const isRetrieved = retrieved || uploadedReady || !!retrievalJob?.retrieved;
  const candidates =
    retrievalJob?.phase === 'confirmation'
      ? (retrievalJob.candidates as SourceCandidate[])
      : [];
  const retrieveError = isRetrieved
    ? null
    : localError ??
      (retrievalJob?.status === 'error'
        ? retrievalJob.error || 'The paper could not be fetched.'
        : null);
  const matchedTitle = retrievalJob?.matched_title?.trim() || null;
  const shouldOfferTitle =
    isRetrieved &&
    !!matchedTitle &&
    !titleDecisionConfirmed &&
    comparableTitle(matchedTitle) !== comparableTitle(title);

  useEffect(() => {
    if (titleConfirmed) setTitleDecisionConfirmed(true);
  }, [titleConfirmed]);

  useEffect(() => {
    if (initialSource && sourceDraft.ready && !sourceDraft.hasDraft) {
      sourceDraft.setValue(initialSource);
    }
  }, [initialSource, sourceDraft.hasDraft, sourceDraft.ready, sourceDraft.setValue]);

  useEffect(() => {
    if (promptDraft.submitted && sessionState && opening.data?.prompt === customPrompt) {
      void promptDraft.clear(opening.data.prompt);
    }
  }, [customPrompt, opening.data?.prompt, promptDraft.clear, promptDraft.submitted, sessionState]);

  // Reattach to a durable retrieval when this screen is reopened mid-fetch or after a failure.
  useEffect(() => {
    let active = true;
    void api.getLatestRetrievalJob(pid, slug).then(
      ({ job }) => {
        if (active && job) setRetrievalJob(job);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [pid, slug]);

  // Keep polling the same retrieval snapshot while either retrieval or its first-read
  // enrichment fan-out is active; no second progress protocol is needed.
  useEffect(() => {
    if (
      retrievalJob?.status !== 'running' &&
      retrievalJob?.enrichment?.status !== 'running'
    ) return;
    let active = true;
    const timer = setInterval(() => {
      void api.getRetrievalJob(pid, retrievalJob.id).then(
        ({ job }) => {
          if (active) setRetrievalJob(job);
        },
        () => undefined,
      );
    }, RETRIEVAL_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [
    pid,
    retrievalJob?.enrichment?.status,
    retrievalJob?.id,
    retrievalJob?.status,
  ]);

  useEffect(() => {
    if (!retrievalJob?.retrieved) return;
    void qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
    void qc.invalidateQueries({ queryKey: keys.projectState(pid) });
  }, [pid, qc, retrievalJob?.retrieved, slug]);

  // Keep the live "Resolving / hunting" status in view on first read. The source surface sits
  // at the end of the setup form, so scrollToEnd reveals progress and eventual recovery actions.
  useEffect(() => {
    if (retrievalJob?.status !== 'running') return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [
    retrievalJob?.detail,
    retrievalJob?.enrichment?.step,
    retrievalJob?.items?.length,
    retrievalJob?.phase,
    retrievalJob?.status,
  ]);

  function selectTemplate(next: OpeningTemplateKey) {
    if (next === 'custom' && !promptDraft.hasDraft) {
      setCustomPrompt(prompt || opening.data?.prompt || '');
    }
    setTemplate(next);
  }

  async function settleRetrieval(initial: RetrievalJob): Promise<RetrievalJob> {
    let current = initial;
    const deadline = Date.now() + RETRIEVAL_WAIT_MS;
    while (current.status === 'running' && Date.now() < deadline) {
      await sleep(RETRIEVAL_POLL_MS);
      current = (await api.getRetrievalJob(pid, current.id)).job;
      setRetrievalJob(current);
    }
    return current;
  }

  async function fetchPaper(
    source?: { arxiv_id?: string; pdf_url?: string },
    sourceText?: string,
    retry?: () => void | Promise<unknown>,
  ): Promise<boolean> {
    setFetching(true);
    setLocalError(null);
    try {
      if (sourceText) await sourceDraft.markSubmitted();
      const started = (await api.startRetrievalJob(pid, slug, source)).job;
      setRetrievalJob(started);
      const settled = await settleRetrieval(started);
      if (settled.phase === 'confirmation') {
        setLocalError(
          'Couldn’t confidently match this paper. Choose a source below, paste a link, or upload the PDF.',
        );
        return false;
      }
      if (settled.status !== 'done' || !settled.retrieved) {
        if (presentSpendJobRefusal(settled.refusal, { operation: 'other', retry })) return false;
        setLocalError(settled.error || 'The paper could not be fetched.');
        return false;
      }
      if (sourceText) await sourceDraft.clear('');
      return true;
    } catch (e) {
      if (presentSpendRefusal(e, {
        operation: 'other',
        retry: retry ?? (() => fetchPaper(source, sourceText)),
      })) return false;
      setLocalError((e as Error).message ?? 'Could not fetch the paper.');
      return false;
    } finally {
      setFetching(false);
    }
  }

  async function startReading() {
    if (!prompt.trim() || starting) return;
    setStarting(true);
    setLocalError(null);
    try {
      const sourceText = manualSource.trim() || initialSource;
      const ready =
        isRetrieved ||
        (await fetchPaper(
          sourceText ? parseSource(sourceText) : undefined,
          sourceText,
          () => startReading(),
        ));
      if (!ready) return;
      if (template === 'custom') await promptDraft.markSubmitted();
      await stream.run(
        chatStartPath,
        {
          slug,
          prompt,
          // Match every other turn (reply/finish/retry): send the user's explicit pick, else
          // undefined so the backend applies its CURRENT default. Deliberately NOT
          // opening.data.model — that echoes the default at draft-generation time, so a model
          // change in Settings (e.g. recovering from a quota error) wouldn't take effect on a
          // reopened paper whose draft is still cached.
          model: selectedModel ?? undefined,
          mode: template === 'custom' || template === 'balanced' ? undefined : template,
        },
        undefined,
        async () => {
          if (template === 'custom') await promptDraft.clear(opening.data?.prompt ?? '');
          await sourceDraft.clear('');
        },
      );
    } catch (e) {
      setLocalError((e as Error).message ?? 'Could not start reading.');
    } finally {
      setStarting(false);
    }
  }

  // The shared known-paper field is an explicit request to add AND begin. Wait until both
  // persisted inputs and the server-authored opening prompt are ready, then invoke the exact
  // same durable retrieval → chat-job path as the visible Start button. Never auto-submit a
  // second time on rerender; any refusal modal exposes its own deliberate retry action.
  useEffect(() => {
    if (
      !autoStart
      || autoStartAttempted.current
      || !promptDraft.ready
      || !sourceDraft.ready
      || !opening.data
      || !prompt.trim()
    ) return;
    autoStartAttempted.current = true;
    void startReading();
    // startReading deliberately closes over the now-ready prompt/source/model selection. The
    // ref is the one-shot boundary; adding the function itself would retrigger every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, opening.data, prompt, promptDraft.ready, sourceDraft.ready]);

  function fetchFromManual() {
    const s = manualSource.trim();
    if (!s) return;
    void fetchPaper(parseSource(s), s);
  }

  async function pickPdf() {
    setLocalError(null);
    // Native modules can be added to JavaScript before a tester has rebuilt their development
    // client. Loading the picker only on demand keeps the entire paper route usable in that
    // stale client; the upload action itself explains the required rebuild and existing link
    // fallback instead of crashing Expo Router while it evaluates this module.
    let documentPicker: typeof import('expo-document-picker');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      documentPicker = require('expo-document-picker') as typeof import('expo-document-picker');
    } catch {
      setLocalError(
        'This development build does not include PDF picking yet. Rebuild the app, or paste a direct PDF link above.',
      );
      return;
    }
    const result = await documentPicker.getDocumentAsync({
      type: 'application/pdf',
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const file = result.assets[0];
    setUploading(true);
    try {
      const started = (await api.uploadPaper(pid, slug, {
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
      })).job;
      setRetrievalJob(started);
      const settled = await settleRetrieval(started);
      if (settled.status !== 'done' || !settled.retrieved) {
        setLocalError(settled.error || 'Could not extract text from that PDF.');
        return;
      }
      setUploadedReady(true);
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    } catch (e) {
      setLocalError((e as Error).message ?? 'Could not upload that PDF.');
    } finally {
      setUploading(false);
    }
  }

  async function acceptMatchedTitle() {
    if (!matchedTitle || updatingTitle) return;
    setUpdatingTitle(true);
    setLocalError(null);
    try {
      await api.updatePaper(pid, slug, matchedTitle, true);
      setTitleDecisionConfirmed(true);
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    } catch (e) {
      setLocalError((e as Error).message ?? 'Could not update the paper title.');
    } finally {
      setUpdatingTitle(false);
    }
  }

  async function keepMatchedTitle() {
    if (!matchedTitle || updatingTitle) return;
    setUpdatingTitle(true);
    setLocalError(null);
    try {
      await api.updatePaper(pid, slug, undefined, true);
      setTitleDecisionConfirmed(true);
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    } catch (e) {
      setLocalError((e as Error).message ?? 'Could not keep the current paper title.');
    } finally {
      setUpdatingTitle(false);
    }
  }

  if (opening.isLoading) {
    return showOpeningSkeleton ? <PaperSetupLoadingSkeleton /> : null;
  }

  if (stream.streaming) {
    // The opening turn streams without the composer, so Stop needs its own affordance here
    // (polish plan F.1 — every streaming turn must be stoppable).
    return (
      <View style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.streamingOnly}>
          <Card style={styles.assistantCard}>
            <StreamingTurnBody items={stream.items} activity={stream.activity} />
          </Card>
        </ScrollView>
        <View style={styles.startFooter}>
          <Button
            title="Stop"
            variant="ghost"
            onPress={() => void stream.stop()}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.composeFirst}
        keyboardShouldPersistTaps="handled">
        {/* Hero card (Figma `09 · Start Reading`): status chip + editorial title. */}
        <Card style={styles.heroCard}>
          <Chip label={isRetrieved ? 'Paper ready' : 'Unread paper'} dot={false} />
          <Text variant="editorial">{title}</Text>
          <PaperContext paper={paper} />
          <Text variant="body" color={t.muted}>
            Choose how the analyst should open the discussion.
          </Text>
        </Card>

        {/* Reading Modes are first-turn prompt templates; Customize is the full-control peer. */}
        <View style={{ marginTop: space.lg }}>
          <Text variant="overline">Reading modes</Text>
          <Text variant="caption" style={{ marginTop: space.xs }}>
            Choose how the opening instructions should be written.
          </Text>
          <View style={styles.promptTemplates}>
            {OPENING_TEMPLATE_OPTIONS.map((option) => (
              <PromptTemplateOption
                key={option.key}
                title={option.title}
                description={template === option.key ? option.description : undefined}
                icon={option.icon}
                selected={template === option.key}
                onPress={() => selectTemplate(option.key)}
              />
            ))}
          </View>
          <Pressable
            onPress={onPickModel}
            accessibilityRole="button"
            accessibilityLabel={`Model for paper summary. ${modelLabel}`}
            style={({ pressed }) => [
              styles.firstModelRow,
              pressed && { opacity: 0.82 },
            ]}>
            <View style={styles.firstModelIcon}>
              <Icon name="zap" size={16} color={t.violet} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="heading">Model</Text>
              <Text variant="caption" color={t.muted} numberOfLines={1}>
                {modelLabel}
              </Text>
            </View>
            <Text variant="label" color={t.mint}>Change</Text>
          </Pressable>
        </View>
        {template === 'custom' ? (
          <View style={{ marginTop: space.lg }}>
            <Text variant="overline">Opening prompt</Text>
            <Text variant="caption" style={{ marginBottom: space.sm, marginTop: space.xs }}>
              Edit how the analyst should begin.
            </Text>
            <TextInput
              value={prompt}
              onChangeText={setCustomPrompt}
              multiline
              style={styles.promptInput}
              placeholder="Opening prompt…"
              placeholderTextColor={t.muted}
            />
            {opening.data?.model ? (
              <Text variant="caption" style={{ marginTop: space.sm }}>
                model: {opening.data.model}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Card style={styles.sourceCard}>
          <View style={styles.sourceHead}>
            <View
              style={[
                styles.sourceIcon,
                isRetrieved && { backgroundColor: t.mintWash, borderColor: t.mint },
              ]}>
              <Icon
                name={
                  isRetrieved
                    ? 'check'
                    : retrievalJob?.status === 'running'
                      ? 'search'
                      : retrieveError
                        ? 'alert-circle'
                        : 'download'
                }
                size={17}
                color={isRetrieved ? t.mint : retrieveError ? t.danger : t.amber}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="heading">
                {isRetrieved
                  ? 'Full text ready'
                  : retrievalJob?.phase === 'confirmation'
                    ? 'Confirm the paper source'
                  : retrievalJob?.status === 'running'
                    ? retrievalJob.phase === 'hunting'
                      ? 'Finding a public PDF'
                      : 'Resolving the paper'
                    : retrieveError
                      ? 'Paper not fetched'
                      : 'Full text not fetched'}
              </Text>
              <Text variant="caption" color={t.muted}>
                {isRetrieved
                  ? 'The analyst can read and cite the paper.'
                  : retrievalJob?.status === 'running'
                    ? retrievalJob.detail || 'This continues if you leave the screen.'
                    : 'Fetch now, or Start reading to fetch automatically.'}
              </Text>
            </View>
            {/* Not while waiting on a confirmation: the job is finished and the reader has to
                choose a source, so a spinner would claim work is still happening. There is a
                reachable window where status is still `running` with the phase already set. */}
            {retrievalJob?.status === 'running' && retrievalJob.phase !== 'confirmation' ? (
              <ActivityIndicator color={t.amber} size="small" />
            ) : null}
          </View>

          {/* The staged card, for the same reason the graph build has one: a single line of
              `detail` that appears and is replaced tells the reader nothing about how far along
              the fetch is or whether it has stalled. The steps persist; the detail line under
              them is the only part that changes. */}
          {retrievalJob || isRetrieved ? (
            <FetchProgress job={retrievalJob} isRetrieved={isRetrieved} />
          ) : null}

          {retrievalJob?.items?.length ? (
            <AgentTrail trail={retrievalJob.items} />
          ) : null}

          {retrieveError ? (
            <Text variant="caption" color={t.danger}>
              {retrieveError}
            </Text>
          ) : null}

          {!isRetrieved && retrievalJob?.status !== 'running' ? (
            <Button
              title={retrieveError ? 'Retry fetch' : 'Fetch paper'}
              icon="download"
              variant="ghost"
              onPress={() => {
                const sourceText = manualSource.trim() || initialSource;
                void fetchPaper(
                  sourceText ? parseSource(sourceText) : undefined,
                  sourceText,
                );
              }}
              loading={fetching}
              disabled={starting || uploading}
            />
          ) : null}

          {candidates.length ? (
            <View style={{ gap: space.sm }}>
              <Text variant="overline">Choose the paper you meant</Text>
            {candidates.map((c) => (
              <Pressable
                key={c.arxiv_id}
                  onPress={() => void fetchPaper({ arxiv_id: c.arxiv_id })}
                  disabled={fetching || starting}
                style={({ pressed }) => [styles.candidate, pressed && { opacity: 0.8 }]}>
                <Text variant="body" numberOfLines={2}>{c.title}</Text>
                <Text variant="caption" color={t.muted}>arXiv:{c.arxiv_id}</Text>
              </Pressable>
            ))}
            </View>
          ) : null}

          {!isRetrieved && (retrieveError || candidates.length > 0 || template === 'custom') ? (
            <View style={{ gap: space.sm }}>
              <Text variant="overline">Use your own source</Text>
              <TextInput
                value={manualSource}
                onChangeText={setManualSource}
                style={styles.searchInput}
                placeholder="PDF link or arXiv ID"
                placeholderTextColor={t.muted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.sourceActions}>
                <Button
                  title="Fetch link"
                  variant="ghost"
                  onPress={fetchFromManual}
                  disabled={!manualSource.trim() || fetching || starting || uploading}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Upload PDF"
                  icon="upload"
                  variant="ghost"
                  onPress={() => void pickPdf()}
                  loading={uploading}
                  disabled={fetching || starting}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : null}
        </Card>

        {shouldOfferTitle ? (
          <Card style={styles.identityCard}>
            <Text variant="overline" color={t.mint}>Paper found</Text>
            <Text variant="serifTitle">{matchedTitle}</Text>
            <Text variant="caption" color={t.muted}>
              This is the title reported by the source. Update the reading list?
            </Text>
            <View style={styles.sourceActions}>
              <Button
                title="Keep mine"
                variant="ghost"
                onPress={() => void keepMatchedTitle()}
                disabled={updatingTitle}
                style={{ flex: 1 }}
              />
              <Button
                title="Update title"
                onPress={() => void acceptMatchedTitle()}
                loading={updatingTitle}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        ) : null}
      </ScrollView>

      {/* Sticky primary action; prompt customization is one of the Reading Mode choices. */}
      <View style={styles.startFooter}>
        <Button
          title={
            starting
              ? isRetrieved
                ? 'Starting discussion…'
                : 'Fetching & starting…'
              : isRetrieved
                ? 'Start reading'
                : 'Fetch & start reading'
          }
          onPress={() => void startReading()}
          loading={starting}
          disabled={!prompt.trim() || fetching || uploading}
          style={{ flex: 1 }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

interface SourceCandidate {
  arxiv_id: string;
  title: string;
  score?: number;
}

// ---------- message bodies (rendered inside the library's bubbles) ----------

function AssistantBody({
  entry,
  isSummary = false,
  audioId,
  slug,
  title,
  favorites,
  onRetry,
  onConfigureFirstRetry,
  canRetry,
  onFoldToProjectNotes,
  onSwitchBranch,
  switchDisabled,
  figureContext,
  sentenceAnnotations,
}: {
  entry: Extract<TranscriptEntry, { role: 'assistant' }>;
  /** The opening account of the paper, styled as an artifact rather than a reply. */
  isSummary?: boolean;
  audioId: string;
  /** So a `propose_notes_update` tool call in this entry's trail can link to its review (DR-043). */
  slug?: string;
  title: string;
  favorites: FavoriteModel[];
  onRetry: (
    assistantIndex: number,
    config?: { model?: string; prompt?: string; mode?: ReadingMode },
  ) => void;
  onConfigureFirstRetry: () => void;
  canRetry: boolean;
  /** DR-081: fold this response's insight into the Project Notes (conservative editor pass). */
  onFoldToProjectNotes: (assistantIndex: number) => void;
  onSwitchBranch: (assistantIndex: number, branch: number) => void;
  switchDisabled: boolean;
  figureContext?: FigureContext;
  sentenceAnnotations?: SentenceAnnotations;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { discussionTextScale } = useThemeMode();
  const audio = useAudio();
  const { playing } = useIsPlaying();

  const prep = audio.prep?.id === audioId ? audio.prep : null;
  const current = audio.currentId === audioId;
  const audioError = audio.errorById[audioId] ?? entry.audio_error;
  const [copied, setCopied] = useState(false);
  const [retryMenu, setRetryMenu] = useState(false);
  const canonical = entry.canonical;

  // Listen -> prepare + play; on the loaded track it's a pause/resume toggle; after a
  // failure it retries (playText clears this message's error).
  const listenIcon: IconName = current ? (playing ? 'pause' : 'play') : audioError ? 'rotate-cw' : 'headphones';
  const listenLabel = current ? (playing ? 'Pause' : 'Resume') : audioError ? 'Retry audio' : 'Listen';
  const listenA11y = current
    ? (playing ? 'Pause this narration' : 'Resume this narration')
    : audioError ? 'Retry narration' : 'Listen to this response';

  async function copy() {
    await Clipboard.setStringAsync(canonical);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Themed retry menu (OptionsSheet, per polish plan F.5 — no native action sheets anywhere).
  const retryOptions: SheetOption[] = [
    {
      key: 'retry',
      title: 'Retry',
      subtitle: 'Regenerate with the current model',
      icon: 'rotate-ccw',
      onPress: () => onRetry(entry.assistant_index),
    },
    ...favorites.map((m) => ({
      key: `retry-${m.id}`,
      title: `Retry with ${m.label}`,
      icon: 'zap' as IconName,
      onPress: () => onRetry(entry.assistant_index, { model: m.id }),
    })),
  ];

  // R6.7 — a turn generated by a non-default model (cross-model retry) carries entry.model;
  // show a subtle badge with the friendly favorite label when we have one.
  const modelLabel = entry.model
    ? favorites.find((m) => m.id === entry.model)?.label ?? entry.model.split('/').pop() ?? entry.model
    : null;

  return (
    <View style={styles.assistantBody}>
      {isSummary ? (
        <View style={styles.summaryHeader}>
          <Icon name="file-text" size={13} color={t.mint} />
          <Text variant="caption" color={t.mint} style={styles.summaryLabel}>
            Paper summary
          </Text>
        </View>
      ) : null}
      {entry.agent_trail && entry.agent_trail.length > 0 ? (
        <AgentTrail trail={entry.agent_trail} slug={slug} />
      ) : null}
      <Markdown
        text={canonical}
        figureContext={figureContext}
        sentenceAnnotations={sentenceAnnotations}
        textScale={discussionTextScale}
      />
      {modelLabel ? (
        <Text
          variant="caption"
          color={t.muted}
          style={{ marginTop: space.xs }}
          accessibilityLabel={`Response generated by ${modelLabel}`}
        >
          {modelLabel}
        </Text>
      ) : null}
      {prep ? <GeneratingBar stage={prep.stage} done={prep.done} total={prep.total} onCancel={audio.cancelPrep} /> : null}
      {audioError ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: space.sm }}>
          Audio failed: {audioError}
        </Text>
      ) : null}
      {/* U.14 branch selector: minimal ⟨ 2/3 ⟩, only at a fork point. Switching swaps the
          whole conversation tail server-side; disabled while a turn is generating. */}
      {entry.branch_count && entry.branch_count > 1 && entry.branch_active ? (
        <View style={styles.branchRow}>
          <Pressable
            onPress={() => onSwitchBranch(entry.assistant_index, entry.branch_active! - 1)}
            disabled={switchDisabled || entry.branch_active <= 1}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Previous response branch"
            style={{ opacity: switchDisabled || entry.branch_active <= 1 ? 0.3 : 1 }}
          >
            <Icon name="chevron-left" size={16} color={t.muted} />
          </Pressable>
          <Text variant="caption" color={t.muted} accessibilityLabel={`Response branch ${entry.branch_active} of ${entry.branch_count}`}>
            {entry.branch_active}/{entry.branch_count}
          </Text>
          <Pressable
            onPress={() => onSwitchBranch(entry.assistant_index, entry.branch_active! + 1)}
            disabled={switchDisabled || entry.branch_active >= entry.branch_count}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Next response branch"
            style={{ opacity: switchDisabled || entry.branch_active >= entry.branch_count ? 0.3 : 1 }}
          >
            <Icon name="chevron-right" size={16} color={t.muted} />
          </Pressable>
        </View>
      ) : null}
      <View style={styles.msgActions}>
        <MsgAction
          icon={listenIcon}
          label={listenLabel}
          active={current}
          busy={!!prep}
          onPress={() => audio.playText({ id: audioId, title, text: canonical })}
          accessibilityLabel={listenA11y}
        />
        <MsgAction
          icon={copied ? 'check' : 'copy'}
          label={copied ? 'Copied' : 'Copy'}
          active={copied}
          onPress={() => void copy()}
          accessibilityLabel="Copy this response"
        />
        {/* Opus review, PR #398: a DRAFT response (proposed_commit) renders through this same
            body, and folding one always 400s server-side — a draft is approved or discarded,
            not folded. Hide the action there instead of offering a dead end. */}
        {!entry.proposed_commit ? (
          <MsgAction
            icon="edit-3"
            label="Project Notes"
            onPress={() => onFoldToProjectNotes(entry.assistant_index)}
            accessibilityLabel="Fold this response into the Project Notes"
          />
        ) : null}
        {canRetry ? (
          <MsgAction
            icon="rotate-ccw"
            label="Retry"
            onPress={
              entry.assistant_index === 0
                ? onConfigureFirstRetry
                : () => setRetryMenu(true)
            }
            accessibilityLabel="Retry this response, optionally with a different model"
          />
        ) : null}
      </View>
      <OptionsSheet
        visible={entry.assistant_index !== 0 && retryMenu}
        onClose={() => setRetryMenu(false)}
        title="Retry response"
        options={retryOptions}
      />
    </View>
  );
}

// Quiet inline action under an assistant answer (Figma 08a's ♡ Helpful · ⧉ Copy · Listen row):
// icon + small label, muted until active.
function MsgAction({
  icon,
  label,
  onPress,
  active,
  busy,
  accessibilityLabel,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
  busy?: boolean;
  accessibilityLabel: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const tint = active ? t.mint : t.muted;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      hitSlop={8}
      style={({ pressed }) => [styles.msgAction, pressed && { opacity: 0.7 }]}
      accessibilityLabel={accessibilityLabel}>
      {busy ? (
        <ActivityIndicator color={t.mint} size="small" />
      ) : (
        <Icon name={icon} size={15} color={tint} />
      )}
      <Text variant="caption" color={tint}>
        {label}
      </Text>
    </Pressable>
  );
}

// A streamed text run revealed through the smoothing buffer (useSmoothText): the job poller
// delivers ~900ms snapshots, and this types them out continuously instead of in lumps.
function SmoothMarkdown({ text }: { text: string }) {
  // DR-068 — streamed text is still Discussion content ("Apply changes immediately to...
  // streaming response text"), so it scales the same as the settled transcript.
  const { discussionTextScale } = useThemeMode();
  // DR-089 — the reveal holds still while the reader is away from the live edge.
  const paused = useRevealPaused();
  return <Markdown text={useSmoothText(text, paused)} textScale={discussionTextScale} />;
}

// The live assistant turn: text runs and tool invocations rendered in arrival order, so tool
// activity is interleaved with the response ("…answer so far… → 🔎 Searching → …more…") the way
// agent UIs conventionally show it — rather than pinning all tools above all text. The streamed
// Until answer text arrives, the shared activity component makes the current grounded work
// explicit without exposing internal model-state language.
function StreamingTurnBody({
  items,
  activity,
  finishPhase = null,
}: {
  items: StreamItem[];
  activity: string;
  finishPhase?: string | null;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const visibleItems = items.filter((item) => item.kind === 'tool' || item.text.trim().length > 0);
  const hasVisibleText = visibleItems.some((item) => item.kind === 'text');
  return (
    <View style={styles.assistantBody}>
      {finishPhase ? (
        // The graph build's staged treatment (DR-056): what is actually happening behind
        // Stop, kept visible for the whole wait — the preview streaming below does not
        // replace it.
        <ProgressSteps dotSize={20} style={styles.finishSteps} steps={finishSteps(finishPhase)} />
      ) : null}
      {!hasVisibleText ? (
        // One phrase, no explanatory subtitle beneath it (DR-006).
        <AgentActivity status={activity} testID="assistant-activity" />
      ) : null}
      {visibleItems.map((it, i) =>
        it.kind === 'text' ? (
          <SmoothMarkdown key={i} text={it.text} />
        ) : it.kind === 'thought' ? (
          // Pre-tool commentary, demoted server-side at the segment boundary: keep it visible
          // while the agent works, styled as activity — it is not part of the answer.
          <Text key={i} variant="caption" color={t.muted} style={styles.thoughtLine}>
            {it.text}
          </Text>
        ) : (
          <View key={i} style={styles.toolTrail}>
            <ToolLine name={it.name} detail={it.detail} />
          </View>
        ),
      )}
    </View>
  );
}

function Centered({ text }: { text?: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.centered}>
      <Text variant="body" color={t.muted}>{text}</Text>
    </View>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  return StyleSheet.create({
  composeFirst: { padding: tight ? space.sm : space.md },
  promptTemplates: {
    gap: tight ? 6 : space.sm,
    marginTop: tight ? space.sm : space.md,
  },
  firstModelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tight ? space.sm : space.md,
    marginTop: tight ? space.sm : space.md,
    padding: tight ? space.sm : space.md,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.md,
    backgroundColor: t.surface,
  },
  firstModelIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streamingOnly: {
    padding: tight ? space.sm : space.md,
    paddingBottom: tight ? space.lg : space.xl,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  candidate: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    padding: tight ? space.sm : space.md,
    gap: 2,
  },
  searchInput: {
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: tight ? 14 : 15,
  },
  promptInput: {
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    padding: tight ? space.sm : space.md,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: tight ? 14 : 15,
    minHeight: 160,
    textAlignVertical: 'top',
    lineHeight: tight ? 21 : 22,
  },
  renameInput: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: tight ? 10 : 12,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: tight ? 14 : 15,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: tight ? space.md : space.lg,
  },
  // ---- thread ----
  messagesContainer: { backgroundColor: t.bg },
  discussionHeaderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
  },
  discussionTopFade: { zIndex: 20 },
  assistantCard: { backgroundColor: t.surface },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    marginTop: space.sm,
  },
  finishSteps: { marginBottom: space.md, marginTop: space.xs },
  assistantBody: {
    paddingHorizontal: tight ? space.md : space.lg,
    paddingTop: tight ? space.sm : 10,
    paddingBottom: tight ? space.md : space.lg,
  },
  // Assistant turns are long-form reading content on the transcript's base layer. They do not
  // get a card, border, or bubble silhouette; whitespace and the quiet action row separate them.
  analystBubble: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    ...SQUARE_CORNERS,
  },
  // The opening summary stays identifiable through its semantic label, not a competing panel.
  summaryBubble: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    ...SQUARE_CORNERS,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: tight ? 6 : space.sm,
  },
  summaryLabel: {
    fontFamily: fonts.body,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  userBubble: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.lg,
    borderBottomRightRadius: 6,
  },
  // DR-009: the user bubble's Markdown body needs only the inset — typography is Markdown's.
  userBody: {
    paddingHorizontal: tight ? space.sm : space.md,
    paddingVertical: tight ? 6 : space.sm,
  },
  msgActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tight ? space.md : space.lg,
    marginTop: tight ? space.sm : space.md,
    alignItems: 'center',
  },
  msgAction: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32 },
  toolTrail: {
    gap: space.xs,
    paddingVertical: tight ? 6 : space.sm,
    paddingHorizontal: tight ? space.sm : space.md,
    marginBottom: tight ? 6 : space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.elevated,
  },
  thoughtLine: { fontStyle: 'italic', paddingLeft: space.sm },
  errorCard: { borderColor: t.danger, margin: space.md },
  connectionNotice: {
    margin: space.md,
  },
  // Overrides the library's white default circle (its content is our Icon; see
  // scrollToBottomComponent) into the app's circular icon-button idiom.
  scrollToBottomBtn: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    elevation: 0,
    shadowOpacity: 0,
  },
  // ---- toolbar (R9.3: one floating rounded card, no full-width strip) ----
  // The container is transparent with side margins, so its edge never reads as a separator
  // line across the chat; the elevated rounded surface lives on `composerCard` (the primary
  // row), which holds the input + send button together.
  // The composer floats over the scrolling list (Gemini/ChatGPT): its container is fully
  // transparent so message content shows behind/around the rounded pill, hidden only where it
  // sits under the pill itself. The list gets a matching bottom inset (composerHeight) so the
  // newest message can scroll clear of it (R12.6).
  composerOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
    zIndex: 10,
  },
  composerForeground: { zIndex: 1 },
  toolbar: {
    borderTopWidth: 0,
    backgroundColor: 'transparent',
    paddingTop: space.xs,
  },
  composerCard: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: 24,
    // Clip the fill to the rounded border so it can't bleed past the corners on Android (R12.6).
    overflow: 'hidden',
    // Floats over the message list on its shadow — the toolbar strip behind it stays
    // transparent (R12.6).
    ...floatShadow,
    paddingLeft: tight ? space.sm : space.md,
    paddingRight: 6,   // the send button sits close to the right edge, inside the card
    paddingVertical: 6,
  },
  composerInput: {
    flex: 1,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: tight ? 14 : 15,
    lineHeight: tight ? 19 : 20,
    textAlignVertical: 'top',
    // GrowingComposer applies the measured height directly to the native input.
    minHeight: 34,
    maxHeight: 120,
    // Transparent: the surrounding card (composerCard) IS the elevated rounded surface now,
    // so the input carries no pill of its own (that + an external send button was the R9.3
    // "separator line + button outside" problem).
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
    paddingVertical: 6,
  },
  committedBar: {
    marginHorizontal: tight ? space.sm : space.md,
    padding: tight ? space.sm : space.md,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.lg,
    backgroundColor: t.elevated,
    ...floatShadow,
  },
  accessoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
  },
  accessoryCol: { gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.sm },
  sendBtn: {
    backgroundColor: t.mint,
    borderRadius: radius.pill,
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,   // sits inside the card's right edge, aligned to the input's bottom
  },
  sendBtnDisabled: { backgroundColor: t.elevated },
  // ---- compose-first (Start Reading) ----
  heroCard: { gap: tight ? space.sm : space.md, alignItems: 'flex-start' },
  sourceCard: {
    gap: tight ? space.sm : space.md,
    marginTop: tight ? space.md : space.lg,
    borderColor: t.line2,
  },
  sourceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tight ? space.sm : space.md,
  },
  sourceIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.amberWash,
    borderWidth: 1,
    borderColor: t.amberLine,
  },
  sourceActions: { flexDirection: 'row', gap: space.sm },
  identityCard: {
    gap: space.sm,
    marginTop: tight ? space.sm : space.md,
    borderColor: t.mint,
  },
  startFooter: {
    flexDirection: 'row',
    gap: space.sm,
    padding: tight ? space.md : space.lg,
    paddingTop: tight ? space.sm : space.md,
    borderTopWidth: 1,
    borderTopColor: t.line,
    backgroundColor: t.bg,
  },
  });
};

/** The staged fetch card: two honest stages plus the one line that actually changes. */
function FetchProgress({ job, isRetrieved }: {
  job: Parameters<typeof retrievalProgress>[0];
  isRetrieved: boolean;
}) {
  const t = useTheme();
  const { steps, detail } = retrievalProgress(job, isRetrieved);
  return (
    <>
      <ProgressSteps dotSize={20} style={{ marginTop: space.sm }} steps={steps} />
      {detail ? (
        <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
          {detail}
        </Text>
      ) : null}
    </>
  );
}

/**
 * What is known about a paper BEFORE reading it, so the reader can decide whether to spend a
 * summary at all — and how to read one if they do.
 *
 * Everything here is deliberately available for an unopened paper: the abstract comes from the
 * reading-list entry, the relevance counts from its citation annotations. Anything that only
 * exists after retrieval or a graph build is omitted rather than shown empty — a row of blanks on
 * exactly the papers the reader has not read is worse than no row at all, because it looks like
 * the app failed rather than like the fact is simply not known yet.
 */
export function PaperContext({ paper }: { paper?: Paper | null }) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (!paper) return null;

  const links = paper.project_links;
  const facts: string[] = [];
  if (paper.year) facts.push(String(paper.year));
  if (paper.affiliations?.length) facts.push(paper.affiliations.join(' · '));
  if (links?.cited_by_in_project) {
    // The read count is called out because a citation from a paper the reader actually read is a
    // stronger reason to care than one from another unread entry.
    facts.push(links.cited_by_read
      ? `Cited by ${links.cited_by_in_project} here, ${links.cited_by_read} you've read`
      : `Cited by ${links.cited_by_in_project} here`);
  }
  // Outgoing links are context too, and were being computed and then dropped — so a paper that
  // cites three others here, with no abstract yet, rendered as though nothing were known.
  if (links?.cites_in_project) {
    facts.push(`Cites ${links.cites_in_project} here`);
  }

  const abstract = (paper.abstract ?? '').trim();
  if (!facts.length && !abstract) return null;

  return (
    <View style={{ gap: space.xs }}>
      {facts.length ? (
        <Text variant="caption" color={t.muted}>{facts.join('  ·  ')}</Text>
      ) : null}
      {abstract ? (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Collapse the abstract' : 'Expand the abstract'}
        >
          <Text variant="body" color={t.muted} numberOfLines={expanded ? undefined : 3}>
            {abstract}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
