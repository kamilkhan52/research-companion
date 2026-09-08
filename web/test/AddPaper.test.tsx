import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddPaperSheet } from '@/components/AddPaper';
import { addPaperDraftKey, parseKnownPaper, shouldSuggestCanonicalTitle, titleFromPdfName } from '@/lib/paper-reference';
import { ApiError } from '@/api/client';

const api = vi.hoisted(() => ({
  addPaper: vi.fn(),
  uploadPaper: vi.fn(),
}));

vi.mock('@/api/endpoints', async () => {
  // Keep the real predicate and the real size ceiling: a test that stubs them cannot tell
  // whether the component reads what the server actually sends or enforces.
  const actual = await vi.importActual<typeof import('@/api/endpoints')>('@/api/endpoints');
  return { ...actual, addPaper: api.addPaper, uploadPaper: api.uploadPaper };
});

function renderSheet(overrides: Partial<Parameters<typeof AddPaperSheet>[0]> = {}) {
  const props = {
    pid: 'project-1',
    onClose: vi.fn(),
    onAdded: vi.fn(),
    onListChanged: vi.fn(),
    onExplore: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<AddPaperSheet {...props} />) };
}

function pdf(name: string, size = 1_000): File {
  const file = new File(['%PDF-1.4'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.addPaper.mockResolvedValue({ paper: { slug: 'added-paper', title: 'Added' } });
  api.uploadPaper.mockResolvedValue({ job: { id: 'retrieval-1' } });
});

afterEach(() => localStorage.clear());

describe('parseKnownPaper', () => {
  it('reads a bare arXiv id, with or without a version suffix', () => {
    expect(parseKnownPaper('2309.06180')).toMatchObject({ arxivId: '2309.06180', source: '2309.06180' });
    expect(parseKnownPaper(' 2309.06180v2 ')).toMatchObject({ arxivId: '2309.06180' });
  });

  it('reads both arXiv link shapes and drops the rest of the URL', () => {
    expect(parseKnownPaper('https://arxiv.org/abs/2501.12345')).toMatchObject({ arxivId: '2501.12345' });
    expect(parseKnownPaper('http://arxiv.org/pdf/2501.12345v3')).toMatchObject({ arxivId: '2501.12345' });
  });

  it('treats any other link as a direct PDF source and titles it from the tail', () => {
    const parsed = parseKnownPaper('https://example.org/papers/deep_residual-learning.pdf');
    expect(parsed.pdfUrl).toBe('https://example.org/papers/deep_residual-learning.pdf');
    expect(parsed.arxivId).toBeUndefined();
    expect(parsed.title).toBe('deep residual learning');
  });

  it('leaves a plain title alone and names no source to fetch', () => {
    expect(parseKnownPaper('  Attention Is All You Need ')).toEqual({
      title: 'Attention Is All You Need', source: null,
    });
  });

  it('does not mistake a year-like number inside a title for an arXiv id', () => {
    expect(parseKnownPaper('Scaling laws 2020 revisited').arxivId).toBeUndefined();
  });
});

describe('titleFromPdfName', () => {
  it('reads a filename as a provisional title', () => {
    expect(titleFromPdfName('deep_residual-learning.pdf')).toBe('deep residual learning');
    expect(titleFromPdfName('Attention%20Is%20All%20You%20Need.PDF')).toBe('Attention Is All You Need');
  });

  it('keeps a filename whose escapes are malformed rather than refusing the add', () => {
    expect(titleFromPdfName('100%-coverage.pdf')).toBe('100% coverage');
  });

  it('never returns an empty title', () => {
    expect(titleFromPdfName('.pdf')).toBe('Uploaded paper');
    expect(titleFromPdfName('___.pdf')).toBe('Uploaded paper');
  });
});

describe('shouldSuggestCanonicalTitle', () => {
  const placeholder = { title: 'arXiv 2405.17057' };

  it('offers a source title that differs from the placeholder the add recorded', () => {
    expect(shouldSuggestCanonicalTitle(placeholder, 'The LLM Compiler')).toBe(true);
  });

  it('stays quiet once a person has ruled either way', () => {
    expect(shouldSuggestCanonicalTitle({ ...placeholder, title_confirmed: true }, 'The LLM Compiler')).toBe(false);
  });

  it('does not treat case, punctuation or spacing as a difference', () => {
    const paper = { title: 'Attention Is All You Need' };
    expect(shouldSuggestCanonicalTitle(paper, 'ATTENTION IS ALL YOU NEED')).toBe(false);
    expect(shouldSuggestCanonicalTitle(paper, 'Attention is all you   need.')).toBe(false);
  });

  it('says nothing when there is no paper or no source title', () => {
    expect(shouldSuggestCanonicalTitle(null, 'The LLM Compiler')).toBe(false);
    expect(shouldSuggestCanonicalTitle(placeholder, null)).toBe(false);
    expect(shouldSuggestCanonicalTitle(placeholder, '')).toBe(false);
  });
});

describe('AddPaperSheet', () => {
  it('adds a title-only paper and opens it with no source to fetch', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention Is All You Need');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(props.onAdded).toHaveBeenCalledWith('added-paper', null));
    expect(api.addPaper).toHaveBeenCalledWith('project-1', 'Attention Is All You Need', undefined);
  });

  it('sends the arXiv id from a link and carries it forward as the source', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'https://arxiv.org/abs/2309.06180');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(props.onAdded).toHaveBeenCalledWith('added-paper', '2309.06180'));
    expect(api.addPaper).toHaveBeenCalledWith('project-1', 'arXiv 2309.06180', '2309.06180');
  });

  it('names the projects that already hold the paper instead of showing the payload', async () => {
    const user = userEvent.setup();
    api.addPaper.mockRejectedValue(new ApiError(409, 'This paper already exists in another project.', {
      code: 'paper_exists_elsewhere',
      message: 'This paper already exists in another project.',
      matches: [{
        slug: 'attention', title: 'Attention Is All You Need', project_id: 'other',
        project_name: 'Transformers', has_notes: true, has_discussion: true, retrieved: true,
      }],
    }));
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention Is All You Need');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists in another project');
    expect(screen.getByText(/in Transformers, with notes/)).toBeInTheDocument();
    expect(screen.queryByText(/paper_exists_elsewhere/)).not.toBeInTheDocument();
    expect(props.onAdded).not.toHaveBeenCalled();
  });

  it('shows the server sentence for an in-project duplicate', async () => {
    const user = userEvent.setup();
    api.addPaper.mockRejectedValue(new ApiError(409, 'Already on the reading list: Attention Is All You Need'));
    renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention Is All You Need');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already on the reading list');
  });

  it('keeps the sheet open after a refusal so the text can be corrected', async () => {
    const user = userEvent.setup();
    api.addPaper.mockRejectedValue(new ApiError(409, 'Already on the reading list: X'));
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'X');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('alert');

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/paper title, doi, or arxiv link/i)).toHaveValue('X');
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('does not override the screen a reader chose on the way out', async () => {
    // "Explore with Discover" is a leave, not a cancel: an add still in flight must not land
    // on top of Discover once the reader has gone there.
    const user = userEvent.setup();
    let land!: (value: { paper: { slug: string } }) => void;
    api.addPaper.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention{Enter}');
    await screen.findByRole('button', { name: 'Adding…' });
    await user.click(screen.getByRole('button', { name: /explore with discover/i }));
    expect(props.onExplore).toHaveBeenCalled();

    land({ paper: { slug: 'attention' } });
    await waitFor(() => expect(localStorage.getItem(addPaperDraftKey('project-1'))).toBeNull());
    expect(props.onAdded).not.toHaveBeenCalled();
  });

  it('offers Discover as the other way in', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();
    await user.click(screen.getByRole('button', { name: /explore with discover/i }));
    expect(props.onExplore).toHaveBeenCalled();
  });

  it('persists an unfinished entry under the key the Discover field used', async () => {
    const user = userEvent.setup();
    const { unmount } = renderSheet();
    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'half a ti');
    unmount();

    expect(localStorage.getItem(addPaperDraftKey('project-1'))).toBe('half a ti');
    renderSheet();
    expect(screen.getByLabelText(/paper title, doi, or arxiv link/i)).toHaveValue('half a ti');
  });

  it('clears the draft once the paper is added', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(localStorage.getItem(addPaperDraftKey('project-1'))).toBeNull());
  });

  it('does not submit twice while the first add is in flight', async () => {
    const user = userEvent.setup();
    api.addPaper.mockReturnValue(new Promise(() => {}));
    renderSheet();

    const field = screen.getByLabelText(/paper title, doi, or arxiv link/i);
    await user.type(field, 'Attention{Enter}');
    await user.type(field, '{Enter}');

    expect(api.addPaper).toHaveBeenCalledTimes(1);
  });

  it('drops a refusal as soon as the text it was about changes', async () => {
    const user = userEvent.setup();
    api.addPaper.mockRejectedValue(new ApiError(409, 'This paper already exists in another project.', {
      code: 'paper_exists_elsewhere',
      message: 'This paper already exists in another project.',
      matches: [{
        slug: 'attention', title: 'Attention Is All You Need', project_id: 'other',
        project_name: 'Transformers', has_notes: true, has_discussion: true, retrieved: true,
      }],
    }));
    renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('alert');

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), ' something else');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/in Transformers/)).not.toBeInTheDocument();
  });

  it('can always be dismissed, even while an add is in flight', async () => {
    // `POST /papers` scans every project the caller owns, so it can be slow; a modal with no
    // exit is worse than a late answer.
    const user = userEvent.setup();
    api.addPaper.mockReturnValue(new Promise(() => {}));
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention{Enter}');
    await screen.findByRole('button', { name: 'Adding…' });

    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('does not open a paper the reader walked away from', async () => {
    const user = userEvent.setup();
    let land!: (value: { paper: { slug: string } }) => void;
    api.addPaper.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention{Enter}');
    await screen.findByRole('button', { name: 'Adding…' });
    await user.keyboard('{Escape}');

    land({ paper: { slug: 'attention' } });
    await waitFor(() => expect(localStorage.getItem(addPaperDraftKey('project-1'))).toBeNull());
    expect(props.onAdded).not.toHaveBeenCalled();
  });

  it('does not report a failure to a screen the reader left', async () => {
    const user = userEvent.setup();
    let fail!: (reason: unknown) => void;
    api.addPaper.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention{Enter}');
    await screen.findByRole('button', { name: 'Adding…' });
    await user.keyboard('{Escape}');

    fail(new ApiError(500, 'Server exploded'));
    await waitFor(() => expect(api.addPaper).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes on a click outside the sheet', async () => {
    const user = userEvent.setup();
    const { props, container } = renderSheet();
    await user.click(container.querySelector('.add-paper-overlay') as HTMLElement);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('creates the entry from the filename, then sends the bytes, then opens it', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), pdf('deep_residual-learning.pdf'));

    await waitFor(() => expect(props.onAdded).toHaveBeenCalledWith('added-paper', null));
    expect(api.addPaper).toHaveBeenCalledWith('project-1', 'deep residual learning');
    const [pid, slug, file] = api.uploadPaper.mock.calls[0];
    expect([pid, slug]).toEqual(['project-1', 'added-paper']);
    expect((file as File).name).toBe('deep_residual-learning.pdf');
  });

  it('refuses a PDF over the server ceiling without adding anything', async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), pdf('huge.pdf', 41_000_000));

    expect(await screen.findByRole('alert')).toHaveTextContent('The limit is 40 MB');
    expect(api.addPaper).not.toHaveBeenCalled();
  });

  it('retries a failed upload in place, against the paper it already created', async () => {
    // The reading-list entry exists by then, so a second add would duplicate it — and unlike
    // mobile, the web reading screen has no upload action to hand the reader off to.
    const user = userEvent.setup();
    api.uploadPaper.mockRejectedValueOnce(new ApiError(502, 'Upstream closed the connection.'));
    const { props } = renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), pdf('thesis.pdf'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upstream closed the connection');
    expect(props.onAdded).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /send it again/i }));

    await waitFor(() => expect(props.onAdded).toHaveBeenCalledWith('added-paper', null));
    // Exactly one entry, and the retry sent the same bytes to it.
    expect(api.addPaper).toHaveBeenCalledTimes(1);
    expect(api.uploadPaper).toHaveBeenCalledTimes(2);
    expect(api.uploadPaper.mock.calls.map(([, slug]) => slug)).toEqual(['added-paper', 'added-paper']);
    expect((api.uploadPaper.mock.calls[1][2] as File).name).toBe('thesis.pdf');
  });

  it('names the file in its recovery, and can still just open the paper', async () => {
    const user = userEvent.setup();
    api.uploadPaper.mockRejectedValue(new ApiError(502, 'Upstream closed the connection.'));
    const { props } = renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), pdf('thesis.pdf'));
    expect(await screen.findByText(/“thesis.pdf” is on your reading list/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /open the paper/i }));
    expect(props.onAdded).toHaveBeenCalledWith('added-paper', null);
  });

  it('does not leave one file\'s recovery standing over another file\'s refusal', async () => {
    const user = userEvent.setup();
    api.uploadPaper.mockRejectedValue(new ApiError(502, 'Upstream closed the connection.'));
    renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), pdf('thesis.pdf'));
    await screen.findByRole('button', { name: /send it again/i });

    await user.upload(screen.getByLabelText('PDF file'), pdf('huge.pdf', 41_000_000));

    expect(await screen.findByRole('alert')).toHaveTextContent('The limit is 40 MB');
    expect(screen.queryByRole('button', { name: /send it again/i })).not.toBeInTheDocument();
  });

  it('tells the Library the list changed even when the reader has already left', async () => {
    const user = userEvent.setup();
    let land!: (value: { paper: { slug: string } }) => void;
    api.addPaper.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    const { props } = renderSheet();

    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'Attention{Enter}');
    await user.keyboard('{Escape}');

    land({ paper: { slug: 'attention' } });
    await waitFor(() => expect(props.onListChanged).toHaveBeenCalled());
    expect(props.onAdded).not.toHaveBeenCalled();
  });

  it('will not start a second upload while one is running', async () => {
    const user = userEvent.setup();
    api.addPaper.mockReturnValue(new Promise(() => {}));
    renderSheet();

    const input = screen.getByLabelText('PDF file') as HTMLInputElement;
    await user.upload(input, pdf('a.pdf'));
    await screen.findByRole('button', { name: 'Uploading…' });

    // Two protections, and only the second survives a change event that arrives anyway — which
    // is why the disabled attribute alone is not enough to call this covered.
    expect(input).toBeDisabled();
    Object.defineProperty(input, 'files', { value: [pdf('b.pdf')], configurable: true });
    fireEvent.change(input);

    expect(api.addPaper).toHaveBeenCalledTimes(1);
  });

  it('accepts the same file again after a refusal', async () => {
    // The input is cleared after every pick; without that, re-choosing the file a reader just
    // fixed the size of (or that failed transiently) fires no change event at all.
    const user = userEvent.setup();
    const file = pdf('paper.pdf');
    renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), file);
    await waitFor(() => expect(api.addPaper).toHaveBeenCalledTimes(1));
    await user.upload(screen.getByLabelText('PDF file'), file);

    await waitFor(() => expect(api.addPaper).toHaveBeenCalledTimes(2));
  });

  it('reports a cross-project duplicate from the upload path the same way', async () => {
    const user = userEvent.setup();
    api.addPaper.mockRejectedValue(new ApiError(409, 'This paper already exists in another project.', {
      code: 'paper_exists_elsewhere',
      message: 'This paper already exists in another project.',
      matches: [{
        slug: 'resnet', title: 'Deep Residual Learning', project_id: 'other',
        project_name: 'Vision', has_notes: false, has_discussion: false, retrieved: true,
      }],
    }));
    renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), pdf('deep_residual-learning.pdf'));

    expect(await screen.findByText(/in Vision/)).toBeInTheDocument();
    expect(api.uploadPaper).not.toHaveBeenCalled();
  });

  it('does not open a PDF the reader walked away from', async () => {
    const user = userEvent.setup();
    let land!: (value: unknown) => void;
    api.uploadPaper.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    const { props } = renderSheet();

    await user.upload(screen.getByLabelText('PDF file'), pdf('paper.pdf'));
    await screen.findByRole('button', { name: 'Uploading…' });
    await user.keyboard('{Escape}');

    land({ job: { id: 'retrieval-1' } });
    await waitFor(() => expect(api.uploadPaper).toHaveBeenCalled());
    expect(props.onAdded).not.toHaveBeenCalled();
    // The entry is created BEFORE the bytes are sent, so a reader who dismisses mid-upload is
    // exactly who ends up with a paper the list does not show unless this fires.
    expect(props.onListChanged).toHaveBeenCalled();
  });
});
