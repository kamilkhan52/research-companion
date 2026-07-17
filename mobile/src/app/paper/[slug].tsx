// Discussion — the streaming chat with the analyst over one paper (or the working-notes review).
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
  MessageText,
  type BubbleProps,
  type InputToolbarProps,
  type LeftRightStyle,
  type MessageTextProps,
} from '@kesha-antonov/react-native-chat';
import { useQueryClient } from '@tanstack/react-query';
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
import { streamPaths, turnJobPaths } from '@/api/endpoints';
import { useFavoriteModels, useOpeningDraft, useSession, useSettings } from '@/api/queries';
import { keys } from '@/api/queries';
import { streamPost } from '@/api/stream';
import type { ChatJob, FavoriteModel, ReadingMode, StartStreamEvent, StreamItem, TranscriptEntry } from '@/api/types';
import { READING_MODE_LABELS } from '@/api/types';
import { useAudio } from '@/audio/AudioProvider';
import { messageAudioId, useListeningHandoffRecovery } from '@/audio/identity';
import { isHandoffEligible } from '@/audio/handoffState';
import { usePreviewCues } from '@/audio/usePreviewCues';
import {
  toDiscussionMessages,
  DISCUSSION_USER,
  type DiscussionMessage,
} from '@/components/chat/discussionMessages';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { NotesReviewSheet } from '@/components/NotesReviewSheet';
import { AgentActivity } from '@/components/AgentActivity';
import { AgentTrail, ToolLine } from '@/components/AgentTrail';
import { ExternalRefSheet, type ExternalRef } from '@/components/ExternalRefSheet';
import { LinkHandlerContext, Markdown, type LinkHandler } from '@/components/Markdown';
import { usePaperActions } from '@/components/PaperEntityProvider';
import { PromptTemplateOption } from '@/components/PromptTemplateOption';
import { GeneratingBar } from '@/components/NarrationTranscript';
import { RelatedWorksSheet } from '@/components/RelatedWorksSheet';
import { TopBar } from '@/components/TopBar';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { useSmoothText } from '@/hooks/useSmoothText';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';
import { useActiveProject } from '@/store/project';
import { useListeningMode } from '@/store/listening';
import { fullPaperUrl } from '@/lib/paperLinks';
import { Button, Card, Chip, Icon, IconButton, Screen, Text, type IconName } from '@/ui';
import { useTheme, useThemedStyles, useThemeMode } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

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
// MessageText's own container has a built-in inset (marginVertical: 5, marginHorizontal: 10)
// we don't want stacking with our own padding on user-message text (see userText style).
const ZERO_INSET: ViewStyle = { marginVertical: 0, marginHorizontal: 0 };

