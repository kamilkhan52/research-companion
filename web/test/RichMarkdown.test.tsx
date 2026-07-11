import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RichMarkdown, stripPseudoToolTags } from '@/components/RichMarkdown';

const index = vi.hoisted(() => ({ papers: [] as { title: string; slug: string }[] }));
vi.mock('@/hooks/useLibrary', () => ({ usePaperIndex: () => index.papers }));

beforeEach(() => { index.papers = []; });

describe('RichMarkdown', () => {
  it('routes explicit internal paper links without exposing a custom protocol navigation', async () => {
    const onNavigate = vi.fn();
    render(<RichMarkdown text="Read [the paper](rc-paper:attention-is-all-you-need)." onNavigate={onNavigate} />);

    await userEvent.setup().click(screen.getByRole('link', { name: 'the paper' }));
    expect(onNavigate).toHaveBeenCalledWith('paper/attention-is-all-you-need');
  });

  it('linkifies exact known paper titles but leaves code alone', async () => {
    index.papers = [{ title: 'Attention Is All You Need', slug: 'attention-is-all-you-need' }];
    const onNavigate = vi.fn();
    render(<RichMarkdown text={'Attention Is All You Need differs from `Attention Is All You Need`.'} onNavigate={onNavigate} />);

    expect(screen.getAllByText('Attention Is All You Need')).toHaveLength(2);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Attention Is All You Need' }));
    expect(onNavigate).toHaveBeenCalledWith('paper/attention-is-all-you-need');
    expect(screen.getByText('Attention Is All You Need', { selector: 'code' })).toBeInTheDocument();
  });

  it('renders equations and removes unsafe URLs', () => {
    const { container } = render(<RichMarkdown text={'Inline $x^2$ and [unsafe](javascript:alert(1)).'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(screen.getByText('unsafe').closest('a')).not.toHaveAttribute('href');
  });

  it('turns pseudo tool markup into readable activity text outside code fences', () => {
    expect(stripPseudoToolTags('<search query="graph RAG"></search>')).toBe('*Searched: graph RAG*');
    expect(stripPseudoToolTags('```html\n<search query="keep me">\n```')).toContain('<search query="keep me">');
  });
});
