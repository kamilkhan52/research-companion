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
import time
import uuid

from . import (assembler, config, figures, llm, model_provenance, prompts,
               sessions, spend_ceiling)
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
        # Paper commit has both; the review chat has Project Notes (synth) only. Production
        # callers pass the transcript's last human action here, so a model that drifts on an
        # opening/reply cannot manufacture a notes-approval state the user never requested.
        commit = ProposedCommit(summary=summary or "Notes + Project Notes update",
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
                   paper_slug: str, paper_title: str, notes_block: str, full_text: str,
                   model: str | None = None) -> tuple[str, str]:
    """DR-058 — the synthesis-editor pass: plan first, then the complete rewritten Project
    Notes. A SEPARATE call from the finish turn, so the model that just spent its whole context
    on the paper is not the one deciding how much of the Project Notes to rewrite: this pass
    must state its change plan before touching the document, and the plan ships to review beside
    the diff. It receives both the committed-size Paper Notes and the full paper as framed
    evidence, letting it check scope and qualifications without allowing paper text to masquerade
    as instructions.

    Returns (plan, synthesis). Raises AgentError when the output carries no usable SYNTHESIS —
    the caller fails the turn rather than proposing a commit that would erase the Project Notes.

    Reasoning stays ON: unlike narration or a profile, planning an edit is exactly the kind of
    task reasoning models are for, and the finish wait already covers the latency (DR-056's
    "Updating Project Notes" stage is this pass).
    """
    framed_full_text = model_provenance.frame(
        "paper_full_text", full_text.strip(), source=paper_slug,
    ) if full_text.strip() else "(full text is not cached for this paper)"
    user = (
        f"# Project: {project_name}\n"
        + (f"\n## Research goals\n{goals}\n" if goals.strip() else "")
        + "\n## CURRENT Project Notes\n"
        + (current_synthesis.strip() or "(empty — no synthesis yet)")
        + f"\n\n## Newly finished paper: {paper_title}\n### Its drafted Paper Notes block\n"
        + notes_block.strip()
        + "\n\n## Full paper text (source evidence)\n"
        + framed_full_text
    )
    raw = _complete(
        [{"role": "system", "content": (prompts.get("synthesis_editor") + "\n\n"
                                           + model_provenance.SYSTEM_POLICY)},
         {"role": "user", "content": user}],
        model=model,
        max_tokens=16_000,
        operation="synthesis_edit",
    )
    plan_m = _PLAN_RE.search(raw)
    synth_m = _SYNTH_START_RE.search(raw)
    if not synth_m:
        raise AgentError("The synthesis editor returned no Project Notes document. "
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
        raise AgentError("The synthesis editor returned an empty Project Notes document. "
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


# ---- Stage-2 narration ------------------------------------------------------------------
#
# DR-153. The narration model follows the "sentence by sentence" instruction faithfully on a
# short response and abandons it on a long one. Measured on Kamil's own H3 session: a
# 7,698-char response narrated to 7,598 chars (99%, median per-sentence correspondence 0.99),
# while a 31,133-char response in the SAME thread, same model, same prompt, came back at
# 13,990 chars (45%, median 0.50). It was not truncated — the transcript ends on the same
# complete clause the written text does — and the instruction it disobeyed is present in the
# live prompt. The model reached the end and compressed on the way, merging and re-saying
# rather than dropping passages, which is exactly what leaves DR-133's sentence alignment
# nothing to anchor to (DR-154).
#
# So the lever is not the prompt's wording. Narrate the canonical text in sections each no
# larger than the size the model was measured to follow, and concatenate: faithfulness stops
# depending on how long the response was, and the cheap narration model can stay. Same move
# DR-098 made for math splitting.
#
#: Narrate in one call at or below this many characters, and use it as the per-section budget
#: above it. Sized from the measurement: the 7,698-char response complied, so a section this
#: size is one the model has been observed to follow, and the 31,133-char case that failed
#: becomes four such sections rather than one it compresses.
NARRATION_SECTION_CHARS = 9_000
#: Never dispatch more than this many narration calls for one response. Sections are paid
#: calls made in sequence, each bounded by `operation_limits["narration"]`'s per-call ceiling,
#: so their COUNT is what bounds the wall clock and the spend of one pathological response;
#: past this the sections grow instead of multiplying.
NARRATION_MAX_SECTIONS = 6
#: Total wall clock for a sectioned narration. The per-call ceiling bounds one section; this
#: bounds their sum, so a response that splits into six slow sections cannot hold a listener's
#: audio job for the product of the two.
NARRATION_TOTAL_TIMEOUT_S = 900.0
#: A section this small is folded into its neighbour, up to 1.2x the budget. Two reasons, and
#: the second is the important one: it is not worth its own paid call, and a display equation
#: or a code block with no prose around it narrates BADLY — the model has nothing to speak the
#: symbols as. Keeping a span whole must not turn it into a section by itself.
NARRATION_MIN_SECTION_RATIO = 0.1

_SECTION_INSTRUCTION = (
    "This is section {index} of {total} of ONE longer response, and the sections are joined "
    "verbatim in order. Narrate only the text below, all of it, and nothing else: no "
    "introduction, no recap of earlier sections, no closing, no section number — anything you "
    "add lands in the middle of the transcript. It is short so that you can follow it sentence "
    "by sentence; do not summarize, merge or shorten it."
)

#: A paragraph break: a run of blank lines, matched so that splitting keeps the newline that
#: ended the paragraph with the paragraph and hands the rest back as the separator. Joining
#: the pieces reproduces the input exactly, which is the property the tests pin.
_PARAGRAPH_RE = re.compile(r"(?<=\n)\n+")
#: A sentence end, used only to divide a single paragraph larger than one section on its own.
_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")


def _spans_open(text: str) -> bool:
    """Whether `text` leaves a code fence or a math span unclosed.

    Cutting inside one hands the model half a construct and opens the next section
    mid-equation — the failure DR-098 hit when it split math naively, where an unbalanced
    delimiter is not merely ugly but unrenderable.
    """
    return (text.count("```") % 2 == 1
            or text.count("$$") % 2 == 1
            or text.count(r"\[") != text.count(r"\]")
            or text.count(r"\(") != text.count(r"\)"))


def _paragraph_pieces(text: str, budget: int) -> list[str]:
    """`text` divided at paragraph breaks, re-joining any break that falls inside a span.

    The re-join is bounded at twice the budget. A genuine multi-paragraph equation or code
    block is far smaller than that, while a single UNMATCHED delimiter — one stray `\\(` in a
    30,000-character response — would otherwise swallow everything after it into one piece and
    silently turn the fix off for exactly the responses it exists for.
    """
    parts = _PARAGRAPH_RE.split(text)
    separators = _PARAGRAPH_RE.findall(text)
    pieces: list[str] = []
    for index, part in enumerate(parts):
        joined = part + (separators[index] if index < len(separators) else "")
        if pieces and len(pieces[-1]) < budget * 2 and _spans_open(pieces[-1]):
            pieces[-1] += joined
        else:
            pieces.append(joined)
    return [piece for piece in pieces if piece]


def _sentence_units(piece: str) -> list[str]:
    """`piece` as sentences, each carrying the whitespace that ended it."""
    units: list[str] = []
    start = 0
    for match in _SENTENCE_END_RE.finditer(piece):
        units.append(piece[start:match.end()])
        start = match.end()
    if start < len(piece):
        units.append(piece[start:])
    return units


def _sentence_pieces(piece: str, budget: int) -> list[str]:
    """`piece` divided at sentence ends that leave the part before them balanced.

    Only reached for a paragraph that exceeds one section by itself. A paragraph with no
    balanced split point is returned whole and oversized on purpose: handing the model more
    than the budget costs fidelity, and handing it a broken equation is a defect.
    """
    out: list[str] = []
    current = ""
    for unit in _sentence_units(piece):
        if current and len(current) + len(unit) > budget and not _spans_open(current):
            out.append(current)
            current = unit
        else:
            current += unit
    if current:
        out.append(current)
    return out


def _pack(pieces: list[str], budget: int) -> list[str]:
    """Greedily fill sections up to `budget`, never splitting a piece."""
    sections: list[str] = []
    for piece in pieces:
        if sections and len(sections[-1]) + len(piece) <= budget:
            sections[-1] += piece
        else:
            sections.append(piece)
    return sections


def _merge_runts(sections: list[str], budget: int) -> list[str]:
    """Fold sections too small to be worth a call into a neighbour (see the ratio above)."""
    floor = budget * NARRATION_MIN_SECTION_RATIO
    ceiling = budget * 1.2
    out: list[str] = []
    for section in sections:
        if out and len(section) < floor and len(out[-1]) + len(section) <= ceiling:
            out[-1] += section
        else:
            out.append(section)
    # The first section has no earlier neighbour, so it folds forward instead.
    if len(out) > 1 and len(out[0]) < floor and len(out[0]) + len(out[1]) <= ceiling:
        out[1] = out[0] + out[1]
        out.pop(0)
    return out


def narration_sections(canonical_text: str) -> list[str]:
    """Divide one canonical response into the sections it will be narrated in.

    Returns the text unchanged as a single section at any length the model has been measured
    to narrate faithfully in one call, so the common case stays exactly the single call it was.
    Joining the result with `""` reproduces the input.
    """
    if len(canonical_text) <= NARRATION_SECTION_CHARS:
        return [canonical_text]
    budget = NARRATION_SECTION_CHARS
    pieces: list[str] = []
    for piece in _paragraph_pieces(canonical_text, budget):
        pieces.extend(_sentence_pieces(piece, budget) if len(piece) > budget else [piece])
    sections = _merge_runts(_pack(pieces, budget), budget)
    # Past the cap, grow the sections rather than adding more: a larger section narrates less
    # faithfully, which is a degradation, where an unbounded number of paid sequential calls
    # is an incident. Terminates — the budget reaches the whole text, which is one section.
    while len(sections) > NARRATION_MAX_SECTIONS and budget < len(canonical_text):
        budget = int(budget * 1.5) + 1
        sections = _merge_runts(_pack(pieces, budget), budget)
    return sections


def _narrate_one(text: str, *, model: str | None, section: tuple[int, int] | None) -> str:
    instructions = (
        prompts.get("narration_system") + "\n\n" + prompts.get("self_contained_research")
    )
    if section is not None:
        instructions += "\n\n" + _SECTION_INSTRUCTION.format(index=section[0], total=section[1])
    messages = [
        {"role": "system", "content": instructions},
        {"role": "user", "content": text},
    ]
    # Reasoning off: narration is a rewrite of an argument that has already been made, not a
    # problem to solve, and a reasoning model can spend its whole budget thinking and return
    # nothing — which is exactly how a listener ends up with silence (2026-07-30).
    return _complete(messages, model=model, temperature=0.2, operation="narration",
                     reasoning=llm.no_reasoning_payload()).strip()


def narrate(canonical_text: str, *, unit_id: str | None = None) -> str:
    """Stage 2: faithfully adapt one canonical response into a TTS transcript. Uses the
    (separate, lighter) narration model with no paper context.

    A response longer than one section is narrated in sections and concatenated (DR-153).
    `unit_id` names the job the sections belong to for the spend ledger: each section is its
    own paid call and holds for itself through `spend_ceiling.per_unit`, because the caller's
    admission ticket reserved ONE narration lease and N calls under it would be a ceiling that
    does not bound. A section that is refused, empty or too late ends the whole narration
    rather than returning what arrived: the sections compose one artifact, and half a narration
    is audio that stops mid-argument with nothing to say so.
    """
    if not canonical_text.strip():
        return ""
    settings = config.load_settings()
    model = settings.get("narration_model") or settings.get("model")
    sections = narration_sections(canonical_text)
    if len(sections) == 1:
        return _narrate_one(sections[0], model=model, section=None)
    unit = unit_id or uuid.uuid4().hex
    deadline = time.monotonic() + NARRATION_TOTAL_TIMEOUT_S
    spoken: list[str] = []
    for index, section in enumerate(sections, start=1):
        if index > 1 and time.monotonic() > deadline:
            raise AgentError(
                f"Narration took too long: {index - 1} of {len(sections)} sections were spoken "
                f"within {int(NARRATION_TOTAL_TIMEOUT_S)}s.")
        with spend_ceiling.per_unit("narration", unit, model=model):
            part = _narrate_one(section, model=model, section=(index, len(sections)))
        if not part:
            raise AgentError(
                f"The narration model returned nothing for section {index} of {len(sections)}.")
        spoken.append(part)
    return "\n\n".join(spoken)
