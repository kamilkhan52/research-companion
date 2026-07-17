// Project switcher: a bottom sheet listing every research project with paper/read counts, the
// active one highlighted, plus inline "new project" creation and per-project management
// (rename / favorite / delete — R7.5). The app is project-scoped, so this is the primary way
// to move between bodies of work.

import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import {
  useCreateProject,
  useDeleteProject,
  useProjects,
  useUpdateProjectMeta,
} from '@/api/queries';
import { Button, Card, Icon, IconButton, Text } from '@/ui';
import { showToast } from '@/ui/Toast';
import type { Project } from '@/api/types';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export function ProjectSwitcher({
  visible,
  activePid,
  onSelect,
  onClose,
}: {
  visible: boolean;
  activePid: string | null;
  /** null clears the selection (deleting the last project must not leave a dead pid live). */
  onSelect: (pid: string | null) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const projectsQuery = useProjects();
  const { data: projects, isLoading } = projectsQuery;
  const createProject = useCreateProject();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  // The project whose settings panel is open (null = the plain list).
  const [managing, setManaging] = useState<Project | null>(null);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreateError(null);
    try {
      const res = await createProject.mutateAsync({ name: trimmed });
      setName('');
      setCreating(false);
      onSelect(res.project.id);
    } catch (e) {
      setCreateError((e as Error).message ?? 'Could not create the project.');
    }
  }

  function handleClose() {
    setManaging(null);
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose}>
        {/* Lifts the sheet above the keyboard for the create/rename inputs (see
           SplitProjectSheet for the pattern rationale). */}
        <KeyboardAvoidingView behavior="padding" style={styles.avoider}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />

          {managing ? (
            <ProjectSettingsPanel
              project={managing}
              projects={projects ?? []}
              activePid={activePid}
              onSelect={onSelect}
              onBack={() => setManaging(null)}
              onDone={handleClose}
            />
          ) : (
            <>
              <Text variant="title" style={{ marginBottom: space.md }}>
                Projects
              </Text>

              {isLoading ? (
                <ActivityIndicator color={t.mint} style={{ paddingVertical: space.xl }} />
              ) : projectsQuery.isError ? (
                <View style={{ paddingVertical: space.md, gap: space.sm }}>
                  <Text variant="body" color={t.muted}>
                    Couldn't reach the server — check the connection or the server URL in
                    Settings.
                  </Text>
                  <Button title="Retry" variant="ghost" onPress={() => projectsQuery.refetch()} />
                </View>
              ) : (
                <View style={{ gap: space.sm }}>
                  {(projects ?? []).map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      active={p.id === activePid}
                      onPress={() => {
                        onSelect(p.id);
                        handleClose();
                      }}
                      onManage={() => setManaging(p)}
                    />
                  ))}
                  {projects && projects.length === 0 ? (
                    <Text variant="caption" style={{ paddingVertical: space.md }}>
                      No projects yet — create your first below.
                    </Text>
                  ) : null}
                </View>
              )}

              <View style={{ marginTop: space.lg }}>
                {creating ? (
                  <View style={{ gap: space.sm }}>
                    <TextInput
                      value={name}
                      onChangeText={setName}
                      placeholder="Project name"
                      placeholderTextColor={t.muted}
                      style={styles.input}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={handleCreate}
                    />
                    <View style={{ flexDirection: 'row', gap: space.sm }}>
                      <Button
                        title="Cancel"
                        variant="ghost"
                        onPress={() => setCreating(false)}
                        style={{ flex: 1 }}
                      />
                      <Button
                        title="Create"
                        onPress={handleCreate}
                        loading={createProject.isPending}
                        disabled={!name.trim()}
                        style={{ flex: 1 }}
                      />
                    </View>
                  </View>
                ) : (
                  <Button title="+ New project" variant="ghost" onPress={() => setCreating(true)} />
                )}
                {createError ? (
                  <Text variant="caption" color={t.danger} style={{ marginTop: space.sm }}>
                    {createError}
                  </Text>
                ) : null}
              </View>
            </>
          )}
        </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function ProjectRow({
  project,
  active,
  onPress,
  onManage,
}: {
  project: Project;
  active: boolean;
  onPress: () => void;
  onManage: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable onPress={onPress}>
      <Card style={[styles.row, active && styles.rowActive]}>
        {project.favorite ? <Icon name="star" size={14} color={t.amber} /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading" color={active ? t.mint : t.text} numberOfLines={1}>
            {project.name}
          </Text>
          <Text variant="caption" style={{ marginTop: 2 }}>
            {project.paper_count} paper{project.paper_count === 1 ? '' : 's'} · {project.read_count} read
          </Text>
        </View>
        {active ? <Icon name="check" size={18} color={t.mint} /> : null}
        <IconButton
          name="more-vertical"
          accessibilityLabel={`Settings for ${project.name}`}
          onPress={(e) => {
            e.stopPropagation();
            onManage();
          }}
        />
      </Card>
    </Pressable>
  );
}

/** Per-project settings: rename inline, toggle favorite, delete (confirmed, soft-deletes
 *  server-side into a recoverable trash dir). Deleting the ACTIVE project hands the selection
 *  to the next remaining project so the app never points at a missing store. */
function ProjectSettingsPanel({
  project,
  projects,
  activePid,
  onSelect,
  onBack,
  onDone,
}: {
  project: Project;
  projects: Project[];
  activePid: string | null;
  onSelect: (pid: string | null) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const updateMeta = useUpdateProjectMeta();
  const deleteProject = useDeleteProject();
  const [name, setName] = useState(project.name);
  const [favorite, setFavorite] = useState(project.favorite);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameDirty = trimmed.length > 0 && trimmed !== project.name;

  async function handleRename() {
    if (!nameDirty) return;
    setError(null);
    try {
      await updateMeta.mutateAsync({ pid: project.id, patch: { name: trimmed } });
      showToast('Project renamed');
      onBack();
    } catch (e) {
      setError((e as Error).message ?? 'Could not rename the project.');
    }
  }

  async function handleFavorite() {
    const next = !favorite;
    setFavorite(next); // optimistic — the row star follows on refetch
    setError(null);
    try {
      await updateMeta.mutateAsync({ pid: project.id, patch: { favorite: next } });
      showToast(next ? 'Added to favorites' : 'Removed from favorites');
    } catch (e) {
      setFavorite(!next);
      setError((e as Error).message ?? 'Could not update the favorite.');
    }
  }

  function confirmDelete() {
    Alert.alert(
      `Delete “${project.name}”?`,
      `Its ${project.paper_count} paper${project.paper_count === 1 ? '' : 's'}, notes and full reading history move out of the app. The server keeps a recoverable copy.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete project',
          style: 'destructive',
          onPress: () => void handleDelete(),
        },
      ],
    );
  }

  async function handleDelete() {
    setError(null);
    try {
      await deleteProject.mutateAsync({ pid: project.id });
      showToast('Project deleted');
      if (project.id === activePid) {
        const next = projects.find((p) => p.id !== project.id);
        onSelect(next?.id ?? null);
      }
      onDone();
    } catch (e) {
      setError((e as Error).message ?? 'Could not delete the project.');
    }
  }

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.panelHeader}>
        <IconButton name="arrow-left" accessibilityLabel="Back to projects" onPress={onBack} />
        <Text variant="title" style={{ flex: 1 }} numberOfLines={1}>
          {project.name}
        </Text>
      </View>

      <View style={{ gap: space.sm }}>
        <Text variant="label" color={t.muted}>
          Name
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Project name"
          placeholderTextColor={t.muted}
          style={styles.input}
          returnKeyType="done"
          onSubmitEditing={handleRename}
        />
        {nameDirty ? (
          <Button title="Save name" onPress={handleRename} loading={updateMeta.isPending} />
        ) : null}
      </View>

      <Button
        title={favorite ? '★ Remove from favorites' : '☆ Add to favorites'}
        variant="ghost"
        onPress={handleFavorite}
      />

      <Button
        title="Delete project…"
        variant="danger"
        onPress={confirmDelete}
        loading={deleteProject.isPending}
      />

      {error ? (
        <Text variant="caption" color={t.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: t.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: t.line,
    padding: space.lg,
    paddingBottom: space.xxl,
  },
  // The height cap lives on the KeyboardAvoidingView, not the sheet: a percentage maxHeight
  // resolves against the parent's height, and the KAV (auto-height) has none — against the
  // flex:1 backdrop it caps reliably, keyboard padding included.
  avoider: { maxHeight: '85%' },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: t.line2,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowActive: { borderColor: t.mint },
  panelHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
  },
});
