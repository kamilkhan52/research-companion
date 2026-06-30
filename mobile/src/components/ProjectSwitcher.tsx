// Project switcher: a bottom sheet listing every research project with paper/read counts, the
// active one highlighted, plus inline "new project" creation. The app is project-scoped, so
// this is the primary way to move between bodies of work.

import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { useCreateProject, useProjects } from '@/api/queries';
import { Button, Card, Text } from '@/ui';
import type { Project } from '@/api/types';
import { colors, radius, space } from '@/theme/tokens';

export function ProjectSwitcher({
  visible,
  activePid,
  onSelect,
  onClose,
}: {
  visible: boolean;
  activePid: string | null;
  onSelect: (pid: string) => void;
  onClose: () => void;
}) {
  const { data: projects, isLoading } = useProjects();
  const createProject = useCreateProject();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await createProject.mutateAsync({ name: trimmed });
    setName('');
    setCreating(false);
    onSelect(res.project.id);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text variant="title" style={{ marginBottom: space.md }}>
            Projects
          </Text>

          {isLoading ? (
            <ActivityIndicator color={colors.cyan} style={{ paddingVertical: space.xl }} />
          ) : (
            <View style={{ gap: space.sm }}>
              {(projects ?? []).map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={p.id === activePid}
                  onPress={() => {
                    onSelect(p.id);
                    onClose();
                  }}
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
                  placeholderTextColor={colors.muted}
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
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ProjectRow({
  project,
  active,
  onPress,
}: {
  project: Project;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress}>
      <Card style={[styles.row, active && styles.rowActive]}>
        <View style={{ flex: 1 }}>
          <Text variant="heading" color={active ? colors.cyan : colors.text}>
            {project.name}
          </Text>
          <Text variant="caption" style={{ marginTop: 2 }}>
            {project.paper_count} paper{project.paper_count === 1 ? '' : 's'} · {project.read_count} read
          </Text>
        </View>
        {active ? <Text color={colors.cyan}>✓</Text> : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg2,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    paddingBottom: space.xxl,
    maxHeight: '85%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line2,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowActive: { borderColor: colors.cyan },
  input: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    color: colors.text,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
  },
});