export default function DiscussionScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  // `source` (optional) carries a pasted arXiv id / PDF link from the Discover screen's
  // "specific paper" box, so the first fetch uses exactly that source.
  const { slug, source, project } = useLocalSearchParams<{
    slug: string;
    source?: string;
    project?: string;
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
    if (!/^https?:\/\//i.test(href)) return;
    setExternalRef({ href, label });
  }, [showPaperActions]);

  const session = useSession(pid, slug ?? null);
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
  }, [slug]);
  const audio = useAudio();
  const { listeningMode, setListeningMode } = useListeningMode();
  const handleTurnDone = useCallback(async (job: ChatJob) => {
    if (!listeningMode || job.delivery_mode !== 'listening') return;
    if (!(await isHandoffEligible(job.id))) return;
    if (job.audio_error) throw new Error(job.audio_error);
    const canonical = job.turn?.canonical;
    if (!job.audio_job_id || !canonical || job.assistant_index == null || !pid || !slug) return;
    audio.enqueueJob(
      {
        id: messageAudioId(pid, slug, job.assistant_index, canonical),
        title: session.data?.paper.title ?? 'Narration',
        text: canonical,
      },
      job.audio_job_id,
      pid,
      job.id,
    );
  }, [audio, listeningMode, pid, session.data?.paper.title, slug]);
  const stream = useStreamingTurn(
    pid,
    slug ?? null,
    listeningMode ? 'listening' : 'reading',
    handleTurnDone,
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
  const hasSession = !!state && transcript.length > 0;
  const paths = pid ? turnJobPaths(pid) : null;
  useListeningHandoffRecovery({
    enabled: listeningMode,
    project: pid,
    slug: slug ?? null,
    title: session.data?.paper.title ?? 'Narration',
    transcript,
    enqueueJob: audio.enqueueJob,
  });

  // Reattach to a turn that's still generating for this paper (we navigated away mid-turn,
  // the app was backgrounded, the connection dropped…). The job kept running server-side.
  useEffect(() => {
    void stream.resume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, slug]);

  const [showRelated, setShowRelated] = useState(false);
  // Model + reading-mode pickers live behind the kebab menu (polish plan H.1) — the header
  // stays quiet: back, title, one menu button.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const readingMode = session.data?.reading_mode ?? 'balanced';
  const paperUrl = session.data?.paper ? fullPaperUrl(session.data.paper) : null;
  const switchMode = useCallback(async (mode: ReadingMode) => {
    if (!pid || !slug || mode === readingMode) return;
    try {
      await api.setSessionMode(pid, slug, mode);
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
    } catch (e) {
      Alert.alert('Could not switch mode', (e as Error).message ?? 'Request failed.');
    }
  }, [pid, qc, readingMode, slug]);
  // The chat library's own KeyboardAvoidingView assumes it starts right below the safe area
  // (`keyboardVerticalOffset={insets.top}` in its source) — it has no way to know a TopBar
  // sits above it in this app's layout, so without correcting for that height the composer
  // stays partly under the keyboard. Measure the real header height and hand back the
  // corrected total (device inset + header) as the override.
  const [headerHeight, setHeaderHeight] = useState(0);

  async function finishReadingFromMenu() {
    if (!paths || !slug) return;
    await stream.run(paths.finish, { slug, model: selectedModel ?? undefined });
  }

  // Committed -> back in discussion (polish plan H.2): the server keeps everything recorded;
  // only the state flips, so the composer returns and a later Finish proposes a fresh draft.
  async function continueFromCommitted() {
    if (!pid || !slug) return;
    try {
      await api.continueDiscussion(pid, slug);
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    } catch (e) {
      Alert.alert('Could not continue the discussion', (e as Error).message ?? 'Request failed.');
    }
  }

  return (
    <LinkHandlerContext.Provider value={handleReferenceLink}>
    <ExternalRefSheet pid={pid} refItem={externalRef} onClose={() => setExternalRef(null)} />
    <Screen edges={['top']}>
      <View onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}>
      <TopBar
        title={session.data?.paper.title ?? 'Discussion'}
        // Year first: it situates the paper on the timeline before the workflow state (U.17).
        subtitle={
          [session.data?.paper.year, state ? STATE_LABEL[state] : undefined]
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
            onGraph={() => router.push('/graph')}
            paperUrl={paperUrl}
            showFinishReading={hasSession && state !== 'notes_drafted' && state !== 'committed'}
            finishReadingDisabled={stream.streaming}
            onFinishReading={() => void finishReadingFromMenu()}
            showContinue={state === 'committed'}
            onContinue={() => void continueFromCommitted()}
            modelLabel={
              selectedModel == null
                ? (settings.data?.model ?? 'Default')
                : (favoriteModels.data?.find((m) => m.id === selectedModel)?.label ?? selectedModel)
            }
            onPickModel={() => setModelPickerOpen(true)}
            showReadingMode={hasSession}
            readingModeLabel={READING_MODE_LABELS[readingMode]}
            onPickReadingMode={() => setModePickerOpen(true)}
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
        <Centered loading />
      ) : !hasSession ? (
        <ComposeFirst
          pid={pid}
          slug={slug!}
          title={session.data?.paper.title ?? 'This paper'}
          stream={stream}
          chatStartPath={paths!.chatStart}
          initialSource={typeof source === 'string' && source ? source : undefined}
          sessionState={state}
          selectedModel={selectedModel}
        />
      ) : (
        <DiscussionThread
          pid={pid}
          slug={slug!}
          state={state}
          stream={stream}
          paths={paths!}
          transcript={transcript}
          acceptedDrafts={session.data?.accepted_drafts ?? []}
          title={session.data?.paper.title ?? 'Narration'}
          favorites={favoriteModels.data ?? []}
          selectedModel={selectedModel}
          onContinue={() => void continueFromCommitted()}
          headerHeight={headerHeight}
          onMutated={() => {
            qc.invalidateQueries({ queryKey: keys.session(pid, slug!) });
            qc.invalidateQueries({ queryKey: keys.projectState(pid) });
          }}
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

// The single overflow trigger for every discussion-level action that isn't the composer
// itself: navigation into related works / graph / notes, then the quieter mode toggles —
// grouped per Figma `08c · Actions menu`.
function OverflowMenu({
  listeningMode,
  onToggleListening,
  hasNotes,
  onViewNotes,
  onRelatedWorks,
  onGraph,
  paperUrl,
  showFinishReading,
  finishReadingDisabled,
  onFinishReading,
  showContinue,
  onContinue,
  modelLabel,
  onPickModel,
  showReadingMode,
  readingModeLabel,
  onPickReadingMode,
}: {
  listeningMode: boolean;
  onToggleListening: () => void;
  hasNotes: boolean;
  onViewNotes: () => void;
  onRelatedWorks: () => void;
  onGraph: () => void;
  paperUrl: string | null;
  showFinishReading: boolean;
  finishReadingDisabled: boolean;
  onFinishReading: () => void;
  showContinue: boolean;
  onContinue: () => void;
  modelLabel: string;
  onPickModel: () => void;
  showReadingMode: boolean;
  readingModeLabel: string;
  onPickReadingMode: () => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);

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
  if (showFinishReading) {
    options.push({
      key: 'finish',
      title: 'Finish reading',
      subtitle: 'Draft notes to commit for this paper',
      icon: 'check-square',
      accent: t.mint,
      disabled: finishReadingDisabled,
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
  if (hasNotes) {
    options.push({ key: 'notes', title: 'View notes', icon: 'file-text', accent: t.mint, onPress: onViewNotes });
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
  options.push({
    key: 'listening',
    title: listeningMode ? 'Turn off listening' : 'Turn on listening',
    icon: 'headphones',
    onPress: onToggleListening,
  });

  return (
    <>
      <IconButton name="more-vertical" onPress={() => setOpen(true)} accessibilityLabel="More actions" />
      <OptionsSheet visible={open} onClose={() => setOpen(false)} options={options} />
    </>
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

type OpeningTemplateKey = ReadingMode | 'custom';
const OPENING_TEMPLATE_OPTIONS: {
  key: OpeningTemplateKey;
  title: string;
  description: string;
  icon: IconName;
}[] = [
  { key: 'balanced', title: 'Balanced', description: 'A clear overview with context and technical substance.', icon: 'circle' },
  { key: 'background', title: 'Background-heavy', description: 'Build the groundwork and explain unfamiliar ideas as they appear.', icon: 'book-open' },
  { key: 'technical', title: 'Technical', description: 'Skip the basics and engage closely with methods, math, and assumptions.', icon: 'cpu' },
  { key: 'detailed', title: 'Detailed', description: 'Walk through the paper thoroughly without compressing key steps.', icon: 'list' },
  { key: 'custom', title: 'Customize prompt', description: 'Edit the complete opening instruction and control it directly.', icon: 'edit-3' },
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
): string {
  return messageAudioId(pid, slug, entry.assistant_index, entry.canonical);
}

function DiscussionThread({
  pid,
  slug,
  state,
  stream,
  paths,
  transcript,
  acceptedDrafts,
  title,
  favorites,
  selectedModel,
  onContinue,
  headerHeight,
  onMutated,
}: {
  pid: string;
  slug: string;
  state: string | null;
  stream: ReturnType<typeof useStreamingTurn>;
  paths: ReturnType<typeof turnJobPaths>;
  transcript: TranscriptEntry[];
  acceptedDrafts: { kind: 'reply' | 'revision'; text: string }[];
  title: string;
  favorites: FavoriteModel[];
  selectedModel: string | null;
  onContinue: () => void;
  headerHeight: number;
  onMutated: () => void;
}) {
  const theme = useTheme();
  const { themeName } = useThemeMode();
  const styles = useThemedStyles(makeStyles);
  // Keep lifecycle-specific keys: if the server advances to notes_drafted while a reply is
  // being authored elsewhere, that reply stays recoverable when the discussion is reopened
  // instead of being relabeled as request-changes feedback.
  const draftKind = state === 'notes_drafted' ? 'request-changes' : 'reply';
  const textDraft = usePersistedDraft(draftKey(pid, 'discussion', slug, draftKind), '');
  // Message editing: which user reply is being edited + its draft. reply_index counts only
  // user turns (matching the backend, whose transcript surfaces only kind=="reply" users).
  // The edit happens in the composer (long-press a reply → Edit), prefilled with its text.
  const editDraft = usePersistedDraft<{ replyIndex: number; draft: string } | null>(
    draftKey(pid, 'discussion', slug, 'message-edit'),
    null,
  );
  const editing = editDraft.value;
  const setEditing = editDraft.setValue;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const disabled = stream.streaming || busy;
  // See the headerHeight comment in DiscussionScreen: the library's own KeyboardAvoidingView
  // offset (insets.top alone) doesn't know about our TopBar, so the composer surfaces under
  // the keyboard without this correction.
  const insets = useSafeAreaInsets();
  const keyboardVerticalOffset = insets.top + headerHeight;
  // The library's prop is typed RefObject<TextInput> (non-null), predating React 19's
  // useRef nullability; the cast bridges that without changing runtime behavior.
  const inputRef = useRef<TextInput>(null) as RefObject<TextInput>;

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
      await api.switchBranch(pid, slug, assistantIndex, branch);
      await queryClient.invalidateQueries({ queryKey: keys.session(pid, slug) });
      // A switch can flip session_state (in_discussion <-> notes_drafted); library rows and
      // paper actions read it from project state.
      await queryClient.invalidateQueries({ queryKey: keys.projectState(pid) });
    } catch (e) {
      Alert.alert('Could not switch branch', (e as Error).message ?? 'Request failed.');
    } finally {
      setSwitchingBranch(false);
    }
  }, [pid, queryClient, slug, stream.streaming, switchingBranch]);

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
  const messages = useMemo(
    () => toDiscussionMessages(
      transcript,
      stream.pendingUser,
      stream.streaming ? stream.items : null,
      hideFromIndex,
    ),
    [transcript, stream.pendingUser, stream.streaming, stream.items, hideFromIndex],
  );

  // One composer, two persisted drafts: the in-place edit (when active) wins, otherwise the
  // lifecycle draft (reply / request-changes). Both persist until server acceptance.
  const inputText = editing ? editing.draft : textDraft.value;
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
      () => editDraft.clear(null),
    );
  }

  async function send() {
    const t = textDraft.value.trim();
    if (!t) return;
    await textDraft.markSubmitted(acceptedDrafts.length);
    await stream.run(
      paths.reply,
      { slug, text: t, model: selectedModel ?? undefined },
      t,
      () => textDraft.clear(''),
    );
  }

  async function requestChanges() {
    const t = textDraft.value.trim();
    if (!t) return;
    setActionError(null);
    await textDraft.markSubmitted(acceptedDrafts.length);
    await stream.run(
      paths.requestChanges,
      { slug, text: t, model: selectedModel ?? undefined },
      undefined,
      () => textDraft.clear(''),
    );
  }

  // Regenerate an assistant turn (optionally with a different model), from its per-message
  // overflow menu. Uses the already-implemented retry_job/RetryReq — this is its first mobile
  // caller. No optimistic user bubble: nothing new is "said" by the user for a retry.
  const canRetry = state !== 'committed';
  const handleRetry = useCallback((assistantIndex: number, model?: string) => {
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
    void stream.run(paths.retry, { slug, assistant_index: assistantIndex, model });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.retry, slug, state, stream.run, transcript]);

  async function reopen() {
    setBusy(true);
    setActionError(null);
    try {
      await api.reopen(pid, slug);
      onMutated();
    } catch (e) {
      setActionError((e as Error).message ?? 'Could not reopen the discussion.');
    } finally {
      setBusy(false);
    }
  }

  const handleSend = useCallback(() => {
    if (editing) void submitEdit();
    else if (state === 'notes_drafted') void requestChanges();
    else void send();
    // The handlers close over draft state; deps list the state they read. stream.run is a
    // dep because it captures the delivery mode — omitting it would send with a stale mode
    // after toggling Listening. selectedModel is a dep for the same reason — omitting it sent
    // a stale (or no) model override whenever the pill was picked after the last keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, state, textDraft.value, transcript, acceptedDrafts.length, stream.run, selectedModel]);

  // Long-press a message for its actions (copy everywhere; edit on user replies; the full
  // under-response row — Listen, Retry, Retry-with-model — on assistant responses, U.12: the
  // menu is a shortcut to the same actions, not a different set). Rendered through the app's
  // own OptionsSheet — the native action sheet ignores the design language (polish plan F.5:
  // OptionsSheet is the only menu idiom anywhere in the app).
  const audio = useAudio();
  const [msgMenu, setMsgMenu] = useState<SheetOption[] | null>(null);
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
      const audioId = branchAudioId(pid, slug, entry);
      options.push({
        key: 'listen',
        title: audio.currentId === audioId ? 'Pause / resume' : 'Listen',
        icon: 'headphones',
        onPress: () => void audio.playText({ id: audioId, title, text: entry.canonical }),
      });
      if (!stream.streaming && canRetry) {
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
            onPress: () => handleRetry(entry.assistant_index, m.id),
          });
        }
      }
    }
    setMsgMenu(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, state, stream.streaming, transcript, audio.currentId, audio.playText, favorites, handleRetry, pid, slug, title]);

  // A persisted edit can outlive its window (e.g. the notes were committed from another
  // device while an edit draft sat here). Committed state has no composer to show or cancel
  // it, so drop it rather than stranding an invisible editing mode.
  useEffect(() => {
    if (state === 'committed' && editing) void editDraft.clear(null);
  }, [editDraft.clear, editing, state]);

  const renderMessageText = useCallback((props: MessageTextProps<DiscussionMessage>) => {
    const msg = props.currentMessage;
    if (msg?.streamItems) return <StreamingTurnBody items={msg.streamItems} />;
    if (msg?.entry?.role === 'assistant') {
      return (
        <AssistantBody
          entry={msg.entry}
          audioId={branchAudioId(pid, slug, msg.entry)}
          title={title}
          favorites={favorites}
          onRetry={handleRetry}
          canRetry={canRetry}
          onSwitchBranch={handleSwitchBranch}
          switchDisabled={switchingBranch || stream.streaming}
        />
      );
    }
    return (
      <MessageText
        {...props}
        // Zero the library's own container margin (MessageText.js: marginVertical: 5,
        // marginHorizontal: 10) so userText's padding is the only inset — otherwise the two
        // stack and user text sits at a different inset than assistantBody's.
        containerStyle={{ left: ZERO_INSET, right: ZERO_INSET }}
        textStyle={{ left: styles.userText, right: styles.userText }}
      />
    );
  }, [pid, slug, title, favorites, handleRetry, canRetry, handleSwitchBranch, switchingBranch, stream.streaming, styles]);

  const renderBubble = useCallback((props: BubbleProps<DiscussionMessage>) => (
    <Bubble
      {...props}
      wrapperStyle={{ left: styles.analystBubble, right: styles.userBubble }}
    />
  ), [styles]);

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
    const canSend = !!inputText.trim() && !disabled;
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
  }, [disabled, editing, handleSend, inputText, state, stream.streaming, stream.stop, styles, theme]);

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
    if (state === 'notes_drafted') {
      return (
        <View style={styles.accessoryCol}>
          {actionError ? (
            <Text variant="caption" color={theme.danger}>{actionError}</Text>
          ) : null}
          <View style={styles.accessoryRow}>
            {inputText.trim() ? (
              <Button title="Request changes" variant="ghost" onPress={handleSend} disabled={disabled} style={{ flex: 1 }} />
            ) : (
              <Button title="Reopen" variant="ghost" onPress={() => void reopen()} loading={busy} disabled={disabled} style={{ flex: 1 }} />
            )}
            <Button
              title="Review & commit"
              onPress={() => setReviewOpen(true)}
              loading={busy}
              disabled={disabled || !!inputText.trim()}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      );
    }
    // "Finish reading" lives in the kebab menu only (polish plan H.1) — no composer chip.
    return null;
  }, [actionError, busy, disabled, editing, handleSend, inputText, state, styles, theme, editDraft.clear, reopen]);

  const renderInputToolbar = useCallback((props: InputToolbarProps<DiscussionMessage>) => {
    if (state === 'committed') {
      // Committed is a resting point, not a dead end (polish plan H.2): the quiet inline
      // affordance reopens the composer; the same action lives in the kebab menu.
      return (
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
      );
    }
    return (
      <InputToolbar
        {...props}
        containerStyle={styles.toolbar}
        renderSend={renderSend}
        renderAccessory={renderAccessory}
      />
    );
  }, [onContinue, renderAccessory, renderSend, state, styles]);

  const renderChatFooter = useCallback(() => {
    if (!stream.error) return null;
    return (
      <Card style={styles.errorCard}>
        <Text variant="body" color={theme.danger}>{stream.error}</Text>
        <Button title="Dismiss" variant="ghost" onPress={stream.clearError} style={{ marginTop: space.sm }} />
      </Card>
    );
  }, [stream.clearError, stream.error, styles, theme]);

  const placeholder = editing
    ? 'Edit your message…'
    : state === 'notes_drafted'
      ? 'Request changes to the draft…'
      : 'Reply';

  return (
    <>
    <Chat<DiscussionMessage>
      messages={messages}
      user={DISCUSSION_USER}
      text={inputText}
      textInputRef={inputRef}
      textInputProps={{
        onChangeText,
        editable: !disabled,
        placeholder,
        placeholderTextColor: theme.muted,
        style: styles.composerInput,
      }}
      colorScheme={themeName === 'light' ? 'light' : 'dark'}
      disableKeyboardProvider
      keyboardAvoidingViewProps={{ keyboardVerticalOffset }}
      isScrollToBottomEnabled
      // The library's default is a bare "V" text glyph on a white circle — restyle it into
      // the app's circular icon-button idiom.
      scrollToBottomComponent={() => <Icon name="chevron-down" size={18} color={theme.mint} />}
      scrollToBottomContentStyle={styles.scrollToBottomBtn}
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
      }}
      {...ROW_STYLES_PROP}
    />
    <OptionsSheet
      visible={!!msgMenu}
      onClose={() => setMsgMenu(null)}
      options={msgMenu ?? []}
    />
    <NotesReviewSheet
      visible={reviewOpen}
      pid={pid}
      slug={slug}
      onClose={() => setReviewOpen(false)}
      onCommitted={() => { setReviewOpen(false); onMutated(); }}
    />
    </>
  );
}

