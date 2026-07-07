// Discussion — the streaming chat with the analyst over one paper (or the working-notes review).
// Compose-first: edit the opening prompt, then start. Mid-discussion: reply with streaming
// responses. Wrap-up: draft notes, then approve / request changes. Turns run as server-side
// background jobs (polled, not held open), so a turn survives leaving this screen, the app
// backgrounding, or the tunnel dropping — on entry we reattach to any turn still in flight,
// and after each turn we refetch the canonical transcript the server recorded.

import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useIsPlaying } from 'react-native-track-player';

import * as Clipboard from 'expo-clipboard';

import * as api from '@/api/endpoints';
import { streamPaths, turnJobPaths } from '@/api/endpoints';
import { useOpeningDraft, useSession } from '@/api/queries';
import { keys } from '@/api/queries';
import { streamPost } from '@/api/stream';
import type { ChatJob, StartStreamEvent, StreamItem, TranscriptEntry } from '@/api/types';
import { useAudio } from '@/audio/AudioProvider';
import { messageAudioId, useListeningHandoffRecovery } from '@/audio/identity';
import { isHandoffEligible } from '@/audio/handoffState';
import { usePreviewCues } from '@/audio/usePreviewCues';
import { Markdown } from '@/components/Markdown';
import { GeneratingBar } from '@/components/NarrationTranscript';
import { RelatedWorksSheet } from '@/components/RelatedWorksSheet';
import { IconButton, TopBar } from '@/components/TopBar';
import { useSmoothText } from '@/hooks/useSmoothText';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';
import { useActiveProject } from '@/store/project';
import { useListeningMode } from '@/store/listening';
import { Button, Card, Screen, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

export default function DiscussionScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  // `source` (optional) carries a pasted arXiv id / PDF link from the Discover screen's
  // "specific paper" box, so the first fetch uses exactly that source.
  const { slug, source } = useLocalSearchParams<{ slug: string; source?: string }>();
  const { activePid } = useActiveProject();
  const pid = activePid;

  const session = useSession(pid, slug ?? null);
  const audio = useAudio();
  const { listeningMode, setListeningMode } = useListeningMode();
  const previewParentJobRef = useRef<string | null>(null);
  const handlePreviewParentJob = useCallback((jobId: string | null) => {
    previewParentJobRef.current = jobId;
  }, []);
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
    handlePreviewParentJob,
  );
  usePreviewCues({
    enabled: listeningMode,
    project: pid,
    title: session.data?.paper.title ?? 'Research update',
    jobIds: stream.previewJobIds,
    playPreview: audio.playPreview,
    parentJobRef: previewParentJobRef,
  });
  const scrollRef = useRef<ScrollView>(null);

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

  // Message editing: which user reply is being edited + its draft. reply_index counts only
  // user turns (matching the backend, whose transcript surfaces only kind=="reply" users), so
  // precompute each transcript row's reply index (-1 for assistant rows).
  const [editing, setEditing] = useState<{ replyIndex: number; draft: string } | null>(null);
  const replyIndices = useMemo(() => {
    let c = -1;
    return transcript.map((e) => (e.role === 'user' ? ++c : -1));
  }, [transcript]);
  // Mirrored into refs for the keyboard listener (registered once): whether an edit is in
  // progress, and the edited bubble's y within the scroll content (from its onLayout).
  const editingRef = useRef(false);
  const editRowYRef = useRef<number | null>(null);
  useEffect(() => {
    editingRef.current = !!editing;
    if (!editing) editRowYRef.current = null;
  }, [editing]);

  function startEdit(replyIndex: number, currentText: string, transcriptPos: number) {
    const begin = () => setEditing({ replyIndex, draft: currentText });
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

  function submitEdit() {
    if (!editing || !paths || !slug) return;
    const text = editing.draft.trim();
    if (!text) return;
    const replyIndex = editing.replyIndex;
    setEditing(null);
    void stream.run(paths.edit, { slug, reply_index: replyIndex, text }, text);
  }

  // Keep the conversation pinned to the latest content.
  useEffect(() => {
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(id);
  }, [transcript.length, stream.liveText, stream.pendingUser]);

  // When the keyboard opens for the composer, scroll to the end so the composer + latest
  // turn stay visible. When it opens for an in-place message edit, stay on (and reveal)
  // the message being edited instead of jumping to the bottom.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () =>
      setTimeout(() => {
        if (editingRef.current) {
          const y = editRowYRef.current;
          if (y != null) scrollRef.current?.scrollTo({ y: Math.max(y - space.md, 0), animated: true });
        } else {
          scrollRef.current?.scrollToEnd({ animated: true });
        }
      }, 50),
    );
    return () => sub.remove();
  }, []);

  return (
    <Screen edges={['top']}>
      <TopBar
        title={session.data?.paper.title ?? 'Discussion'}
        subtitle={state ? STATE_LABEL[state] : undefined}
        onBack={() => router.back()}
        right={
          <>
            <IconButton
              glyph="♫"
              active={listeningMode}
              onPress={() => {
                if (listeningMode) audio.cancelPrep();
                setListeningMode(!listeningMode);
              }}
              accessibilityLabel={listeningMode ? 'Turn off Listening mode' : 'Turn on Listening mode'}
            />
            {session.data?.paper.has_notes ? (
              <IconButton
                glyph="✎"
                onPress={() => slug && router.push(`/notes/${encodeURIComponent(slug)}`)}
                accessibilityLabel="View notes"
              />
            ) : null}
            <IconButton glyph="❖" onPress={() => setShowRelated(true)} accessibilityLabel="Related works" />
            <IconButton glyph="✦" onPress={() => router.push('/graph')} accessibilityLabel="Reference graph" />
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
        />
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding"
          keyboardVerticalOffset={8}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.thread}
            keyboardShouldPersistTaps="handled">
            {transcript.map((entry, i) =>
              entry.role === 'user' ? (
                <UserBubble
                  key={i}
                  text={entry.text}
                  canEdit={!stream.streaming && !editing}
                  editing={editing?.replyIndex === replyIndices[i]}
                  draft={editing?.draft ?? ''}
                  onChangeDraft={(t) => setEditing((e) => (e ? { ...e, draft: t } : e))}
                  onStartEdit={() => startEdit(replyIndices[i], entry.text, i)}
                  onCancelEdit={() => setEditing(null)}
                  onSubmitEdit={submitEdit}
                  onEditLayout={(y) => {
                    editRowYRef.current = y;
                  }}
                />
              ) : (
                <Message
                  key={i}
                  entry={entry}
                  audioId={messageAudioId(pid, slug!, entry.assistant_index)}
                  title={session.data?.paper.title ?? 'Narration'}
                />
              ),
            )}

            {stream.pendingUser ? <UserBubble text={stream.pendingUser} /> : null}
            {stream.streaming ? <StreamingAgentBubble items={stream.items} /> : null}

            {stream.error ? (
              <Card style={styles.errorCard}>
                <Text variant="body" color={colors.danger}>
                  {stream.error}
                </Text>
                <Button title="Dismiss" variant="ghost" onPress={stream.clearError} style={{ marginTop: space.sm }} />
              </Card>
            ) : null}
          </ScrollView>

          <Composer
            pid={pid}
            slug={slug!}
            state={state}
            stream={stream}
            paths={paths!}
            onMutated={() => {
              qc.invalidateQueries({ queryKey: keys.session(pid, slug!) });
              qc.invalidateQueries({ queryKey: keys.projectState(pid) });
            }}
          />
        </KeyboardAvoidingView>
      )}
    </Screen>
  );
}

