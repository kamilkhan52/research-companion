import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import { Markdown } from '@/components/Markdown';

test('renders inline links and routes taps to the handler with href + label', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown
      text={'It builds on [the Transformer](rc-paper:transformer) and **bold** stays bold.'}
      onLinkPress={onLinkPress}
    />,
  );

  // Emphasis still parses around the link.
  expect(screen.getByText('bold')).toBeTruthy();

  await fireEventAsync.press(screen.getByText('the Transformer'));
  expect(onLinkPress).toHaveBeenCalledWith('rc-paper:transformer', 'the Transformer');
});

test('an external link passes its URL through to the handler', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown text={'See [GPT-4](https://arxiv.org/abs/2303.08774) for details.'} onLinkPress={onLinkPress} />,
  );
  await fireEventAsync.press(screen.getByText('GPT-4'));
  expect(onLinkPress).toHaveBeenCalledWith('https://arxiv.org/abs/2303.08774', 'GPT-4');
});
