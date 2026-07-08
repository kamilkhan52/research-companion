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

import { ActionSheetProvider, useActionSheet } from '@expo/react-native-action-sheet';
import {
  Bubble,
  Chat,
  InputToolbar,
  MessageText,
  type BubbleProps,
  type IChatContext,
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
import { useIsPlaying } from 'react-native-track-player';

import * as Clipboard from 'expo-clipboard';

import * as api from '@/api/endpoints';
import { streamPaths, turnJobPaths } from '@/api/endpoints';
import { useAddPaper, useFavoriteModels, useOpeningDraft, useSession, useSettings } from '@/api/queries';
import { keys } from '@/api/queries';
import { streamPost } from '@/api/stream';
import type { ChatJob, FavoriteModel, StartStreamEvent, StreamItem, TranscriptEntry } from '@/api/types';
import { useAudio } from '@/audio/AudioProvider';
import { messageAudioId, useListeningHandoffRecovery } from '@/audio/identity';
import { isHandoffEligible } from '@/audio/handoffState';
import { usePreviewCues } from '@/audio/usePreviewCues';
import {
  toDiscussionMessages,
  DISCUSSION_USER,
  type DiscussionMessage,
} from '@/components/chat/discussionMessages';
import { LinkHandlerContext, Markdown, type LinkHandler } from '@/components/Markdown';
import { GeneratingBar } from '@/components/NarrationTranscript';
import { RelatedWorksSheet } from '@/components/RelatedWorksSheet';
import { IconButton, TopBar } from '@/components/TopBar';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { useSmoothText } from '@/hooks/useSmoothText';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';
import { useActiveProject } from '@/store/project';
import { useListeningMode } from '@/store/listening';
import { Button, Card, Screen, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

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
const FULL_WIDTH_ROW_PROP = {
  containerStyle: { left: FULL_WIDTH_ROW, right: FULL_WIDTH_ROW } as LeftRightStyle<ViewStyle>,
};

export default function DiscussionScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  // `source` (optional) carries a pasted arXiv id / PDF link from the Discover screen's
  // "specific paper" box, so the first fetch uses exactly that source.
  const { slug, source } = useLocalSearchParams<{ slug: string; source?: string }>();
  const { activePid } = useActiveProject();
  const pid = activePid;
  const addPaper = useAddPaper(pid ?? '');

  // Reference links in a response: in-project papers arrive as `rc-paper:<slug>` and jump
  // straight into that paper's discussion; external references (a URL/arXiv link) prompt to open
  // the source or add it to the reading list.
  const handleReferenceLink = useCallback<LinkHandler>((href, label) => {
    if (href.startsWith('rc-paper:')) {
      const s = href.slice('rc-paper:'.length);
      if (s) router.push(`/paper/${encodeURIComponent(s)}`);
      return;
    }
    if (!/^https?:\/\//i.test(href)) return;
    const arxiv = href.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
    Alert.alert(label || 'External reference', href, [
      { text: 'Open link', onPress: () => void Linking.openURL(href).catch(() => undefined) },
      {
        text: 'Add to reading list',
        onPress: () => {
          if (!pid) return;
          void addPaper.mutateAsync({
            title: label || href,
            arxivId: arxiv ? arxiv[1] : undefined,
          }).catch(() => undefined);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [addPaper, pid, router]);

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
        id: messageAudioId(pid, slug, job.assistant_index),
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

  async function draftNotesFromMenu() {
    if (!paths || !slug) return;
    await stream.run(paths.finish, { slug, model: selectedModel ?? undefined });
  }

  return (
    <LinkHandlerContext.Provider value={handleReferenceLink}>
    <ActionSheetProvider>
    <Screen edges={['top']}>
      <TopBar
        title={session.data?.paper.title ?? 'Discussion'}
        subtitle={state ? STATE_LABEL[state] : undefined}
        onBack={() => router.back()}
        right={
          <>
            <ModelPill
              label={selectedModel ?? settings.data?.model ?? 'Default'}
              favorites={favoriteModels.data ?? []}
              onPick={setSelectedModel}
            />
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
              showDraftNotes={hasSession && state !== 'notes_drafted' && state !== 'committed'}
              draftNotesDisabled={stream.streaming}
              onDraftNotes={() => void draftNotesFromMenu()}
            />
          </>
        }
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
          onMutated={() => {
            qc.invalidateQueries({ queryKey: keys.session(pid, slug!) });
            qc.invalidateQueries({ queryKey: keys.projectState(pid) });
          }}
        />
      )}
    </Screen>
    </ActionSheetProvider>
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

// The single ⋯ overflow trigger for every discussion-level action that isn't the composer
// itself: Listening toggle, notes/related-works/graph navigation, and (moved from the
// composer) Draft notes. Requires an ActionSheetProvider ancestor (wrapping the whole screen).
function OverflowMenu({
  listeningMode,
  onToggleListening,
  hasNotes,
  onViewNotes,
  onRelatedWorks,
  onGraph,
  showDraftNotes,
  draftNotesDisabled,
  onDraftNotes,
}: {
  listeningMode: boolean;
  onToggleListening: () => void;
  hasNotes: boolean;
  onViewNotes: () => void;
  onRelatedWorks: () => void;
  onGraph: () => void;
  showDraftNotes: boolean;
  draftNotesDisabled: boolean;
  onDraftNotes: () => void;
}) {
  const { showActionSheetWithOptions } = useActionSheet();

  function open() {
    const options: string[] = [listeningMode ? 'Turn off Listening mode' : 'Turn on Listening mode'];
    const actions: (() => void)[] = [onToggleListening];
    if (hasNotes) {
      options.push('View notes');
      actions.push(onViewNotes);
    }
    options.push('Related works');
    actions.push(onRelatedWorks);
    options.push('Reference graph');
    actions.push(onGraph);
    let draftNotesIndex = -1;
    if (showDraftNotes) {
      draftNotesIndex = options.length;
      options.push('Draft notes →');
      actions.push(onDraftNotes);
    }
    const cancelButtonIndex = options.length;
    options.push('Cancel');
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex,
        disabledButtonIndices: draftNotesIndex >= 0 && draftNotesDisabled ? [draftNotesIndex] : undefined,
      },
      (i) => {
        if (i == null || i === cancelButtonIndex) return;
        actions[i]?.();
      },
    );
  }

  return <IconButton glyph="⋯" onPress={open} accessibilityLabel="More actions" />;
}

// A compact pill showing the model the *next* new response will use; tapping picks a one-shot
// override for this screen only (never persisted — see the `selectedModel` comment above).
function ModelPill({
  label,
  favorites,
  onPick,
}: {
  label: string;
  favorites: FavoriteModel[];
  onPick: (modelId: string | null) => void;
}) {
  const { showActionSheetWithOptions } = useActionSheet();

  function open() {
    const options = ['Use default', ...favorites.map((m) => m.label), 'Cancel'];
    const cancelButtonIndex = options.length - 1;
    showActionSheetWithOptions({ options, cancelButtonIndex }, (i) => {
      if (i == null || i === cancelButtonIndex) return;
      onPick(i === 0 ? null : favorites[i - 1].id);
    });
  }

  return (
    <Pressable
      onPress={open}
      style={styles.modelPill}
      accessibilityLabel={`Model for the next response: ${label}. Tap to change.`}>
      <Text variant="caption" color={colors.cyan} numberOfLines={1} style={styles.modelPillText}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------- the thread (library chat + lifecycle toolbar) ----------

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
  onMutated: () => void;
}) {
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
  const disabled = stream.streaming || busy;
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

  const messages = useMemo(
    () => toDiscussionMessages(
      transcript,
      stream.pendingUser,
      stream.streaming ? stream.items : null,
    ),
    [transcript, stream.pendingUser, stream.streaming, stream.items],
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
      { slug, reply_index: replyIndex, text },
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
  const handleRetry = useCallback((assistantIndex: number, model?: string) => {
    void stream.run(paths.retry, { slug, assistant_index: assistantIndex, model });
  }, [paths.retry, slug, stream.run]);

  async function approve() {
    setBusy(true);
    setActionError(null);
    try {
      await api.approve(pid, slug);
      onMutated();
    } catch (e) {
      setActionError((e as Error).message ?? 'Could not commit the notes.');
    } finally {
      setBusy(false);
    }
  }

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
    // after toggling Listening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, state, textDraft.value, transcript, acceptedDrafts.length, stream.run]);

  // Long-press a message for its actions (copy everywhere; edit on user replies).
  const onLongPressMessage = useCallback((context: unknown, message: DiscussionMessage) => {
    const entry = message.entry;
    if (!entry) return;
    const sheet = (context as IChatContext | undefined)?.actionSheet?.();
    if (!sheet) return;
    const copyText = entry.role === 'user' ? entry.text : entry.canonical;
    // No editing once committed: that state's toolbar has no composer, so an edit could
    // neither be typed nor cancelled (reopen the discussion instead).
    const canEdit =
      entry.role === 'user' &&
      state !== 'committed' &&
      !stream.streaming &&
      !editing &&
      message.replyIndex != null;
    const options = canEdit ? ['Copy', 'Edit & regenerate', 'Cancel'] : ['Copy', 'Cancel'];
    sheet.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1 },
      (i?: number) => {
        if (i === 0) void Clipboard.setStringAsync(copyText);
        else if (i === 1 && canEdit) {
          startEdit(message.replyIndex!, entry.text, message.transcriptIndex!);
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, state, stream.streaming, transcript]);

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
          audioId={messageAudioId(pid, slug, msg.entry.assistant_index)}
          title={title}
          favorites={favorites}
          onRetry={handleRetry}
        />
      );
    }
    return (
      <MessageText
        {...props}
        textStyle={{ left: styles.userText, right: styles.userText }}
      />
    );
  }, [pid, slug, title, favorites, handleRetry]);

  const renderBubble = useCallback((props: BubbleProps<DiscussionMessage>) => (
    <Bubble
      {...props}
      wrapperStyle={{ left: styles.analystBubble, right: styles.userBubble }}
    />
  ), []);

  const renderSend = useCallback(() => {
    if (state === 'notes_drafted' && !editing) return null;
    const canSend = !!inputText.trim() && !disabled;
    return (
      <Pressable
        onPress={handleSend}
        disabled={!canSend}
        style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
        accessibilityLabel={editing ? 'Save edit and regenerate' : 'Send'}>
        <Text variant="heading" color={canSend ? colors.cyanInk : colors.muted}>
          {editing ? '↻' : '↑'}
        </Text>
      </Pressable>
    );
  }, [disabled, editing, handleSend, inputText, state]);

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
            <Text variant="caption" color={colors.danger}>{actionError}</Text>
          ) : null}
          <View style={styles.accessoryRow}>
            {inputText.trim() ? (
              <Button title="Request changes" variant="ghost" onPress={handleSend} disabled={disabled} style={{ flex: 1 }} />
            ) : (
              <Button title="Reopen" variant="ghost" onPress={() => void reopen()} loading={busy} disabled={disabled} style={{ flex: 1 }} />
            )}
            <Button
              title="Approve & commit"
              onPress={() => void approve()}
              loading={busy}
              disabled={disabled || !!inputText.trim()}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      );
    }
    // Draft notes lives in the top-bar overflow menu now; the default in_discussion composer
    // has nothing extra to show below Send.
    return null;
  }, [actionError, busy, disabled, editing, handleSend, inputText, state]);

  const renderInputToolbar = useCallback((props: InputToolbarProps<DiscussionMessage>) => {
    if (state === 'committed') {
      return (
        <View style={styles.committedBar}>
          <Text variant="caption" style={{ textAlign: 'center' }}>
            Notes committed to this project's record.
          </Text>
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
  }, [renderAccessory, renderSend, state]);

  const renderChatFooter = useCallback(() => {
    if (!stream.error) return null;
    return (
      <Card style={styles.errorCard}>
        <Text variant="body" color={colors.danger}>{stream.error}</Text>
        <Button title="Dismiss" variant="ghost" onPress={stream.clearError} style={{ marginTop: space.sm }} />
      </Card>
    );
  }, [stream.clearError, stream.error]);

  const placeholder = editing
    ? 'Edit your message…'
    : state === 'notes_drafted'
      ? 'Request changes to the draft…'
      : 'Reply…';

  return (
    <Chat<DiscussionMessage>
      messages={messages}
      user={DISCUSSION_USER}
      text={inputText}
      textInputRef={inputRef}
      textInputProps={{
        onChangeText,
        editable: !disabled,
        placeholder,
        placeholderTextColor: colors.muted,
        style: styles.composerInput,
      }}
      colorScheme="dark"
      disableKeyboardProvider
      isScrollToBottomEnabled
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
      listProps={{ keyboardShouldPersistTaps: 'handled' }}
      {...FULL_WIDTH_ROW_PROP}
    />
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
  stream,
  chatStartPath,
  initialSource,
  sessionState,
  selectedModel,
}: {
  pid: string;
  slug: string;
  stream: ReturnType<typeof useStreamingTurn>;
  chatStartPath: string;
  initialSource?: string;
  sessionState: string | null;
  selectedModel: string | null;
}) {
  const opening = useOpeningDraft(pid, slug);
  const promptDraft = usePersistedDraft(
    draftKey(pid, 'discussion', slug, 'opening'),
    opening.data?.prompt ?? '',
  );
  const sourceDraft = usePersistedDraft(
    draftKey(pid, 'discussion', slug, 'source'),
    initialSource ?? '',
  );
  const prompt = promptDraft.value;
  const setPrompt = promptDraft.setValue;
  const [starting, setStarting] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  // When automatic retrieval is unsure or fails, we surface candidate matches and/or let the
  // user supply a source directly (a PDF/arXiv URL, or an arXiv id).
  const [candidates, setCandidates] = useState<SourceCandidate[] | null>(null);
  const manualSource = sourceDraft.value;
  const setManualSource = sourceDraft.setValue;
  const [showCustomize, setShowCustomize] = useState(false);
  // Live retrieval steps ("resolving on arXiv…", the PDF-hunt agent's tool calls) so the user
  // sees what's happening during a fetch instead of an opaque spinner.
  const [steps, setSteps] = useState<{ name: string; detail: string }[]>([]);

  useEffect(() => {
    if (initialSource && sourceDraft.ready && !sourceDraft.hasDraft) {
      sourceDraft.setValue(initialSource);
    }
  }, [initialSource, sourceDraft.hasDraft, sourceDraft.ready, sourceDraft.setValue]);

  useEffect(() => {
    if (promptDraft.submitted && sessionState && opening.data?.prompt === promptDraft.value) {
      void promptDraft.clear(opening.data.prompt);
    }
  }, [opening.data?.prompt, promptDraft.clear, promptDraft.submitted, promptDraft.value, sessionState]);

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
      await promptDraft.markSubmitted();
      await stream.run(
        chatStartPath,
        { slug, prompt, model: selectedModel ?? opening.data?.model ?? undefined },
        undefined,
        async () => {
          await promptDraft.clear(opening.data?.prompt ?? '');
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
    return (
      <ScrollView contentContainerStyle={styles.streamingOnly}>
        <Card style={styles.assistantCard}>
          <StreamingTurnBody items={stream.items} />
        </Card>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView contentContainerStyle={styles.composeFirst} keyboardShouldPersistTaps="handled">
        {/* Default path stays clean: just Start. The opening prompt is editable, but hidden
            behind Customize so most sessions don't open on a wall of prompt text. */}
        <Text variant="body" color={colors.muted}>
          The analyst will fetch the paper and open with a comprehensive first read.
        </Text>
        {retrieveError ? (
          <Text variant="body" color={colors.danger} style={{ marginTop: space.md }}>
            {retrieveError}
          </Text>
        ) : null}
        <Button
          title={starting ? 'Fetching paper…' : 'Start reading'}
          onPress={() => void start(
            initialSource ? parseSource(initialSource) : undefined,
            initialSource,
          )}
          loading={starting}
          disabled={!prompt.trim()}
          style={{ marginTop: space.lg }}
        />
        {starting && steps.length ? (
          <View style={[styles.toolTrail, { marginTop: space.md }]}>
            {steps.map((s, i) => (
              <ToolLine key={i} name={s.name} detail={s.detail} />
            ))}
          </View>
        ) : null}
        <Button
          title={showCustomize ? 'Hide customization' : 'Customize opening prompt'}
          variant="ghost"
          onPress={() => setShowCustomize((v) => !v)}
          style={{ marginTop: space.sm }}
        />

        {showCustomize ? (
          <View style={{ marginTop: space.md }}>
            <Text variant="label">OPENING PROMPT</Text>
            <Text variant="caption" style={{ marginBottom: space.sm, marginTop: space.xs }}>
              Edit how the analyst should begin. The paper text is fetched when you start.
            </Text>
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              multiline
              style={styles.promptInput}
              placeholder="Opening prompt…"
              placeholderTextColor={colors.muted}
            />
            {opening.data?.model ? (
              <Text variant="mono" style={{ marginTop: space.sm }}>
                model: {opening.data.model}
              </Text>
            ) : null}
          </View>
        ) : null}

        {candidates && candidates.length ? (
          <View style={{ marginTop: space.lg, gap: space.sm }}>
            <Text variant="label">CANDIDATE SOURCES</Text>
            {candidates.map((c) => (
              <Pressable
                key={c.arxiv_id}
                onPress={() => void start({ arxiv_id: c.arxiv_id })}
                disabled={starting}
                style={styles.candidate}>
                <Text variant="body" numberOfLines={2}>{c.title}</Text>
                <Text variant="caption" color={colors.muted}>arXiv:{c.arxiv_id}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* Manual source fallback — surfaced when retrieval needs help (error/candidates) or
            the user opened customization; hidden on the clean default path. */}
        {retrieveError || candidates?.length || showCustomize ? (
        <View style={{ marginTop: space.lg }}>
          <Text variant="label">PROVIDE A SOURCE</Text>
          <Text variant="caption" color={colors.muted} style={{ marginTop: space.xs, marginBottom: space.sm }}>
            Paste a PDF link or an arXiv id if the paper can’t be found automatically.
          </Text>
          <TextInput
            value={manualSource}
            onChangeText={setManualSource}
            style={styles.searchInput}
            placeholder="https://…/paper.pdf  or  2501.01005"
            placeholderTextColor={colors.muted}
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
}: {
  entry: Extract<TranscriptEntry, { role: 'assistant' }>;
  audioId: string;
  title: string;
  favorites: FavoriteModel[];
  onRetry: (assistantIndex: number, model?: string) => void;
}) {
  const audio = useAudio();
  const { playing } = useIsPlaying();
  const { showActionSheetWithOptions } = useActionSheet();

  const prep = audio.prep?.id === audioId ? audio.prep : null;
  const current = audio.currentId === audioId;
  const audioError = audio.errorById[audioId] ?? entry.audio_error;
  const [copied, setCopied] = useState(false);
  const canonical = entry.canonical;

  // Listen -> prepare + play; on the loaded track it's a pause/resume toggle; after a
  // failure it retries (playText clears this message's error).
  const listenGlyph = current ? (playing ? '❚❚' : '▶︎') : audioError ? '↻' : '▶︎';
  const listenA11y = current
    ? (playing ? 'Pause this narration' : 'Resume this narration')
    : audioError ? 'Retry narration' : 'Listen to this response';

  async function copy() {
    await Clipboard.setStringAsync(canonical);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function openRetryMenu() {
    const options = ['Retry', ...favorites.map((m) => `Retry with ${m.label}`), 'Cancel'];
    const cancelButtonIndex = options.length - 1;
    showActionSheetWithOptions({ options, cancelButtonIndex }, (i) => {
      if (i == null || i === cancelButtonIndex) return;
      onRetry(entry.assistant_index, i === 0 ? undefined : favorites[i - 1].id);
    });
  }

  return (
    <View style={styles.assistantBody}>
      <Markdown text={canonical} />
      {prep ? <GeneratingBar stage={prep.stage} done={prep.done} total={prep.total} /> : null}
      {audioError ? (
        <Text variant="caption" color={colors.danger} style={{ marginTop: space.sm }}>
          Audio failed: {audioError}
        </Text>
      ) : null}
      <View style={styles.msgActions}>
        <Pressable
          onPress={() => audio.playText({ id: audioId, title, text: canonical })}
          disabled={!!prep}
          style={({ pressed }) => [styles.msgIconBtn, (pressed || current) && styles.msgBtnActive]}
          accessibilityLabel={listenA11y}>
          {prep ? (
            <ActivityIndicator color={colors.cyan} size="small" />
          ) : (
            <Text style={[styles.msgGlyph, { color: current ? colors.cyan : colors.muted }]}>
              {listenGlyph}
            </Text>
          )}
        </Pressable>
        <Pressable
          onPress={copy}
          style={({ pressed }) => [styles.msgIconBtn, (pressed || copied) && styles.msgBtnActive]}
          accessibilityLabel="Copy this response">
          <Text style={[styles.msgGlyph, { color: copied ? colors.cyan : colors.muted }]}>
            {copied ? '✓' : '⧉'}
          </Text>
        </Pressable>
        <Pressable
          onPress={openRetryMenu}
          style={({ pressed }) => [styles.msgIconBtn, pressed && styles.msgBtnActive]}
          accessibilityLabel="Retry this response, optionally with a different model">
          <Text style={[styles.msgGlyph, { color: colors.muted }]}>⟳</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Friendly label + glyph for each research tool the agent can call (agentic path).
const TOOL_META: Record<string, { glyph: string; label: string }> = {
  web_search: { glyph: '🔎', label: 'Searching the web' },
  web_fetch: { glyph: '🌐', label: 'Reading a page' },
  read_paper_text: { glyph: '📄', label: 'Reading a paper' },
  related_papers: { glyph: '🕸', label: 'Finding related papers' },
  list_project_papers: { glyph: '📚', label: 'Scanning the project' },
  // retrieval (/start_stream) steps
  arxiv: { glyph: '📚', label: 'Resolving on arXiv' },
  fetch_pdf: { glyph: '📥', label: 'Trying a PDF' },
};

function ToolLine({ name, detail }: { name: string; detail: string }) {
  const meta = TOOL_META[name] ?? { glyph: '🔧', label: name };
  return (
    <View style={styles.toolRow}>
      <Text variant="caption" color={colors.cyan}>{meta.glyph} {meta.label}</Text>
      {detail ? (
        <Text variant="caption" color={colors.muted} numberOfLines={1} style={styles.toolDetail}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

// A streamed text run revealed through the smoothing buffer (useSmoothText): the job poller
// delivers ~900ms snapshots, and this types them out continuously instead of in lumps.
function SmoothMarkdown({ text }: { text: string }) {
  return <Markdown text={useSmoothText(text)} />;
}

// The live assistant turn: text runs and tool invocations rendered in arrival order, so tool
// activity is interleaved with the response ("…answer so far… → 🔎 Searching → …more…") the way
// agent UIs conventionally show it — rather than pinning all tools above all text. A status
// row keeps naming what's happening right now (thinking / which tool / writing), so quiet
// stretches read as work in progress rather than a stall, and a one-line note says the turn
// survives leaving the screen.
function StreamingTurnBody({ items }: { items: StreamItem[] }) {
  const last = items[items.length - 1];
  const status = !last
    ? 'Thinking…'
    : last.kind === 'tool'
      ? `${(TOOL_META[last.name]?.label ?? 'Researching')}…`
      : 'Writing…';
  return (
    <View style={styles.assistantBody}>
      {items.map((it, i) =>
        it.kind === 'text' ? (
          <SmoothMarkdown key={i} text={it.text} />
        ) : (
          <View key={i} style={styles.toolTrail}>
            <ToolLine name={it.name} detail={it.detail} />
          </View>
        ),
      )}
      <View style={styles.liveStatus}>
        <ActivityIndicator color={colors.cyan} size="small" />
        <Text variant="caption">{status}</Text>
      </View>
      <Text variant="caption" color={colors.muted}>
        Keeps going in the background — safe to leave this screen.
      </Text>
    </View>
  );
}

function Centered({ text, loading }: { text?: string; loading?: boolean }) {
  return (
    <View style={styles.centered}>
      {loading ? <ActivityIndicator color={colors.cyan} /> : <Text variant="body" color={colors.muted}>{text}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  modelPill: {
    maxWidth: 108,
    height: 40,
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelPillText: { fontFamily: fonts.mono },
  composeFirst: { padding: space.md },
  streamingOnly: { padding: space.md, paddingBottom: space.xl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  candidate: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
  },
  searchInput: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
  },
  promptInput: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    padding: space.md,
    color: colors.text,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    minHeight: 160,
    textAlignVertical: 'top',
    lineHeight: 22,
  },
  // ---- thread ----
  messagesContainer: { backgroundColor: colors.bg },
  assistantCard: { backgroundColor: colors.panel },
  assistantBody: { paddingHorizontal: space.md, paddingVertical: space.sm },
  // Full-width bands (see FULL_WIDTH_ROW): no left/right radius asymmetry or side margin —
  // those read as "floating chat bubble" cues that don't make sense once the tinted card
  // reaches both screen edges. A top/bottom border is enough to separate turns.
  analystBubble: {
    backgroundColor: colors.panel,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.line,
  },
  userBubble: {
    backgroundColor: colors.panel2,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.line2,
  },
  userText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15.5,
    lineHeight: 24,
    // The library's default MessageText has no padding of its own; without this, text would
    // sit flush against the now edge-to-edge bubble borders (see FULL_WIDTH_ROW).
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  msgActions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  msgIconBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  msgGlyph: { fontSize: 17, lineHeight: 20 },
  msgBtnActive: { borderColor: colors.cyan },
  toolTrail: {
    gap: space.xs,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginBottom: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
  },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toolDetail: { flex: 1 },
  liveStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
    marginBottom: space.xs,
  },
  errorCard: { borderColor: colors.danger, margin: space.md },
  // ---- toolbar ----
  toolbar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg2,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  composerInput: {
    color: colors.text,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    // The library's min/maxComposerHeight props are dead in 4.1.0 (typed but unread), so
    // the height bounds live on the input style itself.
    minHeight: 44,
    maxHeight: 120,
  },
  committedBar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    padding: space.md,
    paddingBottom: space.lg,
    backgroundColor: colors.bg2,
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
    backgroundColor: colors.cyan,
    borderRadius: radius.pill,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: space.sm,
    marginBottom: 4,
  },
  sendBtnDisabled: { backgroundColor: colors.panel2 },
});
