// Discussion — the streaming chat with the analyst over one paper (or the working-notes review).
// Compose-first: edit the opening prompt, then start. Mid-discussion: reply with streaming
// responses. Wrap-up: draft notes, then approve / request changes. The server records every
// turn, so after each stream we refetch the canonical transcript.

import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
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

import * as Clipboard from 'expo-clipboard';

import * as api from '@/api/endpoints';
import { streamPaths } from '@/api/endpoints';
import { useOpeningDraft, useSession } from '@/api/queries';
import { keys } from '@/api/queries';
import { streamPost } from '@/api/stream';
import type { StartStreamEvent, StreamItem, TranscriptEntry } from '@/api/types';
import { useAudio } from '@/audio/AudioProvider';
import { Markdown } from '@/components/Markdown';
import { GeneratingBar, NarrationTranscript } from '@/components/NarrationTranscript';
import { IconButton, TopBar } from '@/components/TopBar';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';
import { useActiveProject } from '@/store/project';
import { Button, Card, Screen, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

export default function DiscussionScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { activePid } = useActiveProject();
  const pid = activePid;

  const session = useSession(pid, slug ?? null);
  const stream = useStreamingTurn(pid, slug ?? null);
  const scrollRef = useRef<ScrollView>(null);

  const state = session.data?.state ?? null;
  const transcript = session.data?.transcript ?? [];
  const hasSession = !!state && transcript.length > 0;
  const paths = pid ? streamPaths(pid) : null;

  // Message editing: which user reply is being edited + its draft. reply_index counts only
  // user turns (matching the backend, whose transcript surfaces only kind=="reply" users), so
  // precompute each transcript row's reply index (-1 for assistant rows).
  const [editing, setEditing] = useState<{ replyIndex: number; draft: string } | null>(null);
  const replyIndices = useMemo(() => {
    let c = -1;
    return transcript.map((e) => (e.role === 'user' ? ++c : -1));
  }, [transcript]);

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

  // When the keyboard opens, scroll to the end so the composer + latest turn stay visible.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () =>
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50),
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
          <IconButton glyph="✦" onPress={() => router.push('/graph')} accessibilityLabel="Reference graph" />
        }
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
                />
              ) : (
                <Message
                  key={i}
                  entry={entry}
                  audioId={`${slug}:${i}`}
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

function ComposeFirst({
  pid,
  slug,
  stream,
  chatStartPath,
}: {
  pid: string;
  slug: string;
  stream: ReturnType<typeof useStreamingTurn>;
  chatStartPath: string;
}) {
  const opening = useOpeningDraft(pid, slug);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  // When automatic retrieval is unsure or fails, we surface candidate matches and/or let the
  // user supply a source directly (a PDF/arXiv URL, or an arXiv id).
  const [candidates, setCandidates] = useState<SourceCandidate[] | null>(null);
  const [manualSource, setManualSource] = useState('');
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

  // Interpret a pasted source: a URL (http…) is treated as a direct PDF link, anything else as
  // an arXiv id. This is the "provide a PDF link" fallback when auto-retrieval can't find it.
  function startFromManual() {
    const s = manualSource.trim();
    if (!s) return;
    start(/^https?:\/\//i.test(s) ? { pdf_url: s } : { arxiv_id: s });
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
          onPress={() => start()}
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
  paths: ReturnType<typeof streamPaths>;
  onMutated: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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
    try {
      await api.approve(pid, slug);
      onMutated();
    } finally {
      setBusy(false);
    }
  }

  async function requestChanges() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setText('');
    try {
      await api.requestChanges(pid, slug, t);
      onMutated();
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setBusy(true);
    try {
      await api.reopen(pid, slug);
      onMutated();
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
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Request changes to the draft…"
          placeholderTextColor={colors.muted}
          style={styles.input}
          multiline
        />
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          {text.trim() ? (
            <Button title="Request changes" variant="ghost" onPress={requestChanges} loading={busy} style={{ flex: 1 }} />
          ) : (
            <Button title="Reopen" variant="ghost" onPress={reopen} loading={busy} style={{ flex: 1 }} />
          )}
          <Button title="Approve & commit" onPress={approve} loading={busy} disabled={!!text.trim()} style={{ flex: 1 }} />
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
  if (entry.role === 'user') return <UserBubble text={entry.text} />;

  const loading = audio.loadingId === audioId;
  const current = audio.currentId === audioId;
  const narration = audio.narrationById[audioId];
  // Show the transcript once we have it: live while this message is the current track (with the
  // follow-along highlight), and it stays available afterward for re-reading.
  const showTranscript = !!narration && (current || !loading);
  const [copied, setCopied] = useState(false);
  const canonical = entry.canonical;

  async function copy() {
    await Clipboard.setStringAsync(canonical);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card style={styles.assistant}>
      <Markdown text={canonical} />
      {loading && audio.loadingStage ? <GeneratingBar stage={audio.loadingStage} /> : null}
      {showTranscript ? <NarrationTranscript narration={narration} /> : null}
      <View style={styles.msgActions}>
        <Pressable
          onPress={() => audio.playText({ id: audioId, title, text: canonical })}
          disabled={loading}
          style={({ pressed }) => [styles.msgBtn, (pressed || current) && styles.msgBtnActive]}
          accessibilityLabel="Listen to this response">
          {loading ? (
            <ActivityIndicator color={colors.cyan} size="small" />
          ) : (
            <Text variant="caption" color={current ? colors.cyan : colors.muted}>
              {current ? '♪ Playing' : '► Listen'}
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
}: {
  text: string;
  canEdit?: boolean;
  editing?: boolean;
  draft?: string;
  onChangeDraft?: (t: string) => void;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
}) {
  if (editing) {
    return (
      <View style={styles.userRow}>
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

// The live assistant turn: text runs and tool invocations rendered in arrival order, so tool
// activity is interleaved with the response ("…answer so far… → 🔎 Searching → …more…") the way
// agent UIs conventionally show it — rather than pinning all tools above all text.
function StreamingAgentBubble({ items }: { items: StreamItem[] }) {
  return (
    <Card style={styles.assistant}>
      {items.length === 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <ActivityIndicator color={colors.cyan} />
          <Text variant="caption">Thinking…</Text>
        </View>
      ) : (
        items.map((it, i) =>
          it.kind === 'text' ? (
            <Markdown key={i} text={it.text} />
          ) : (
            <View key={i} style={styles.toolTrail}>
              <ToolLine name={it.name} detail={it.detail} />
            </View>
          ),
        )
      )}
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
