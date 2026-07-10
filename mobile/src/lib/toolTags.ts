// Defensive twin of the backend's pseudo tool-tag stripping (app/agent.py, polish plan G.2).
// The backend now converts hallucinated `<search for="...">` markup before recording, but
// transcripts recorded BEFORE that fix still carry the raw tags — this pass cleans them at
// render time. Keep the tag-name list in sync with the backend.

const NAMES = 'search|web_search|fetch|web_fetch|browse|lookup';

// Strict tag shape, mirroring the backend: name immediately after '<', known attribute
// immediately after the name — so ordinary prose with '<' never converts.
const TAG_RE = new RegExp(
  `<(${NAMES})\\s+(?:for|query|q|url|urls)\\s*=\\s*"([^"]*)"[^<>]*>(?:\\s*</\\1\\s*>)?`,
  'gi',
);
const CLOSE_RE = new RegExp(`</(?:${NAMES})\\s*>`, 'gi');
const FENCE_SPLIT_RE = /(```[\s\S]*?```)/;

/** Convert leaked tool-call markup to `*Searched: …*` status lines, outside code fences. */
export function stripPseudoToolTags(text: string): string {
  if (!text.includes('<')) return text;
  const cleaned = text
    .split(FENCE_SPLIT_RE)
    .map((part, i) => {
      if (i % 2) return part; // inside a fence: markup is content
      return part
        .replace(TAG_RE, (_m, _name, arg: string) => `\n\n*Searched: ${arg}*\n\n`)
        .replace(CLOSE_RE, '');
    })
    .join('');
  return cleaned === text ? text : cleaned.replace(/\n{3,}/g, '\n\n').trim();
}
