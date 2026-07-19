import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { FavoriteModel, ReadingMode } from '@/api/types';
import { BottomSheet, BottomSheetTextInput } from '@/components/BottomSheet';
import { PromptTemplateOption } from '@/components/PromptTemplateOption';
import { Button, Icon, Text, type IconName } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

export type OpeningTemplateKey = ReadingMode | 'custom';

export const OPENING_TEMPLATE_OPTIONS: {
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

export interface FirstResponseRetryConfig {
  prompt: string;
  mode: ReadingMode;
  model?: string;
}

function matchingTemplate(
  prompt: string | undefined,
  templates: Partial<Record<ReadingMode, string>> | undefined,
  currentMode: ReadingMode,
): OpeningTemplateKey {
  if (!prompt || !templates) return 'custom';
  if (templates[currentMode] === prompt) return currentMode;
  const match = (Object.keys(templates) as ReadingMode[]).find(
    (mode) => templates[mode] === prompt,
  );
  return match ?? 'custom';
}

export function FirstResponseRetrySheet({
  visible,
  onClose,
  currentPrompt,
  templates,
  currentMode,
  selectedModel,
  defaultModelLabel,
  favorites,
  onRetry,
}: {
  visible: boolean;
  onClose: () => void;
  currentPrompt?: string;
  templates?: Partial<Record<ReadingMode, string>>;
  currentMode: ReadingMode;
  selectedModel: string | null;
  defaultModelLabel: string;
  favorites: FavoriteModel[];
  onRetry: (config: FirstResponseRetryConfig) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const initialTemplate = useMemo(
    () => matchingTemplate(currentPrompt, templates, currentMode),
    [currentMode, currentPrompt, templates],
  );
  const [template, setTemplate] = useState<OpeningTemplateKey>(initialTemplate);
  const [customPrompt, setCustomPrompt] = useState(currentPrompt ?? '');
  const [model, setModel] = useState<string | null>(selectedModel);
  const [showModels, setShowModels] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTemplate(initialTemplate);
    setCustomPrompt(currentPrompt ?? '');
    setModel(selectedModel);
    setShowModels(false);
  }, [currentPrompt, initialTemplate, selectedModel, visible]);

  const prompt =
    template === 'custom'
      ? customPrompt
      : templates?.[template] ?? currentPrompt ?? '';
  const mode: ReadingMode = template === 'custom' ? 'balanced' : template;
  const modelLabel =
    model == null
      ? defaultModelLabel
      : favorites.find((favorite) => favorite.id === model)?.label ?? model;

  function selectTemplate(next: OpeningTemplateKey) {
    if (next === 'custom' && template !== 'custom') {
      setCustomPrompt(prompt);
    }
    setTemplate(next);
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      maxHeightPct={92}
      scrollable
      style={styles.sheet}
    >
      <Text variant="overline" color={t.violet}>Retry first response</Text>
      <Text variant="serifTitle" style={styles.title}>Choose how the discussion begins</Text>
      <Text variant="caption" style={styles.intro}>
        The existing response stays available as another branch.
      </Text>

      <View style={styles.options}>
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

      {template === 'custom' ? (
        <View style={styles.customBlock}>
          <Text variant="overline">Opening prompt</Text>
          <BottomSheetTextInput
            value={customPrompt}
            onChangeText={setCustomPrompt}
            multiline
            accessibilityLabel="Custom opening prompt"
            placeholder="Tell the analyst how to begin…"
            placeholderTextColor={t.muted}
            style={styles.input}
          />
        </View>
      ) : null}

      <Pressable
        onPress={() => setShowModels((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel={`Model for retried first response. ${modelLabel}. ${showModels ? 'Hide choices' : 'Change'}`}
        style={({ pressed }) => [styles.modelRow, pressed && { opacity: 0.82 }]}
      >
        <View style={styles.modelIcon}>
          <Icon name="zap" size={16} color={t.violet} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading">Model</Text>
          <Text variant="caption" color={t.muted} numberOfLines={1}>{modelLabel}</Text>
        </View>
        <Text variant="label" color={t.mint}>{showModels ? 'Done' : 'Change'}</Text>
      </Pressable>

      {showModels ? (
        <View style={styles.modelChoices}>
          <ModelChoice
            title="Project default"
            subtitle={defaultModelLabel}
            selected={model == null}
            onPress={() => setModel(null)}
          />
          {favorites.map((favorite) => (
            <ModelChoice
              key={favorite.id}
              title={favorite.label}
              subtitle={favorite.id}
              selected={model === favorite.id}
              onPress={() => setModel(favorite.id)}
            />
          ))}
        </View>
      ) : null}

      <Button
        title="Retry first response"
        icon="rotate-ccw"
        accessibilityRole="button"
        accessibilityLabel="Retry first response"
        disabled={!prompt.trim()}
        onPress={() => onRetry({
          prompt: prompt.trim(),
          mode,
          model: model ?? undefined,
        })}
        style={styles.retry}
      />
    </BottomSheet>
  );
}

function ModelChoice({
  title,
  subtitle,
  selected,
  onPress,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.choice, pressed && { backgroundColor: t.elevated }]}
    >
      <View style={[styles.choiceCheck, selected && styles.choiceCheckSelected]}>
        <Icon name={selected ? 'check' : 'circle'} size={15} color={selected ? t.mint : t.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="heading">{title}</Text>
        <Text variant="caption" color={t.muted} numberOfLines={1}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  sheet: { gap: space.sm },
  title: { marginTop: space.xs },
  intro: { marginBottom: space.xs },
  options: { gap: space.sm },
  customBlock: { gap: space.sm, marginTop: space.sm },
  input: {
    minHeight: 132,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.md,
    backgroundColor: t.elevated,
    color: t.text,
    padding: space.md,
    textAlignVertical: 'top',
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.sm,
    padding: space.md,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.md,
    backgroundColor: t.surface,
  },
  modelIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelChoices: {
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  choiceCheck: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceCheckSelected: { backgroundColor: t.mintWashStrong },
  retry: { marginTop: space.md },
});
