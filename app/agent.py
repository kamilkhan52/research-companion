"""The agentic core, now a two-stage pipeline.

Stage 1 — the analysis model reads the paper and produces only the CANONICAL scholarly
output (the written record). It does not think about audio at all.

Stage 2 — a separate, lighter narration model (see `narrate`) receives ONLY that canonical
text, without the paper, and adapts it sentence-for-sentence into a TTS-friendly transcript:
it preserves all technical content, numbers, and quotes, and changes only what speech
requires. This is the deliberate decoupling that keeps the narration faithful to the
analysis instead of drifting from it.

The analysis response uses a delimiter protocol (not literal JSON) because long scholarly
prose with equations/quotes/links breaks JSON string escaping.
"""
from __future__ import annotations

import re

from . import assembler, config, llm, prompts
from .models import REVIEW_SLUG, ProposedCommit, Turn

SECTIONS = ["CANONICAL", "STATE", "COMMIT_SUMMARY", "NOTES_BLOCK", "SYNTHESIS"]
# A marker is a whole line naming one section. The protocol says "###NAME###", but on long
# turns models drift into markdown headings ("## NAME", "# NAME"), so accept any heading
# depth with an optional trailing hash run rather than losing the draft.
_SECTION_RE = re.compile(
    r"^#{1,6}\s*(" + "|".join(SECTIONS) + r")\s*#{0,6}\s*$", re.M)


def _system_for(slug: str) -> str:
    """The system prompt + assembled context for a turn (review chat vs paper chat)."""
    access = prompts.get("self_contained_research")
    if slug == REVIEW_SLUG:
        return (prompts.get("review_system") + "\n\n" + access
                + "\n\n=== REVIEW CONTEXT ===\n\n" + assembler.build_context(slug))
    return (prompts.get("analysis_system") + "\n\n" + access
            + "\n\n=== READING CONTEXT ===\n\n" + assembler.build_context(slug))





class AgentError(Exception):
    pass


def _parse(content: str) -> Turn:
    content = content if isinstance(content, str) else (content or "")
    matches = list(_SECTION_RE.finditer(content))
    if not matches:
        # Model ignored the protocol: treat the whole thing as the canonical record. This
        # protocol-drift path needs the same pseudo-tool-tag cleanup as the marked path.
        return Turn(role="assistant", canonical=strip_pseudo_tool_tags(content.strip()),
                    state_signal="in_discussion")
    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        name = m.group(1)
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        body = content[m.end():end].strip()
        body = re.sub(r"#{1,6}\s*END\s*#{0,6}\s*$", "", body).strip()
        sections[name] = body

    def val(key: str) -> str:
        v = sections.get(key, "").strip()
        return "" if v.upper() == "NONE" else v

    state = (sections.get("STATE", "in_discussion") or "in_discussion").strip().lower()
    state = "ready_to_draft_notes" if "ready" in state else "in_discussion"

    commit = None
    notes, synth, summary = val("NOTES_BLOCK"), val("SYNTHESIS"), val("COMMIT_SUMMARY")
    if notes or synth:  # paper commit has both; the review chat has working notes (synth) only
        commit = ProposedCommit(summary=summary or "Notes + working-notes update",
                                notes_block=notes, synthesis=synth).to_dict()

    return Turn(
        role="assistant",
        canonical=strip_pseudo_tool_tags(val("CANONICAL") or content.strip()),
        narration="",  # produced lazily by the narration model
        state_signal=state,
        proposed_commit=commit,
    )


def _complete(messages: list[dict], model: str | None = None,
              temperature: float = 0.3, max_tokens: int = 8000,
              operation: str = "analysis") -> str:
    """Non-streaming analysis/narration call via the shared llm client, translating its
    LLMError into this module's AgentError so main.py maps it to HTTP as before."""
    try:
        return llm.complete(messages, model=model, temperature=temperature,
                            max_tokens=max_tokens, operation=operation)
    except llm.LLMError as e:
        raise AgentError(str(e)) from e


