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

from . import assembler, config, figures, llm, prompts, sessions
from .models import REVIEW_SLUG, ProposedCommit, Turn

SECTIONS = ["CANONICAL", "STATE", "COMMIT_SUMMARY", "NOTES_BLOCK", "SYNTHESIS"]
MATH_MARKDOWN_CONTRACT = (
    "Math formatting contract: write TeX inline math as `\\( ... \\)` and display math as "
    "`\\[ ... \\]`. Do not use single-dollar delimiters."
)
# A marker is a whole line naming one section. The protocol says "###NAME###", but on long
# turns models drift into markdown headings ("## NAME", "# NAME"), so accept any heading
# depth with an optional trailing hash run rather than losing the draft.
_SECTION_RE = re.compile(
    r"^#{1,6}\s*(" + "|".join(SECTIONS) + r")\s*#{0,6}\s*$", re.M)

_VISUAL_NOUN = r"(?:figures?|images?|plots?|charts?|diagrams?|visuals?)"
_DISPLAY_ACTION = r"(?:show|display|include|embed|render|insert)"
# An imperative display verb only counts at the start of the message/sentence/clause or right
# after a politeness/conjunction word. That is what separates a request directed at the
# assistant ("Include the figures…") from discussion of the paper ("Why did the authors
# include this chart?", "What does Figure 3 show?") and from negation ("Do not show any
# figures" — "not" is not an anchor word).
_IMPERATIVE_ANCHOR = r"(?:^|[.!?;:]\s+|\b(?:please|and|also|then|now|kindly|just)\s+)"
# The words allowed between a request verb and the visual noun: plain modifiers only.
# Negations ("show no figures") and interrogative complements ("show how Figure 3 supports
# the claim", "see whether the plots agree") must not bridge the gap — those are not
# requests to display images.
_REQUEST_FILLER = (
    r"(?:(?!(?:no|not|never|none|how|why|what|when|where|whether|if)\b)\w+\s+){0,3}?"
)
_EXPLICIT_FIGURE_DISPLAY_RE = re.compile(
    # "Show me Figure 3." / "Include the figures in your response."
    rf"(?:{_IMPERATIVE_ANCHOR}(?:please\s+)?{_DISPLAY_ACTION}\s+(?:me\s+|us\s+)?"
    rf"{_REQUEST_FILLER}{_VISUAL_NOUN}\b"
    # "Can you show the figures…"
    rf"|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?{_DISPLAY_ACTION}\s+"
    rf"(?:me\s+|us\s+)?{_REQUEST_FILLER}{_VISUAL_NOUN}\b"
    # "What figures matter … can you show me here?"
    rf"|\b{_VISUAL_NOUN}\b.{{0,120}}\b(?:can|could|will|would)\s+you\s+"
    rf"(?:please\s+)?{_DISPLAY_ACTION}\b"
    # "…the figures. Include them here."
    rf"|\b{_VISUAL_NOUN}\b.{{0,160}}{_IMPERATIVE_ANCHOR}(?:please\s+)?{_DISPLAY_ACTION}"
    rf"\s+(?:them|it)\b"
    # "Can I see the figures?" / "I'd like to see the plots." / "Let me see the figures."
    rf"|\b(?:can|could|may)\s+(?:i|we)\s+(?:please\s+)?(?:see|view)\s+"
    rf"{_REQUEST_FILLER}{_VISUAL_NOUN}\b"
    rf"|\b(?:let\s+(?:me|us)|i(?:'d|\s+would)?\s+(?:like|want|love)|we(?:'d|\s+would)?\s+"
    rf"(?:like|want|love))\s+(?:to\s+)?(?:see|view)\s+{_REQUEST_FILLER}{_VISUAL_NOUN}\b)",
    re.I | re.S | re.M,
)


def explicit_figure_display_request(text: str) -> bool:
    """Whether the user asked for visual assets to be shown, not merely discussed."""
    return bool(_EXPLICIT_FIGURE_DISPLAY_RE.search(text or ""))


def _latest_user_text(history: list[dict]) -> str:
    for message in reversed(history):
        if message.get("role") == "user":
            return str(message.get("content") or "")
    return ""


