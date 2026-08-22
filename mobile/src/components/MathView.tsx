// Equation rendering for Markdown (polish plan G.1): MathJax-generated SVG drawn by
// react-native-svg — native views, no WebView, no fonts (glyphs are paths). Falls back to a
// unicode approximation (lib/math.texToPlain) on the pre-rebuild dev client (no SVG native
// module yet), on MathJax parse failures, and in jest.

import { useState } from 'react';
import { LayoutChangeEvent, ScrollView, Text as RNText, useWindowDimensions, View } from 'react-native';

import { fitMathBlock, getSvgXml, splitTexForLines, texToPlain, texToSvg } from '@/lib/math';
import { useTheme } from '@/theme/ThemeProvider';
import { fonts, space } from '@/theme/tokens';

// MathJax sizes its SVG in ex units of its own font (~0.45em); scale against the enclosing
// font size so inline math sits naturally in serif body text.
const EX_TO_PX = 0.45;

export function InlineMath({ tex, fontSize = 16 }: { tex: string; fontSize?: number }) {
  const t = useTheme();
  const SvgXml = getSvgXml() as React.ComponentType<{
    xml: string; width: number; height: number; color?: string;
  }> | null;
  const rendered = SvgXml ? texToSvg(tex, false) : null;
  if (!SvgXml || !rendered) {
    return <RNText testID="inline-math" style={{ fontFamily: fonts.serifItalic }}>{texToPlain(tex)}</RNText>;
  }
  const ex = fontSize * EX_TO_PX;
  // An inline View inside Text flows with the line on both platforms; the translateY drops
  // the box by the formula's depth so its baseline meets the text baseline.
  return (
    <View
      testID="inline-math"
      style={{
        width: rendered.widthEx * ex,
        height: rendered.heightEx * ex,
        transform: [{ translateY: rendered.depthEx * ex }],
      }}
      accessible
      accessibilityLabel={tex}>
      <SvgXml
        xml={rendered.svg}
        width={rendered.widthEx * ex}
        height={rendered.heightEx * ex}
        color={t.text}
      />
    </View>
  );
}

export function MathBlock({
  tex,
  fontSize = 17,
  noSplit = false,
}: {
  tex: string;
  fontSize?: number;
  /** Set on the stacked lines a split produced: a piece that is still too wide falls back to
   *  the scroll strip rather than re-splitting (also the recursion guard). */
  noSplit?: boolean;
}) {
  // These hooks must run even while a streamed TeX span is temporarily incomplete. If they
  // lived after the fallback return, the same component could render plain text on one frame
  // and SVG on the next, changing its hook count and crashing React.
  const t = useTheme();
  const { width: windowW } = useWindowDimensions();
  const [measuredW, setMeasuredW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w && Math.abs(w - measuredW) > 0.5) setMeasuredW(w);
  };
  const SvgXml = getSvgXml() as React.ComponentType<{
    xml: string; width: number; height: number; color?: string;
  }> | null;
  const rendered = SvgXml ? texToSvg(tex, true) : null;
  if (!SvgXml || !rendered) {
    return (
      <RNText
        testID="math-block"
        style={{
          fontFamily: fonts.serifItalic,
          fontSize,
          lineHeight: fontSize * 1.5,
          color: t.text,
          textAlign: 'center',
          width: '100%',
        }}>
        {texToPlain(tex)}
      </RNText>
    );
  }
  const ex = fontSize * EX_TO_PX;
  const naturalW = rendered.widthEx * ex;
  const naturalH = rendered.heightEx * ex;
  // Measure the column so we can fit responsively: equations that fit render at natural size,
  // slightly-oversized ones scale down (SVG is lossless), and only genuinely huge derivations
  // fall back to a horizontal scroll strip. (Math can't wrap — MathJax emits one indivisible
  // SVG path group — so scale-then-scroll is the reflow story.)
  // Constrain to the narrower of the measured column and the physical screen: an equation must
  // never exceed the screen even if an ancestor is content-sized (grows to the formula's width).
  // Pre-layout (measuredW 0) falls back to the window width, so the first frame is bounded too.
  const fallbackW = Math.max(windowW - space.xl * 2, 1);
  const fit = fitMathBlock(naturalW, naturalH, Math.min(measuredW || fallbackW, windowW));
  const svg = <SvgXml xml={rendered.svg} width={fit.width} height={fit.height} color={t.text} />;

  if (!fit.scroll) {
    return (
      <View
        testID="math-block"
        onLayout={onLayout}
        style={{ alignSelf: 'stretch', width: '100%', maxWidth: '100%', alignItems: 'center', paddingVertical: 2 }}
        accessible
        accessibilityLabel={tex}>
        {svg}
      </View>
    );
  }
  // DR-098 (Kamil: "We want all equations to be fully readable… multiple lines are
  // acceptable"): before surrendering to the scroll strip — which read as "cut off" on his
  // device even though it scrolls — try breaking the TeX at its own top-level connectives
  // and stacking the pieces as display lines, each fitted independently. Only genuinely
  // unbreakable content (one huge fraction/matrix) still scrolls below.
  if (!noSplit) {
    const pieces = splitTexForLines(tex);
    if (pieces && pieces.length > 1) {
      return (
        <View
          testID="math-block-lines"
          onLayout={onLayout}
          style={{ alignSelf: 'stretch', width: '100%', maxWidth: '100%' }}
          accessible
          accessibilityLabel={tex}>
          {pieces.map((piece, idx) => (
            <MathBlock key={idx} tex={piece} fontSize={fontSize} noSplit />
          ))}
        </View>
      );
    }
  }
  // Too wide to shrink readably: scroll horizontally, left-aligned, with a persistent scrollbar
  // (Android) / indicator so the truncation reads as "swipe to see more", not "broken".
  return (
    <View
      testID="math-block"
      onLayout={onLayout}
      style={{ alignSelf: 'stretch', width: '100%', maxWidth: '100%' }}
      accessible
      accessibilityLabel={tex}>
      <ScrollView
        testID="math-block-scroll"
        horizontal
        style={{ width: '100%', maxWidth: '100%' }}
        showsHorizontalScrollIndicator
        persistentScrollbar
        contentContainerStyle={{ paddingVertical: 2, paddingRight: 8 }}>
        {svg}
      </ScrollView>
    </View>
  );
}