def parse(content: str) -> Turn:
    """Public wrapper: parse a complete analysis response into a Turn."""
    return _parse(content)


def run_turn(slug: str, history: list[dict], model: str | None = None) -> Turn:
    """Stage 1: history is [{role, content}] (assistant content is the prior CANONICAL text).
    Returns the parsed analysis Turn (narration is filled later by `narrate`). The analysis
    model gets a large output budget because reasoning models spend tokens before the answer.
    `model` is a one-shot override for this call only; None falls back to the account default
    (see llm._build_body)."""
    messages = [{"role": "system", "content": _system_for(slug)}] + history
    return _parse(_complete(messages, model=model, max_tokens=16000))


# ---- pseudo tool-call tags (polish plan G.2) ----
# The real research tools are SDK function calls (agent_harness) and never appear as text,
# but the model sometimes NARRATES tool intent as made-up XML — observed live as
# `<search for="...">` runs inside the canonical answer. Convert each to a muted one-line
# status instead of shipping raw markup to the reader (and to the narration model).

# The tag shape is strict — name immediately after '<', a known attribute immediately after
# the name — because every observed leak looks exactly like `<search for="...">`, and a
# narrow "what counts as a tag" keeps the streaming holdback below from ever needing to
# suppress ordinary prose ('x < sigma', 'the <search strategy', 'Vec<f32>').
_TOOL_TAG_NAMES = ("search", "web_search", "fetch", "web_fetch", "browse", "lookup")
_NAMES_ALT = "|".join(_TOOL_TAG_NAMES)
_ATTRS_ALT = "for|query|q|url|urls"
_PSEUDO_TOOL_RE = re.compile(
    r"""<(?P<name>""" + _NAMES_ALT + r""")\s+
        (?:""" + _ATTRS_ALT + r""")\s*=\s*"(?P<arg>[^"]*)"[^<>]*>
        (?:\s*</(?P=name)\s*>)?""",
    re.I | re.X)
# An orphan closing tag (its opener was already converted, or never existed).
_PSEUDO_TOOL_CLOSE_RE = re.compile(r"</(?:" + _NAMES_ALT + r")\s*>", re.I)
# A tag still streaming in (no '>' yet) — held back by canonical_prefix the same way a
# forming section marker is, so the visible prefix stays append-only (never emit text that a
# later conversion would rewrite). Held back iff the tail could still BECOME a matching tag:
#   <          </se        <search        <search for        <search for="quer      </search
# Anything else after '<' (a non-name word, 'x<sigma' once it outgrows a name prefix, a name
# followed by a non-attribute word like '<search strategy') streams through untouched — and
# by construction the strict _PSEUDO_TOOL_RE can never match it later.
_TOOL_NAME_PREFIXES = "|".join(sorted(
    {name[:i] for name in _TOOL_TAG_NAMES for i in range(1, len(name) + 1)},
    key=len, reverse=True))
_ATTR_PREFIXES = "|".join(sorted(
    {attr[:i] for attr in ("for", "query", "q", "url", "urls") for i in range(1, len(attr) + 1)},
    key=len, reverse=True))
_PSEUDO_TOOL_PARTIAL_RE = re.compile(
    r"<(?:"
    r"/(?:" + _TOOL_NAME_PREFIXES + r")?"                      # closing tag forming
    r"|(?:" + _NAMES_ALT + r")\s+(?:"                          # complete name + attrs arriving
    r"(?:" + _ATTRS_ALT + r")\s*=\s*(?:\"[^<>]*)?"             #   attr= (value may be open)
    r"|(?:" + _ATTR_PREFIXES + r")"                            #   attr name still typing
    r")?"
    r"|(?:" + _TOOL_NAME_PREFIXES + r")"                       # opening name still typing
    r")?$", re.I)
_FENCE_SPLIT_RE = re.compile(r"(```.*?```)", re.S)