def _explicit_figure_request_layer(slug: str, user_text: str) -> str:
    if not explicit_figure_display_request(user_text):
        return ""
    manifest = figures.manifest_for(slug)
    available = sorted({
        int(figure["number"])
        for figure in (manifest or {}).get("figures", [])
        if figure.get("number") is not None
    })
    if available:
        labels = ", ".join(f"Figure {number}" for number in available)
        return (
            "\n\n=== EXPLICIT FIGURE-DISPLAY REQUEST ===\n"
            "The user explicitly asked to see/show/include figure images. Begin CANONICAL with "
            "a direct availability statement. The reader can see inline cards for ONLY these "
            f"labels: {labels}. Say that requested listed figures are available below; if the "
            "user requested an unlisted figure, say that image is unavailable and describe it "
            "in words. Then give the same self-contained explanation required for every figure."
        )
    return (
        "\n\n=== EXPLICIT FIGURE-DISPLAY REQUEST ===\n"
        "The user explicitly asked to see/show/include figure images, but no figure cards are "
        "available for this paper. Begin CANONICAL with a direct statement such as: “Figures "
        "are not available for this paper in the app, so I’ll describe their data and meaning.” "
        "Then provide the requested self-contained prose explanation."
    )


def _system_for(slug: str, latest_user_text: str = "") -> str:
    """The system prompt + assembled context for a turn (review chat vs paper chat)."""
    access = prompts.get("self_contained_research")
    if slug == REVIEW_SLUG:
        base = (prompts.get("review_system") + "\n\n" + MATH_MARKDOWN_CONTRACT + "\n\n"
                + access + "\n\n=== REVIEW CONTEXT ===\n\n" + assembler.build_context(slug))
    else:
        base = (prompts.get("analysis_system") + _mode_layer(slug) + "\n\n"
                + MATH_MARKDOWN_CONTRACT + "\n\n" + access
                + "\n\n=== READING CONTEXT ===\n\n" + assembler.build_context(slug))
    return base + _explicit_figure_request_layer(slug, latest_user_text)


def _mode_layer(slug: str) -> str:
    """The session's reading-mode system-prompt layer (polish plan H.3). 'balanced' — the
    default — adds nothing; the other modes append a short register-tuning block, so a
    one-tap switch changes every subsequent turn without touching the opening prompt."""
    mode = sessions.get_reading_mode(slug)
    if mode == "balanced":
        return ""
    return "\n\n" + prompts.get(f"reading_mode_{mode}")





class AgentError(Exception):
    pass


def _parse(content: str, *, allow_proposed_commit: bool = True) -> Turn:
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
    if allow_proposed_commit and (notes or synth):
        # Paper commit has both; the review chat has working notes (synth) only. Production
        # callers pass the transcript's last human action here, so a model that drifts on an
        # opening/reply cannot manufacture a notes-approval state the user never requested.
        commit = ProposedCommit(summary=summary or "Notes + working-notes update",
                                notes_block=notes, synthesis=synth).to_dict()

    return Turn(
        role="assistant",
        canonical=strip_pseudo_tool_tags(val("CANONICAL") or content.strip()),
        narration="",  # produced lazily by the narration model
        state_signal=state,
        proposed_commit=commit,
    )


_PLAN_RE = re.compile(r"^#{1,6}\s*PLAN\s*#{0,6}\s*$", re.M)
_SYNTH_START_RE = re.compile(r"^#{1,6}\s*SYNTHESIS\s*#{0,6}\s*$", re.M)
_EDITOR_END_RE = re.compile(r"^#{1,6}\s*END\s*#{0,6}\s*$", re.M)