// ---------- compose-first ----------

// Interpret a pasted source string: an arXiv link or bare id resolves by id (an /abs/ page
// isn't a PDF, so never fetch it as one); any other URL is treated as a direct PDF link.
function parseSource(s: string): { arxiv_id?: string; pdf_url?: string } {
  const arxiv = s.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
  if (arxiv) return { arxiv_id: arxiv[1] };
  if (/^https?:\/\//i.test(s)) return { pdf_url: s };
  return { arxiv_id: s };
}

function ComposeFirst({
  pid,
  slug,
  title,
  stream,
  chatStartPath,
  initialSource,
  sessionState,
  selectedModel,
}: {
  pid: string;
  slug: string;
  title: string;
  stream: ReturnType<typeof useStreamingTurn>;
  chatStartPath: string;
  initialSource?: string;
  sessionState: string | null;
  selectedModel: string | null;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const opening = useOpeningDraft(pid, slug);
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
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  // When automatic retrieval is unsure or fails, we surface candidate matches and/or let the
  // user supply a source directly (a PDF/arXiv URL, or an arXiv id).
  const [candidates, setCandidates] = useState<SourceCandidate[] | null>(null);
  const manualSource = sourceDraft.value;
  const setManualSource = sourceDraft.setValue;
  // Every Reading Mode is a visible prompt template. Customize Prompt is a peer template
  // that exposes the complete composed prompt and deliberately applies no hidden mode layer.
  const [template, setTemplate] = useState<OpeningTemplateKey>('balanced');
  const presetPrompt = template === 'custom'
    ? ''
    : opening.data?.templates?.[template] ?? opening.data?.prompt ?? '';
  const prompt = template === 'custom' ? customPrompt : presetPrompt;
  // Live retrieval steps ("resolving on arXiv…", the PDF-hunt agent's tool calls) so the user
  // sees what's happening during a fetch instead of an opaque spinner.
  const [steps, setSteps] = useState<{ name: string; detail: string }[]>([]);

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

  function selectTemplate(next: OpeningTemplateKey) {
    if (next === 'custom' && !promptDraft.hasDraft) {
      setCustomPrompt(prompt || opening.data?.prompt || '');
    }
    setTemplate(next);
  }

  async function start(source?: { arxiv_id?: string; pdf_url?: string }, sourceText?: string) {
    setStarting(true);
    setRetrieveError(null);
    setSteps([]);
    try {
      if (sourceText) await sourceDraft.markSubmitted();
      let ok = false;
      await streamPost<StartStreamEvent>(streamPaths(pid).paperStart, { slug, ...source }, {
        onEvent: (ev) => {
          if (ev.type === 'step') {
            setSteps((prev) => [...prev, { name: ev.name, detail: ev.detail }]);
          } else if (ev.type === 'needs_confirmation') {
            setCandidates((ev.candidates as SourceCandidate[]) ?? []);
            setRetrieveError('Couldn’t confidently match this paper. Pick a source below, or paste a PDF/arXiv link.');
          } else if (ev.type === 'error') {
            setRetrieveError(ev.detail);
          } else if (ev.type === 'done') {
            ok = true;
          }
        },
      });
      if (!ok) return;
      if (sourceText) await sourceDraft.clear('');
      setCandidates(null);
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
      setRetrieveError((e as Error).message ?? 'Could not fetch the paper.');
    } finally {
      setStarting(false);
      setSteps([]);
    }
  }

  // The "provide a PDF link / arXiv id" fallback when auto-retrieval can't find the paper.
  function startFromManual() {
    const s = manualSource.trim();
    if (!s) return;
    void start(parseSource(s), s);
  }

  if (opening.isLoading) return <Centered loading />;

  if (stream.streaming) {
    // The opening turn streams without the composer, so Stop needs its own affordance here
    // (polish plan F.1 — every streaming turn must be stoppable).
    return (
      <View style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.streamingOnly}>
          <Card style={styles.assistantCard}>
            <StreamingTurnBody items={stream.items} />
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
      <ScrollView contentContainerStyle={styles.composeFirst} keyboardShouldPersistTaps="handled">
        {/* Hero card (Figma `09 · Start Reading`): status chip + editorial title. */}
        <Card style={styles.heroCard}>
          <Chip label="Unread paper" dot={false} />
          <Text variant="editorial">{title}</Text>
          <Text variant="body" color={t.muted}>
            The analyst will fetch the paper and open with a comprehensive first read.
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
                description={option.description}
                icon={option.icon}
                selected={template === option.key}
                onPress={() => selectTemplate(option.key)}
              />
            ))}
          </View>
        </View>
        {retrieveError ? (
          <Text variant="body" color={t.danger} style={{ marginTop: space.md }}>
            {retrieveError}
          </Text>
        ) : null}
        {starting && steps.length ? (
          <View style={[styles.toolTrail, { marginTop: space.md }]}>
            {steps.map((s, i) => (
              <ToolLine key={i} name={s.name} detail={s.detail} />
            ))}
          </View>
        ) : null}

        {template === 'custom' ? (
          <View style={{ marginTop: space.lg }}>
            <Text variant="overline">Opening prompt</Text>
            <Text variant="caption" style={{ marginBottom: space.sm, marginTop: space.xs }}>
              Edit how the analyst should begin. The paper text is fetched when you start.
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

        {candidates && candidates.length ? (
          <Card style={{ marginTop: space.lg, gap: space.sm }}>
            <Text variant="heading">Source candidates</Text>
            {candidates.map((c) => (
              <Pressable
                key={c.arxiv_id}
                onPress={() => void start({ arxiv_id: c.arxiv_id })}
                disabled={starting}
                style={({ pressed }) => [styles.candidate, pressed && { opacity: 0.8 }]}>
                <Text variant="body" numberOfLines={2}>{c.title}</Text>
                <Text variant="caption" color={t.muted}>arXiv:{c.arxiv_id}</Text>
              </Pressable>
            ))}
          </Card>
        ) : null}

        {/* Manual source fallback — surfaced when retrieval needs help (error/candidates) or
            the user opened customization; hidden on the clean default path. */}
        {retrieveError || candidates?.length || template === 'custom' ? (
        <View style={{ marginTop: space.lg }}>
          <Text variant="overline">Provide a source</Text>
          <Text variant="caption" color={t.muted} style={{ marginTop: space.xs, marginBottom: space.sm }}>
            Paste a PDF link or an arXiv id if the paper can’t be found automatically.
          </Text>
          <TextInput
            value={manualSource}
            onChangeText={setManualSource}
            style={styles.searchInput}
            placeholder="https://…/paper.pdf  or  2501.01005"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            title="Fetch from this source"
            variant="ghost"
            onPress={startFromManual}
            disabled={!manualSource.trim() || !prompt.trim() || starting}
            style={{ marginTop: space.sm }}
          />
        </View>
        ) : null}
      </ScrollView>

      {/* Sticky primary action; prompt customization is one of the Reading Mode choices. */}
      <View style={styles.startFooter}>
        <Button
          title={starting ? 'Fetching paper…' : 'Start reading'}
          onPress={() => void start(
            initialSource ? parseSource(initialSource) : undefined,
            initialSource,
          )}
          loading={starting}
          disabled={!prompt.trim()}
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
  audioId,
  title,
  favorites,
  onRetry,
  canRetry,
  onSwitchBranch,
  switchDisabled,
}: {
  entry: Extract<TranscriptEntry, { role: 'assistant' }>;
  audioId: string;
  title: string;
  favorites: FavoriteModel[];
  onRetry: (assistantIndex: number, model?: string) => void;
  canRetry: boolean;
  onSwitchBranch: (assistantIndex: number, branch: number) => void;
  switchDisabled: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
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
      onPress: () => onRetry(entry.assistant_index, m.id),
    })),
  ];

  // R6.7 — a turn generated by a non-default model (cross-model retry) carries entry.model;
  // show a subtle badge with the friendly favorite label when we have one.
  const modelLabel = entry.model
    ? favorites.find((m) => m.id === entry.model)?.label ?? entry.model.split('/').pop() ?? entry.model
    : null;

  return (
    <View style={styles.assistantBody}>
      {entry.agent_trail && entry.agent_trail.length > 0 ? (
        <AgentTrail trail={entry.agent_trail} />
      ) : null}
      <Markdown text={canonical} />
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
        {canRetry ? (
          <MsgAction
            icon="rotate-ccw"
            label="Retry"
            onPress={() => setRetryMenu(true)}
            accessibilityLabel="Retry this response, optionally with a different model"
          />
        ) : null}
      </View>
      <OptionsSheet
        visible={retryMenu}
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
  return <Markdown text={useSmoothText(text)} />;
}

