// Equation rendering for Markdown (polish plan G.1): display math is a MathJax-generated SVG
// drawn by react-native-svg — native views, no WebView, no fonts (glyphs are paths) — with a
// Unicode fallback. Inline math deliberately stays a native Text glyph run so Android reflow
// cannot leave an inline View painted over adjacent prose (DR-109).

import { useState } from 'react';
import { LayoutChangeEvent, ScrollView, Text as RNText, useWindowDimensions, View } from 'react-native';

import { fitMathBlock, getSvgXml, splitTexForLines, texToPlain, texToSvg } from '@/lib/math';
import { useTheme } from '@/theme/ThemeProvider';
import { fonts, space } from '@/theme/tokens';

// MathJax sizes its SVG in ex units of its own font (~0.45em); scale display equations against
// the enclosing font size.
const EX_TO_PX = 0.45;

export function InlineMath({ tex, fontSize = 16 }: { tex: string; fontSize?: number }) {
  // Android can keep an inline View's old placement after the surrounding Text is remeasured
  // (for example when a figure above it finishes loading). The View then paints over adjacent
  // words even though its measured width is correct (DR-109). A nested Text participates in the
  // paragraph's native glyph layout on every reflow, so inline math uses the existing readable
  // Unicode conversion. Display equations retain full MathJax SVG rendering below.
  return (
    <RNText
      testID="inline-math"
      style={{ fontFamily: fonts.serifItalic, fontSize }}
      accessible
      accessibilityLabel={tex}>
      {texToPlain(tex)}
    </RNText>
  );
}

export function MathBlock({
  tex,
  fontSize = 17,
  splitTier = 0,
}: {
  tex: string;
  fontSize?: number;
  /** The tier this line may start splitting at. A line produced by a split re-splits only at
   *  the tier BELOW the one that produced it, which both bounds the recursion and stops a
   *  connective that was already used from being tried again. */
  splitTier?: number;
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
  const availW = Math.min(measuredW || fallbackW, windowW);
  const fit = fitMathBlock(naturalW, naturalH, availW);
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
  // device even though it scrolls — try breaking the TeX at its own connectives and stacking
  // the pieces as display lines, each fitted independently. Round 2 (his re-test): a LINE the
  // split produced may still overflow — `A = \min(b, c, d, e, f)` breaks at the `=` into a
  // stub and a 540px remainder — so each line re-splits at the next tier down, and only
  // genuinely atomic content (one huge fraction, a matrix) reaches the scroll strip below.
  // `targetPieces` tells the argument tier how many lines this actually needs, so a six-term
  // list becomes two balanced lines rather than six stubs.
  {
    const targetPieces = availW > 0 ? Math.max(2, Math.ceil(naturalW / availW)) : 2;
    const split = splitTexForLines(tex, splitTier, targetPieces);
    if (split && split.pieces.length > 1) {
      return (
        <View
          testID="math-block-lines"
          onLayout={onLayout}
          style={{ alignSelf: 'stretch', width: '100%', maxWidth: '100%' }}
          accessible
          accessibilityLabel={tex}>
          {split.pieces.map((piece, idx) => (
            <MathBlock key={idx} tex={piece} fontSize={fontSize} splitTier={split.tier + 1} />
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