def edit_synthesis(*, project_name: str, goals: str, current_synthesis: str,
                   paper_title: str, notes_block: str, model: str | None = None) -> tuple[str, str]:
    """DR-058 — the synthesis-editor pass: plan first, then the complete rewritten working
    notes. A SEPARATE call from the finish turn, so the model that just spent its whole context
    on the paper is not the one deciding how much of the working notes to rewrite: this pass
    sees the paper only at committed-notes size, must state its change plan before touching the
    document, and the plan ships to review beside the diff.

    Returns (plan, synthesis). Raises AgentError when the output carries no usable SYNTHESIS —
    the caller fails the turn rather than proposing a commit that would erase the working notes.

    Reasoning stays ON: unlike narration or a profile, planning an edit is exactly the kind of
    task reasoning models are for, and the finish wait already covers the latency (DR-056's
    "Updating working notes" stage is this pass).
    """
    user = (
        f"# Project: {project_name}\n"
        + (f"\n## Research goals\n{goals}\n" if goals.strip() else "")
        + "\n## CURRENT working notes\n"
        + (current_synthesis.strip() or "(empty — no synthesis yet)")
        + f"\n\n## Newly finished paper: {paper_title}\n### Its drafted Notes block\n"
        + notes_block.strip()
    )
    raw = _complete(
        [{"role": "system", "content": prompts.get("synthesis_editor")},
         {"role": "user", "content": user}],
        model=model,
        max_tokens=16_000,
        operation="synthesis_edit",
    )
    plan_m = _PLAN_RE.search(raw)
    synth_m = _SYNTH_START_RE.search(raw)
    if not synth_m:
        raise AgentError("The synthesis editor returned no working-notes document. "
                         "Try Finish reading again.")
    plan = ""
    if plan_m and plan_m.end() <= synth_m.start():
        plan = raw[plan_m.end():synth_m.start()].strip()
    synthesis = raw[synth_m.end():]
    end_m = _EDITOR_END_RE.search(synthesis)
    if end_m:
        synthesis = synthesis[:end_m.start()]
    else:
        # The prompt requires ###END###. Without it a truncated document is indistinguishable
        # from a complete one — and this document REPLACES synthesis.md on approval, so silent
        # truncation is data loss deferred to the reader's approval tap. Refuse and retry.
        raise AgentError("The synthesis editor's output was cut off before it finished. "
                         "Try Finish reading again.")
    # A model that inverted the order puts its plan AFTER the document; it must not become
    # part of the proposed synthesis.
    stray_plan = _PLAN_RE.search(synthesis)
    if stray_plan:
        synthesis = synthesis[:stray_plan.start()]
    synthesis = synthesis.strip()
    if not synthesis:
        raise AgentError("The synthesis editor returned an empty working-notes document. "
                         "Try Finish reading again.")
    return plan, synthesis


def _complete(messages: list[dict], model: str | None = None,
              temperature: float = 0.3, max_tokens: int = 8000,
              operation: str = "analysis", reasoning: dict | None = None) -> str:
    """Non-streaming analysis/narration call via the shared llm client, translating its
    LLMError into this module's AgentError so main.py maps it to HTTP as before."""
    try:
        return llm.complete(messages, model=model, temperature=temperature,
                            max_tokens=max_tokens, operation=operation, reasoning=reasoning)
    except llm.LLMError as e:
        raise AgentError(str(e)) from e


def parse(content: str, *, allow_proposed_commit: bool = True) -> Turn:
    """Public wrapper: parse a complete analysis response into a Turn."""
    return _parse(content, allow_proposed_commit=allow_proposed_commit)


def run_turn(slug: str, history: list[dict], model: str | None = None) -> Turn:
    """Stage 1: history is [{role, content}] (assistant content is the prior CANONICAL text).
    Returns the parsed analysis Turn (narration is filled later by `narrate`). The analysis
    model gets a large output budget because reasoning models spend tokens before the answer.
    `model` is a one-shot override for this call only; None falls back to the account default
    (see llm._build_body)."""
    messages = [{
        "role": "system",
        "content": _system_for(slug, _latest_user_text(history)),
    }] + history
    return _parse(
        _complete(messages, model=model, max_tokens=16000),
        allow_proposed_commit=sessions.proposal_expected(slug),
    )


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


#: Completion budgets for the two long scholarly turns. Named rather than inlined so
#: `operation_limits` can be asserted against the real number instead of a copy: a hand-copied
#: literal is what let `discovery`'s ceiling sit three times below what its caller asked for.
ANALYSIS_MAX_TOKENS = 16000
NOTES_MAX_TOKENS = 16000


def stream_messages(messages: list[dict], max_tokens: int = ANALYSIS_MAX_TOKENS,
                    operation: str = "analysis",
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
    messages = [{
        "role": "system",
        "content": _system_for(slug, _latest_user_text(history)),
    }] + history
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
    # Reasoning off: narration is a rewrite of an argument that has already been made, not a
    # problem to solve, and a reasoning model can spend its whole budget thinking and return
    # nothing — which is exactly how a listener ends up with silence (2026-07-30).
    return _complete(messages, model=model, temperature=0.2, operation="narration",
                     reasoning=llm.no_reasoning_payload()).strip()