def strip_pseudo_tool_tags(text: str) -> str:
    """Replace hallucinated tool-call markup with `*Searched: <arg>*` status lines, leaving
    fenced code blocks untouched (markup inside code is content, not a leak)."""
    if "<" not in text:
        return text

    def _convert(segment: str) -> str:
        segment = _PSEUDO_TOOL_RE.sub(lambda m: f"\n\n*Searched: {m.group('arg')}*\n\n", segment)
        return _PSEUDO_TOOL_CLOSE_RE.sub("", segment)

    parts = _FENCE_SPLIT_RE.split(text)
    cleaned = "".join(part if i % 2 else _convert(part) for i, part in enumerate(parts))
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip() if cleaned != text else text


# ---- streaming (Stage 1) ----

_CANON_START_RE = re.compile(r"^#{1,6}\s*CANONICAL\s*#{0,6}\s*$", re.M)
_NEXT_SECTION_RE = re.compile(
    r"^#{1,6}\s*(STATE|COMMIT_SUMMARY|NOTES_BLOCK|SYNTHESIS|END)\s*#{0,6}\s*$", re.M)


def canonical_prefix(raw: str) -> str:
    """The CANONICAL text visible so far in a partial stream — i.e. everything after the
    CANONICAL marker and before the next section marker. Used to stream only the scholarly
    answer to the client, never the protocol scaffolding. Holds back a trailing partial
    marker (e.g. '###STA' while '###STATE###' is still arriving)."""
    m = _CANON_START_RE.search(raw)
    if not m:
        # Another section arrived first (or protocol scaffolding is present): show nothing
        # rather than the scaffolding. Plain prose with no markers streams as-is.
        if "###" in raw or _NEXT_SECTION_RE.search(raw):
            return ""
        rest = re.sub(r"\s*#{1,6}\s*[A-Z_]*\s*$", "", raw)
    else:
        rest = raw[m.end():]
        nxt = _NEXT_SECTION_RE.search(rest)
        if nxt:
            rest = rest[:nxt.start()]
        else:
            rest = re.sub(r"\s*#{1,6}\s*[A-Z_]*\s*$", "", rest)  # a forming next-section marker
    # Same treatment the final parse applies (G.2): convert complete pseudo-tool tags to the
    # muted status line, and hold back a tag still streaming in ('<search for="…' with no '>')
    # so the reader never sees half a tag that later vanishes.
    rest = _PSEUDO_TOOL_PARTIAL_RE.sub("", rest)
    return strip_pseudo_tool_tags(rest.strip())


def stream_messages(messages: list[dict], max_tokens: int = 16000, operation: str = "analysis",
                    model: str | None = None):
    """Yield raw content pieces of a streaming completion, translating the llm client's
    LLMError into AgentError. Public seam so callers (notes_jobs' single-shot editor) don't
    reach into module privates for a plain streamed completion."""
    try:
        yield from llm.stream(messages, model=model, max_tokens=max_tokens, operation=operation)
    except llm.LLMError as e:
        raise AgentError(str(e)) from e


def stream_tokens(slug: str, history: list[dict], model: str | None = None):
    """Yield raw content pieces of the analysis response as they arrive."""
    messages = [{"role": "system", "content": _system_for(slug)}] + history
    yield from stream_messages(messages, max_tokens=16000, operation="analysis", model=model)


def narrate(canonical_text: str) -> str:
    """Stage 2: faithfully adapt one canonical response into a TTS transcript. Uses the
    (separate, lighter) narration model with no paper context."""
    if not canonical_text.strip():
        return ""
    settings = config.load_settings()
    model = settings.get("narration_model") or settings.get("model")
    messages = [
        {"role": "system", "content": (
            prompts.get("narration_system") + "\n\n" + prompts.get("self_contained_research")
        )},
        {"role": "user", "content": canonical_text},
    ]
    return _complete(messages, model=model, temperature=0.2, operation="narration").strip()