// The live assistant turn: text runs and tool invocations rendered in arrival order, so tool
// activity is interleaved with the response ("…answer so far… → 🔎 Searching → …more…") the way
// agent UIs conventionally show it — rather than pinning all tools above all text. The streamed
// Before text or a tool arrives, the shared activity component makes the pending response
// explicit without exposing internal model-state language.
function StreamingTurnBody({ items }: { items: StreamItem[] }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const visibleItems = items.filter((item) => item.kind === 'tool' || item.text.trim().length > 0);
  if (visibleItems.length === 0) {
    return <AgentActivity status="Preparing a response…" testID="assistant-activity" />;
  }
  return (
    <View style={styles.assistantBody}>
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

function Centered({ text, loading }: { text?: string; loading?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.centered}>
      {loading ? <ActivityIndicator color={t.mint} /> : <Text variant="body" color={t.muted}>{text}</Text>}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  composeFirst: { padding: space.md },
  promptTemplates: { gap: space.sm, marginTop: space.md },
  streamingOnly: { padding: space.md, paddingBottom: space.xl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  candidate: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    padding: space.md,
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
    fontSize: 15,
  },
  promptInput: {
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    padding: space.md,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
    minHeight: 160,
    textAlignVertical: 'top',
    lineHeight: 22,
  },
  // ---- thread ----
  messagesContainer: { backgroundColor: t.bg },
  assistantCard: { backgroundColor: t.surface },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    marginTop: space.sm,
  },
  assistantBody: { paddingHorizontal: space.md, paddingVertical: space.sm },
  // Full-width bands (see FULL_WIDTH_ROW): no left/right radius asymmetry or side margin —
  // those read as "floating chat bubble" cues that don't make sense once the tinted card
  // reaches both screen edges. A top/bottom border is enough to separate turns.
  analystBubble: {
    backgroundColor: t.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: t.line,
    // Bubble's own base style sets borderRadius: 15 (lib/Bubble/styles.js) — zero it, or a
    // full-width band shows rounded notches against both screen edges.
    borderRadius: 0,
  },
  userBubble: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.lg,
    borderBottomRightRadius: 6,
  },
  userText: {
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15.5,
    lineHeight: 24,
    // MessageText's own margin is zeroed (ZERO_INSET) so this padding is the only inset,
    // matching assistantBody's — otherwise the two insets would stack.
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  msgActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.lg,
    marginTop: space.md,
    alignItems: 'center',
  },
  msgAction: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32 },
  toolTrail: {
    gap: space.xs,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginBottom: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.elevated,
  },
  thoughtLine: { fontStyle: 'italic', paddingLeft: space.sm },
  errorCard: { borderColor: t.danger, margin: space.md },
  // Overrides the library's white default circle (its content is our Icon; see
  // scrollToBottomComponent) into the app's circular icon-button idiom.
  scrollToBottomBtn: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    elevation: 0,
    shadowOpacity: 0,
  },
  // ---- toolbar ----
  toolbar: {
    borderTopWidth: 0,
    backgroundColor: t.bg,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
  },
  composerInput: {
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
    // The library's min/maxComposerHeight props are dead in 4.1.0 (typed but unread), so
    // the height bounds live on the input style itself.
    minHeight: 46,
    maxHeight: 120,
    // The pill composer from Figma 08a: the input itself carries the rounded elevated
    // surface, since the library's composer container isn't styleable from here.
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    // FIXED radius = half the single-line height: the resting state still reads as a pill,
    // but a grown multiline input keeps the same 23px corners instead of pill-rounding to
    // half its new height — which curved into the text area and visually clipped lines
    // (device-pass finding, U.13).
    borderRadius: 23,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  committedBar: {
    borderTopWidth: 1,
    borderTopColor: t.line,
    padding: space.md,
    paddingBottom: space.lg,
    backgroundColor: t.bg,
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
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: space.sm,
    marginBottom: 4,
  },
  sendBtnDisabled: { backgroundColor: t.elevated },
  // ---- compose-first (Start Reading) ----
  heroCard: { gap: space.md, alignItems: 'flex-start' },
  startFooter: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: t.line,
    backgroundColor: t.bg,
  },
});
