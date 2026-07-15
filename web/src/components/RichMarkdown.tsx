import { useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { usePaperIndex } from '@/hooks/useLibrary';
import 'katex/dist/katex.min.css';

marked.use({ breaks: true });
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

const TOOL_NAMES = 'search|web_search|fetch|web_fetch|browse|lookup';
const TOOL_TAG = new RegExp(`<(${TOOL_NAMES})\\s+(?:for|query|q|url|urls)\\s*=\\s*"([^"]*)"[^<>]*>(?:\\s*</\\1\\s*>)?`, 'gi');
const TOOL_CLOSE = new RegExp(`</(?:${TOOL_NAMES})\\s*>`, 'gi');

export function stripPseudoToolTags(text: string): string {
  if (!text.includes('<')) return text;
  return text.split(/(```[\s\S]*?```)/).map((part, index) => index % 2 ? part : part
    .replace(TOOL_TAG, (_match, _name, detail: string) => `\n\n*Searched: ${detail}*\n\n`)
    .replace(TOOL_CLOSE, '')).join('').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Models glue heading hashes to the title often enough ("###AWQ: Adoption…", plausibly bleed
// from the ###MARKER### output protocol) that CommonMark's required space is inserted here.
// Two or more hashes only — a single glued hash stays prose (#hashtag, #include) — and fenced
// code blocks are passed through untouched.
const GLUED_HEADING = /^(#{2,6})(?=[^#\s])/gm;

export function repairGluedHeadings(text: string): string {
  if (!text.includes('#')) return text;
  return text.split(/(```[\s\S]*?```)/).map((part, index) => index % 2 ? part : part.replace(GLUED_HEADING, '$1 ')).join('');
}

function renderMarkdown(text: string, papers: { title: string; slug: string }[]): string {
  const raw = marked.parse(repairGluedHeadings(stripPseudoToolTags(text))) as string;
  const safe = DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|rc-paper):)/i,
  });
  const root = document.createElement('div');
  root.innerHTML = safe;
  root.querySelectorAll('a').forEach((anchor) => {
    if (/^https?:/i.test(anchor.getAttribute('href') || '')) {
      anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    }
  });
  const known = papers.filter(({ title }) => title.trim().length >= 12).sort((a, b) => b.title.length - a.title.length);
  if (!known.length) return root.innerHTML;
  const slugByTitle = new Map(known.map(({ title, slug }) => [title.trim().toLowerCase(), slug]));
  const matcher = new RegExp(known.map(({ title }) => escapeRegExp(title.trim())).join('|'), 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('a, code, pre, .katex')) nodes.push(node);
  }
  nodes.forEach((node) => {
    const source = node.data; matcher.lastIndex = 0;
    let match: RegExpExecArray | null; let cursor = 0; const fragment = document.createDocumentFragment();
    while ((match = matcher.exec(source))) {
      fragment.append(source.slice(cursor, match.index));
      const anchor = document.createElement('a'); anchor.textContent = match[0];
      anchor.href = `rc-paper:${slugByTitle.get(match[0].toLowerCase())}`; anchor.className = 'paper-entity-link';
      fragment.append(anchor); cursor = match.index + match[0].length;
    }
    if (cursor) { fragment.append(source.slice(cursor)); node.replaceWith(fragment); }
  });
  return root.innerHTML;
}

export function RichMarkdown({ text, onNavigate, className = '' }: { text: string; onNavigate?: (hash: string) => void; className?: string }) {
  const papers = usePaperIndex();
  const html = useMemo(() => renderMarkdown(text, papers), [papers, text]);
  function click(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href') || '';
    if (!href.startsWith('rc-paper:')) return;
    event.preventDefault();
    const slug = href.slice('rc-paper:'.length);
    if (slug && onNavigate) onNavigate(`paper/${encodeURIComponent(slug)}`);
  }
  return <div className={`rich-markdown ${className}`} onClick={click} dangerouslySetInnerHTML={{ __html: html }} />;
}
