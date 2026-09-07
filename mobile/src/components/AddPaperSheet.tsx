// DR-149 — adding a known paper belongs to the active project's Library, not below a long
// Discover result list. This sheet keeps the three entry paths together: a known identifier or
// link, a PDF already on the device, or an intentional jump into exploratory Discover.

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import * as api from '@/api/endpoints';
import { useAddPaper } from '@/api/queries';
import { AddPaperInline } from '@/components/AddPaperInline';
import { BottomSheet } from '@/components/BottomSheet';
import { useTheme, useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';
import { Button, Icon, Text, ToneSurface } from '@/ui';
import { showToast } from '@/ui/Toast';

export function titleFromPdfName(name: string): string {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // A malformed percent escape is still a usable filename; keep it rather than blocking add.
  }
  return decoded
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Uploaded paper';
}

export function AddPaperSheet({
  visible,
  pid,
  onClose,
}: {
  visible: boolean;
  pid: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const addPaper = useAddPaper(pid);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) setError(null);
  }, [visible]);

  function openPaper(slug: string) {
    onClose();
    router.push(`/paper/${encodeURIComponent(slug)}`);
  }

  async function pickPdf() {
    setError(null);
    let documentPicker: typeof import('expo-document-picker');
    try {
      // Keep Library usable on a stale development client that predates the native picker.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      documentPicker = require('expo-document-picker') as typeof import('expo-document-picker');
    } catch {
      setError('This development build does not include PDF picking yet. Rebuild the app, or paste a direct PDF link above.');
      return;
    }
    let result: Awaited<ReturnType<typeof documentPicker.getDocumentAsync>>;
    try {
      result = await documentPicker.getDocumentAsync({
        type: 'application/pdf',
        multiple: false,
        copyToCacheDirectory: true,
      });
    } catch (e) {
      setError((e as Error).message ?? 'Could not open the PDF picker.');
      return;
    }
    if (result.canceled) return;

    const file = result.assets[0];
    setUploading(true);
    try {
      // A local PDF has no bibliographic identifier yet. Its filename is only the provisional
      // reading-list title; the reader can replace it with Rename paper on the paper screen.
      const outcome = await addPaper.mutateAsync({
        title: titleFromPdfName(file.name),
        autoAnalyze: true,
      });
      if (!outcome.paper) return;

      // Copy/Move reuse is a deliberate human choice in the duplicate sheet. Never overwrite
      // that saved paper's full text automatically; open it and leave its own Upload action.
      if (outcome.action !== 'added') {
        openPaper(outcome.paper.slug);
        return;
      }

      try {
        await api.uploadPaper(pid, outcome.paper.slug, {
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType,
        });
      } catch (e) {
        // The reading-list entry already exists at this point. Route to its normal setup surface
        // so the reader has an obvious retry instead of adding a duplicate from this sheet.
        showToast(`Paper added, but upload did not start: ${(e as Error).message ?? 'try Upload PDF again.'}`);
      }
      openPaper(outcome.paper.slug);
    } catch (e) {
      setError((e as Error).message ?? 'Could not add that PDF.');
    } finally {
      setUploading(false);
    }
  }

  function openDiscover() {
    onClose();
    router.push('/discover');
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeightPct={78} scrollable>
      <Text variant="overline" color={t.violet}>ADD TO THIS PROJECT</Text>
      <Text variant="title" style={styles.title}>Add a paper</Text>
      <Text variant="caption" color={t.muted} style={styles.intro}>
        Paste a title, DOI, arXiv link, or direct PDF link. We’ll open the paper and start its
        retrieval in the background.
      </Text>

      <AddPaperInline pid={pid} showDivider={false} onNavigate={onClose} />

      <View style={styles.orRow}>
        <View style={styles.orLine} />
        <Text variant="overline" color={t.muted}>OR</Text>
        <View style={styles.orLine} />
      </View>
      <Button
        title="Upload a PDF"
        icon="upload"
        variant="ghost"
        loading={uploading}
        disabled={addPaper.isPending}
        onPress={() => void pickPdf()}
        accessibilityLabel="Upload a PDF from this device"
      />

      {error ? (
        <ToneSurface tone="danger" style={styles.errorBox} accessibilityLiveRegion="polite">
          <Icon name="alert-circle" size={16} color={t.danger} />
          <Text variant="caption" color={t.danger} style={{ flex: 1 }}>{error}</Text>
        </ToneSurface>
      ) : null}

      <Pressable
        onPress={openDiscover}
        accessibilityRole="button"
        accessibilityLabel="Explore papers with Discover"
        style={({ pressed }) => [styles.discover, pressed && { opacity: 0.82 }]}
      >
        <View style={styles.discoverIcon}>
          <Icon name="compass" size={19} color={t.violet} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading">Explore with Discover</Text>
          <Text variant="caption" color={t.muted} numberOfLines={2}>
            Search and rank papers for this project’s research goal
          </Text>
        </View>
        <Icon name="chevron-right" size={18} color={t.muted} />
      </Pressable>
    </BottomSheet>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  return StyleSheet.create({
    title: { marginTop: space.xs },
    intro: { marginTop: space.xs },
    orRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      marginVertical: tight ? space.md : space.lg,
    },
    orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: t.line2 },
    errorBox: {
      marginTop: space.sm,
      padding: space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
    },
    discover: {
      minHeight: tight ? 68 : 76,
      flexDirection: 'row',
      alignItems: 'center',
      gap: tight ? space.sm : space.md,
      marginTop: tight ? space.md : space.lg,
      paddingHorizontal: space.md,
      paddingVertical: tight ? space.xs : space.sm,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: t.line2,
      backgroundColor: t.surface,
    },
    discoverIcon: {
      width: 42,
      height: 42,
      borderRadius: radius.pill,
      backgroundColor: t.elevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
};
