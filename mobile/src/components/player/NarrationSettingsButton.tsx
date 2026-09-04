// DR-135 — the player header's one control: it still READS the current speed (it replaced the
// speed pill, and losing the at-a-glance speed would have been a regression), but tapping it
// opens the narration settings instead of blindly cycling the rate.
//
// Kamil: "Where we currently show narration speed, we can have a button that opens a menu of
// options, including speed, font size, font, and any others."
//
// The menu is OptionsSheet, which is the app's ONLY menu idiom (polish plan F.5), with a live
// PREVIEW row at the top: the sheet covers the transcript, so without a preview every size or
// face step would mean closing the sheet, looking, and reopening it. Nothing here closes the
// sheet — every row is a setting you may want to try twice.

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { SettingsStepperRow } from '@/components/SettingsStepperRow';
import {
  MAX_NARRATION_SCALE,
  MIN_NARRATION_SCALE,
  NARRATION_FACES,
  NARRATION_FACE_ORDER,
  NARRATION_SCALE_STEP,
  PLAYBACK_RATES,
  narrationTextStyle,
  useListeningMode,
  type NarrationFace,
} from '@/store/listening';
import { Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

/** A short line of real narration voice, so the preview shows the face doing its actual job
 *  rather than a pangram. */
const PREVIEW_LINE =
  'The authors summarize the division as follows, quote, the memory-intensive operations are '
  + 'offloaded to a specialized device, end quote.';

export function NarrationSettingsButton({
  /** Rendered as extra rows below the type settings (the player's own playlist options). */
  extraOptions = [],
}: {
  extraOptions?: SheetOption[];
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const {
    playbackRate,
    setPlaybackRate,
    narrationFace,
    setNarrationFace,
    narrationTextScale,
    setNarrationTextScale,
  } = useListeningMode();

  const rateIndex = PLAYBACK_RATES.indexOf(playbackRate);
  const percent = Math.round(narrationTextScale * 100);

  const options: SheetOption[] = [
    {
      key: 'preview',
      title: 'Preview',
      icon: 'eye',
      closeOnPress: false,
      onPress: () => {},
      render: () => (
        <View style={styles.preview} testID="narration-settings-preview">
          <Text
            style={[styles.previewText, narrationTextStyle(narrationFace, narrationTextScale)]}
            numberOfLines={3}>
            {PREVIEW_LINE}
          </Text>
        </View>
      ),
    },
    {
      key: 'speed',
      title: 'Speed',
      icon: 'fast-forward',
      closeOnPress: false,
      onPress: () => {},
      render: () => (
        <SettingsStepperRow
          badgeIcon="fast-forward"
          title="Speed"
          subtitle="Playback rate"
          value={`${playbackRate}×`}
          valueLabel={`${playbackRate} times`}
          scopeLabel="narration speed"
          atMin={rateIndex <= 0}
          atMax={rateIndex >= PLAYBACK_RATES.length - 1}
          onDecrease={() => setPlaybackRate(PLAYBACK_RATES[Math.max(0, rateIndex - 1)])}
          onIncrease={() =>
            setPlaybackRate(PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, rateIndex + 1)])
          }
        />
      ),
    },
    {
      key: 'text-size',
      title: 'Text size',
      icon: 'type',
      closeOnPress: false,
      onPress: () => {},
      render: () => (
        <SettingsStepperRow
          badge="Aa"
          title="Text size"
          subtitle="Transcript"
          value={`${percent}%`}
          valueLabel={`${percent} percent`}
          scopeLabel="narration text size"
          atMin={narrationTextScale <= MIN_NARRATION_SCALE}
          atMax={narrationTextScale >= MAX_NARRATION_SCALE}
          onDecrease={() => setNarrationTextScale(narrationTextScale - NARRATION_SCALE_STEP)}
          onIncrease={() => setNarrationTextScale(narrationTextScale + NARRATION_SCALE_STEP)}
        />
      ),
    },
    ...NARRATION_FACE_ORDER.map((face: NarrationFace, i): SheetOption => ({
      key: `face-${face}`,
      title: NARRATION_FACES[face].label,
      subtitle: NARRATION_FACES[face].hint,
      icon: 'type',
      section: i === 0,
      selected: narrationFace === face,
      closeOnPress: false,
      onPress: () => setNarrationFace(face),
    })),
    ...extraOptions,
  ];

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={8}
        style={[styles.trigger, playbackRate !== 1 && { borderColor: t.mint }]}
        accessibilityRole="button"
        accessibilityLabel={`Narration settings. Speed ${playbackRate} times.`}>
        <Icon name="sliders" size={14} color={playbackRate !== 1 ? t.mint : t.muted} />
        <Text style={[styles.triggerLabel, playbackRate !== 1 && { color: t.mint }]}>
          {playbackRate}×
        </Text>
      </Pressable>
      <OptionsSheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Narration"
        options={options}
      />
    </>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  // R9.10's pill geometry, kept: the affordance had to be prominent enough to find and tap.
  trigger: {
    minWidth: 62,
    height: 36,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  triggerLabel: { color: t.muted, fontSize: 14, fontFamily: fonts.bodySemiBold },
  preview: {
    marginHorizontal: space.lg,
    marginBottom: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: t.bg,
    borderWidth: 1,
    borderColor: t.line,
  },
  previewText: { color: t.text },
});
