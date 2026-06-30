// Discussion — the streaming chat with the analyst over one paper (or the working-notes review).
// Compose-first: edit the opening prompt, then start. Mid-discussion: reply with streaming
// responses. Wrap-up: draft notes, then approve / request changes. The server records every
// turn, so after each stream we refetch the canonical transcript.

import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import * as api from '@/api/endpoints';
import { streamPaths } from '@/api/endpoints';
import { useOpeningDraft, useSession } from '@/api/queries';
import { keys } from '@/api/queries';
import type { TranscriptEntry } from '@/api/types';
import { Markdown } from '@/components/Markdown';
import { TopBar } from '@/components/TopBar';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';
import { useActiveProject } from '@/store/project';
import { Button, Card, Screen, Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

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

  // Keep the conversation pinned to the latest content.
  useEffect(() => {
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(id);
  }, [transcript.length, stream.liveText, stream.pendingUser]);

  return (
    <Screen edges={['top']}>
      <TopBar
        title={session.data?.paper.title ?? 'Discussion'}
        subtitle={state ? STATE_LABEL[state] : undefined}
        onBack={() => router.back()}
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
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={8}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.thread}
            keyboardShouldPersistTaps="handled">
            {transcript.map((entry, i) => (
              <Message key={i} entry={entry} />
            ))}

            {stream.pendingUser ? <UserBubble text={stream.pendingUser} /> : null}
            {stream.streaming ? <StreamingBubble text={stream.liveText} /> : null}

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

  useEffect(() => {
    if (opening.data?.prompt && !prompt) setPrompt(opening.data.prompt);
  }, [opening.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setStarting(true);
    setRetrieveError(null);
    try {
      const res = await api.startPaper(pid, slug);
      if (res.needs_confirmation) {
        setRetrieveError(
          'Multiple source matches found — please start this paper once on the web client to pick the right source.',
        );
        return;
      }
      await stream.run(chatStartPath, { slug, prompt, model: opening.data?.model ?? undefined });
    } catch (e) {
      setRetrieveError((e as Error).message ?? 'Could not fetch the paper.');
    } finally {
      setStarting(false);
    }
  }

  if (opening.isLoading) return <Centered loading />;

  if (stream.streaming) {
    return (
      <ScrollView contentContainerStyle={styles.thread}>
        <StreamingBubble text={stream.liveText} />
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.composeFirst} keyboardShouldPersistTaps="handled">
        <Text variant="label">OPENING PROMPT</Text>
        <Text variant="caption" style={{ marginBottom: space.sm }}>
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
        {retrieveError ? (
          <Text variant="body" color={colors.danger} style={{ marginTop: space.md }}>
            {retrieveError}
          </Text>
        ) : null}
        <Button
          title={starting ? 'Fetching paper…' : 'Start reading'}
          onPress={start}
          loading={starting}
          disabled={!prompt.trim()}
          style={{ marginTop: space.lg }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
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

function Message({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === 'user') return <UserBubble text={entry.text} />;
  return (
    <Card style={styles.assistant}>
      <Markdown text={entry.canonical} />
    </Card>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text variant="body">{text}</Text>
      </View>
    </View>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <Card style={styles.assistant}>
      {text ? (
        <Markdown text={text} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <ActivityIndicator color={colors.cyan} />
          <Text variant="caption">Thinking…</Text>
        </View>
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