const STATE_LABEL: Record<string, string> = {
  unread: 'Not started',
  retrieving: 'Fetching paper…',
  in_discussion: 'In discussion',
  notes_drafted: 'Notes drafted — review',
  committed: 'Notes committed',
};

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
}: {
  pid: string;
  slug: string;
  stream: ReturnType<typeof useStreamingTurn>;
  chatStartPath: string;
  initialSource?: string;
}) {
  const opening = useOpeningDraft(pid, slug);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  // When automatic retrieval is unsure or fails, we surface candidate matches and/or let the
  // user supply a source directly (a PDF/arXiv URL, or an arXiv id).
  const [candidates, setCandidates] = useState<SourceCandidate[] | null>(null);
  const [manualSource, setManualSource] = useState(initialSource ?? '');
  const [showCustomize, setShowCustomize] = useState(false);
  // Live retrieval steps ("resolving on arXiv…", the PDF-hunt agent's tool calls) so the user
  // sees what's happening during a fetch instead of an opaque spinner.
  const [steps, setSteps] = useState<{ name: string; detail: string }[]>([]);

  useEffect(() => {
    if (opening.data?.prompt && !prompt) setPrompt(opening.data.prompt);
  }, [opening.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(source?: { arxiv_id?: string; pdf_url?: string }) {
    setStarting(true);
    setRetrieveError(null);
    setSteps([]);
    try {
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
      setCandidates(null);
      await stream.run(chatStartPath, { slug, prompt, model: opening.data?.model ?? undefined });
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
    start(parseSource(s));
  }

  if (opening.isLoading) return <Centered loading />;

  if (stream.streaming) {
    return (
      <ScrollView contentContainerStyle={styles.thread}>
        <StreamingAgentBubble items={stream.items} />
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
          onPress={() => start(initialSource ? parseSource(initialSource) : undefined)}
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
                onPress={() => start({ arxiv_id: c.arxiv_id })}
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

// ---------- composer (state-dependent input + actions) ----------

function Composer({
  pid,
  slug,
  state,
  stream,
  paths,
  onMutated,
}: {
  pid: string;
  slug: string;
  state: string | null;
  stream: ReturnType<typeof useStreamingTurn>;
  paths: ReturnType<typeof turnJobPaths>;
  onMutated: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const disabled = stream.streaming || busy;

  async function send() {
    const t = text.trim();
    if (!t) return;
    setText('');
    await stream.run(paths.reply, { slug, text: t }, t);
  }

  async function draftNotes() {
    await stream.run(paths.finish, { slug });
  }

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

  function requestChanges() {
    const t = text.trim();
    if (!t) return;
    setText('');
    setActionError(null);
    void stream.run(paths.requestChanges, { slug, text: t });
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

  if (state === 'committed') {
    return (
      <View style={styles.composerBar}>
        <Text variant="caption" style={{ textAlign: 'center', flex: 1 }}>
          Notes committed to this project's record.
        </Text>
      </View>
    );
  }

  if (state === 'notes_drafted') {
    return (
      <View style={styles.composerBar}>
        {actionError ? (
          <Text variant="caption" color={colors.danger} style={{ marginBottom: space.sm }}>
            {actionError}
          </Text>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Request changes to the draft…"
          placeholderTextColor={colors.muted}
          style={styles.input}
          multiline
          editable={!disabled}
        />
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          {text.trim() ? (
            <Button title="Request changes" variant="ghost" onPress={requestChanges} disabled={disabled} style={{ flex: 1 }} />
          ) : (
            <Button title="Reopen" variant="ghost" onPress={reopen} loading={busy} disabled={disabled} style={{ flex: 1 }} />
          )}
          <Button title="Approve & commit" onPress={approve} loading={busy} disabled={disabled || !!text.trim()} style={{ flex: 1 }} />
        </View>
      </View>
    );
  }

  // in_discussion (default)
  return (
    <View style={styles.composerBar}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Reply…"
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 1 }]}
          multiline
          editable={!disabled}
        />
        <Button title="Send" onPress={send} disabled={disabled || !text.trim()} style={styles.sendBtn} />
      </View>
      <Button
        title="Draft notes →"
        variant="ghost"
        onPress={draftNotes}
        disabled={disabled}
        style={{ marginTop: space.sm }}
      />
    </View>
  );
}

// ---------- messages ----------

function Message({ entry, audioId, title }: { entry: TranscriptEntry; audioId: string; title: string }) {
  const audio = useAudio();
  const { playing } = useIsPlaying();
  if (entry.role === 'user') return <UserBubble text={entry.text} />;

  const prep = audio.prep?.id === audioId ? audio.prep : null;
  const current = audio.currentId === audioId;
  const audioError = audio.errorById[audioId] ?? entry.audio_error;
  const [copied, setCopied] = useState(false);
  const canonical = entry.canonical;

  // Listen -> prepare + play; on the loaded track it's a pause/resume toggle; after a
  // failure it retries (playText clears this message's error).
  const listenLabel = current ? (playing ? '❚❚ Pause' : '▶︎ Resume') : audioError ? '↻ Retry' : '▶︎ Listen';

  async function copy() {
    await Clipboard.setStringAsync(canonical);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card style={styles.assistant}>
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
          style={({ pressed }) => [styles.msgBtn, (pressed || current) && styles.msgBtnActive]}
          accessibilityLabel={current ? 'Pause or resume this narration' : 'Listen to this response'}>
          {prep ? (
            <ActivityIndicator color={colors.cyan} size="small" />
          ) : (
            <Text variant="caption" color={current ? colors.cyan : colors.muted}>
              {listenLabel}
            </Text>
          )}
        </Pressable>
        <Pressable
          onPress={copy}
          style={({ pressed }) => [styles.msgBtn, (pressed || copied) && styles.msgBtnActive]}
          accessibilityLabel="Copy this response">
          <Text variant="caption" color={copied ? colors.cyan : colors.muted}>
            {copied ? '✓ Copied' : '⧉ Copy'}
          </Text>
        </Pressable>
      </View>
    </Card>
  );
}

function UserBubble({
  text,
  canEdit,
  editing,
  draft,
  onChangeDraft,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onEditLayout,
}: {
  text: string;
  canEdit?: boolean;
  editing?: boolean;
  draft?: string;
  onChangeDraft?: (t: string) => void;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
  onEditLayout?: (y: number) => void;
}) {
  if (editing) {
    return (
      <View style={styles.userRow} onLayout={(e) => onEditLayout?.(e.nativeEvent.layout.y)}>
        <View style={[styles.userBubble, styles.userBubbleEditing]}>
          <TextInput
            value={draft}
            onChangeText={onChangeDraft}
            multiline
            autoFocus
            style={styles.editInput}
            selectionColor={colors.cyan}
          />
          <View style={styles.editActions}>
            <Pressable onPress={onCancelEdit} style={styles.msgBtn} accessibilityLabel="Cancel edit">
              <Text variant="caption" color={colors.muted}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onSubmitEdit}
              disabled={!draft?.trim()}
              style={({ pressed }) => [styles.msgBtn, pressed && styles.msgBtnActive]}
              accessibilityLabel="Save edit and regenerate">
              <Text variant="caption" color={draft?.trim() ? colors.cyan : colors.muted}>
                ↻ Save & regenerate
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text selectable variant="body">{text}</Text>
        {canEdit ? (
          <Pressable onPress={onStartEdit} hitSlop={8} style={styles.editHint} accessibilityLabel="Edit this message">
            <Text variant="caption" color={colors.muted}>✎ Edit</Text>
          </Pressable>
        ) : null}
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
function StreamingAgentBubble({ items }: { items: StreamItem[] }) {
  const last = items[items.length - 1];
  const status = !last
    ? 'Thinking…'
    : last.kind === 'tool'
      ? `${(TOOL_META[last.name]?.label ?? 'Researching')}…`
      : 'Writing…';
  return (
    <Card style={styles.assistant}>
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
    </Card>
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
  thread: { padding: space.md, paddingBottom: space.xl, gap: space.md },
  composeFirst: { padding: space.md },
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
  assistant: { backgroundColor: colors.panel },
  msgActions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  msgBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
    minWidth: 84,
    alignItems: 'center',
  },
  msgBtnActive: { borderColor: colors.cyan },
  userRow: { alignItems: 'flex-end' },
  userBubble: {
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    borderBottomRightRadius: 4,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    maxWidth: '88%',
  },
  userBubbleEditing: { borderColor: colors.cyan, maxWidth: '92%', minWidth: '70%' },
  editInput: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15.5,
    lineHeight: 24,
    padding: 0,
    minHeight: 24,
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
    marginTop: space.sm,
  },
  editHint: { marginTop: space.xs, alignSelf: 'flex-end' },
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
  errorCard: { borderColor: colors.danger },
  composerBar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    padding: space.md,
    paddingBottom: space.lg,
    backgroundColor: colors.bg2,
  },
  input: {
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    maxHeight: 120,
    minHeight: 44,
  },
  sendBtn: { paddingHorizontal: space.lg, height: 44 },
});
