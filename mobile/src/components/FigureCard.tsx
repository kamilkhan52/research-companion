// A paper figure card in the discussion (R.10): the cached arXiv-HTML figure image, its
// number + caption, and a subtle source line. Placed inline after the first paragraph that
// references the figure (see lib/figures.planFigurePlacement + Markdown). The image comes
// from the app's own authenticated origin (figureAssetSource carries the Authorization header
// plus a non-secret ?v cache bust), so no CSP concerns. If the image fails to load, the card
// degrades gracefully to caption + source link rather than showing a broken-image box.

import { useState } from 'react';
import { Image } from 'expo-image';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { figureAssetSource } from '@/api/endpoints';
import type { PaperFigure } from '@/api/types';
import { Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

export function FigureCard({
  pid,
  slug,
  figure,
  version,
}: {
  pid: string;
  slug: string;
  figure: PaperFigure;
  /** The manifest's fetched_ts — busts the image cache when a re-derivation rewrites it. */
  version?: number | null;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [failed, setFailed] = useState(false);
  const source = figureAssetSource(pid, slug, figure.asset, version);
  // Known dimensions keep the layout stable (no reflow when the image loads); otherwise a
  // sensible max height with contain fit.
  const aspectRatio =
    figure.width && figure.height && figure.height > 0 ? figure.width / figure.height : undefined;
  const openSource = () => {
    if (figure.src) void Linking.openURL(figure.src).catch(() => undefined);
  };
  const heading = figure.number != null ? `Figure ${figure.number}` : 'Figure';

  return (
    <View style={styles.card}>
      {!failed ? (
        <Pressable onPress={openSource} accessibilityRole="imagebutton" accessibilityLabel={figure.alt || heading}>
          <Image
            source={source}
            style={[styles.image, aspectRatio ? { aspectRatio } : { height: 220 }]}
            contentFit="contain"
            onError={() => setFailed(true)}
          />
        </Pressable>
      ) : null}
      {figure.caption ? (
        <Text variant="caption" style={styles.caption}>
          {figure.caption}
        </Text>
      ) : (
        <Text variant="caption" style={styles.caption}>
          {heading}
        </Text>
      )}
      <Text
        variant="caption"
        color={t.muted}
        style={styles.source}
        onPress={openSource}
        accessibilityRole="link"
        accessibilityLabel="Open figure source on arXiv"
      >
        from arXiv HTML
      </Text>
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  card: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.md,
    padding: space.sm,
    gap: 6,
  },
  image: {
    width: '100%',
    maxWidth: '100%',
    borderRadius: radius.sm,
    backgroundColor: t.surface,
  },
  caption: { lineHeight: 18 },
  source: { fontSize: 11 },
});
