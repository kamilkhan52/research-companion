// A paper's "large icon": the first page of its PDF, rendered by the backend (app/cover_jobs)
// and shown as a warm page seated on the app's dark editorial surfaces. Treatment is the Figma
// "15 · Paper Cover" component (node 54:1439) — a #F7F5EF page, size-scaled corner radius, a soft
// broad drop shadow that lifts it off the card, a 1px inside hairline, and a top sheen. While the
// cover renders it shows a quiet spinner; when the paper has no fetchable source (or a render
// failed) it falls back to a document glyph on the same seated page. Reusable wherever a large
// paper icon is shown (currently the Library "Continue reading" card).
//
// Not carried over from Figma: the 0%→12% bottom scrim (purely cosmetic, and a real gradient
// needs expo-linear-gradient which isn't a dependency). The shadow + hairline already seat the
// page; add the scrim with a gradient lib if pixel-exact parity is ever wanted.
import { Image } from 'expo-image';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';

import { paperCoverImageSource } from '@/api/endpoints';
import { usePaperCover } from '@/api/queries';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon } from '@/ui';

const PAPER = '#F7F5EF'; // warm paper white
const EDGE = 'rgba(153, 163, 183, 0.28)'; // token line2 — 1px inside hairline
const SHEEN = 'rgba(255, 255, 255, 0.42)'; // top-edge highlight

export function PaperCover({
  projectId,
  slug,
  width,
  height,
  style,
}: {
  projectId: string;
  slug: string;
  width: number;
  height: number;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const { data: status, isLoading } = usePaperCover(projectId, slug);

  // Two treatment scales from the Figma component (Thumb 84×104 / Hero 200×248).
  const hero = width >= 150;
  const cornerRadius = hero ? 14 : 10;
  const sheenInset = hero ? 24 : 10;

  const outer: ViewStyle = {
    width,
    height,
    borderRadius: cornerRadius,
    backgroundColor: PAPER, // also prevents a dark flash before the image loads
    shadowColor: '#000',
    shadowOffset: { width: 0, height: hero ? 12 : 6 },
    shadowOpacity: 0.32,
    shadowRadius: hero ? 32 : 16,
    elevation: hero ? 12 : 6,
  };

  const ready = status === 'ready';
  const rendering = !ready && (status === 'pending' || isLoading);

  return (
    <View style={[outer, style]}>
      <View style={[styles.clip, { borderRadius: cornerRadius }]}>
        {ready ? (
          <Image
            source={paperCoverImageSource(projectId, slug)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            contentPosition="top"
            transition={200}
            cachePolicy="disk"
            accessibilityIgnoresInvertColors
          />
        ) : rendering ? (
          <ActivityIndicator color={t.muted} />
        ) : (
          <Icon name="file-text" size={Math.round(Math.min(width, height) * 0.3)} color={t.bg} />
        )}
        <View
          pointerEvents="none"
          style={[styles.sheen, { left: sheenInset, right: sheenInset }]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: EDGE,
  },
  sheen: {
    position: 'absolute',
    top: 0,
    height: 1,
    backgroundColor: SHEEN,
  },
});
