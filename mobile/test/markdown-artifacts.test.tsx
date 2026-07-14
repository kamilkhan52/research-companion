import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import { Markdown } from '@/components/Markdown';

// U.2 — thematic breaks must render as a divider, never as literal "---" prose.
test.each(['---', '***', '___', '- - -', '-----'])(
  'a %s line renders as a horizontal rule, not literal text',
  async (marker) => {
    await renderAsync(<Markdown text={`Before.\n\n${marker}\n\nAfter.`} />);
    expect(screen.getByTestId('md-rule')).toBeTruthy();
    expect(screen.queryByText(marker)).toBeNull();
    expect(screen.getByText('Before.')).toBeTruthy();
    expect(screen.getByText('After.')).toBeTruthy();
  },
);

test('a break directly under a paragraph line still splits off as a rule', async () => {
  await renderAsync(<Markdown text={'A closing thought.\n---\nNext section.'} />);
  expect(screen.getByTestId('md-rule')).toBeTruthy();
  expect(screen.queryByText(/---/)).toBeNull();
});

test('hyphen runs inside prose or code are left alone', async () => {
  await renderAsync(<Markdown text={'Use `--flag` and a -- dash.\n\n```\n---\n```'} />);
  expect(screen.queryByTestId('md-rule')).toBeNull();
  // The fenced block keeps its literal content.
  expect(screen.getByText('---')).toBeTruthy();
});

// U.3 — the paper glyph is glued to the title with U+202F (narrow NO-BREAK space) so a line
// wrap can never strand the icon at the end of the previous line.
test('paper links join icon and title with a non-breaking space', async () => {
  await renderAsync(
    <Markdown text={'It builds on [the Transformer](rc-paper:transformer).'} onLinkPress={() => {}} />,
  );
  // RNTL text queries normalize whitespace (U+202F is category Zs), so assert on the raw
  // rendered tree: the narrow no-break glue char must be present in the link's text run.
  const tree = JSON.stringify(screen.toJSON());
  expect(tree).toContain('\u202f');
});

// U.7b — models sometimes write the link target INSIDE the brackets; repair, don't render
// literal bracket soup.
test('malformed bracket links are repaired into tappable links', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown
      text={'Compare [PIM-LLM (rc-paper:pim-llm)] and [KIVI (https://arxiv.org/abs/2402.02750)].'}
      onLinkPress={onLinkPress}
    />,
  );
  await fireEventAsync.press(screen.getByText(/PIM-LLM/));
  expect(onLinkPress).toHaveBeenCalledWith('rc-paper:pim-llm', 'PIM-LLM');
  expect(screen.queryByText(/\[KIVI/)).toBeNull();
});

test('a legitimate parenthetical inside a proper link label is untouched', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown
      text={'See [GPTQ (Frantar et al., 2022)](https://arxiv.org/abs/2210.17323) for details.'}
      onLinkPress={onLinkPress}
    />,
  );
  await fireEventAsync.press(screen.getByText(/GPTQ \(Frantar et al\., 2022\)/));
  expect(onLinkPress).toHaveBeenCalledWith(
    'https://arxiv.org/abs/2210.17323',
    'GPTQ (Frantar et al., 2022)',
  );
});
