// Equation rendering for Markdown (polish plan G.1): MathJax-generated SVG drawn by
// react-native-svg — native views, no WebView, no fonts (glyphs are paths). Falls back to a
// unicode approximation (lib/math.texToPlain) on the pre-rebuild dev client (no SVG native
// module yet), on MathJax parse failures, and in jest.

import { ScrollView, Text as RNText, View } from 'react-native';

import { getSvgXml, texToPlain, texToSvg } from '@/lib/math';
import { colors, fonts } from '@/theme/tokens';

// MathJax sizes its SVG in ex units of its own font (~0.45em); scale against the enclosing
// font size so inline math sits naturally in serif body text.
const EX_TO_PX = 0.45;

export function InlineMath({ tex, fontSize = 16 }: { tex: string; fontSize?: number }) {
  const SvgXml = getSvgXml() as React.ComponentType<{
    xml: string; width: number; height: number; color?: string;
  }> | null;
  const rendered = SvgXml ? texToSvg(tex, false) : null;
  if (!SvgXml || !rendered) {
    return <RNText style={{ fontFamily: fonts.serifItalic }}>{texToPlain(tex)}</RNText>;
  }
  const ex = fontSize * EX_TO_PX;
  // An inline View inside Text flows with the line on both platforms; the translateY drops
  // the box by the formula's depth so its baseline meets the text baseline.
  return (
    <View
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
        color={colors.text}
      />
    </View>
  );
}

export function MathBlock({ tex, fontSize = 17 }: { tex: string; fontSize?: number }) {
  const SvgXml = getSvgXml() as React.ComponentType<{
    xml: string; width: number; height: number; color?: string;
  }> | null;
  const rendered = SvgXml ? texToSvg(tex, true) : null;
  if (!SvgXml || !rendered) {
    return (
      <RNText
        style={{
          fontFamily: fonts.serifItalic,
          fontSize,
          lineHeight: fontSize * 1.5,
          color: colors.text,
          textAlign: 'center',
        }}>
        {texToPlain(tex)}
      </RNText>
    );
  }
  const ex = fontSize * EX_TO_PX;
  const width = rendered.widthEx * ex;
  const height = rendered.heightEx * ex;
  // Wide equations scroll horizontally inside their own strip instead of wrapping or
  // squeezing — same rule the notes tables follow.
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 2 }}
      accessible
      accessibilityLabel={tex}>
      <SvgXml xml={rendered.svg} width={width} height={height} color={colors.text} />
    </ScrollView>
  );
}
