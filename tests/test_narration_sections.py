"""DR-153: a long response is narrated in sections, not in one call that compresses it.

Measured on Kamil's own H3 session: 7,698 chars narrated at 99% of their length and a median
per-sentence correspondence of 0.99, while 31,133 chars in the same thread, same model, same
prompt came back at 45% and 0.50 — merged and re-said rather than truncated, which is what
leaves DR-133's sentence highlighting nothing to anchor to. These tests pin the fix: the
common case stays exactly the single call it was, a long one is divided at boundaries that
never cut an equation or a code fence, the pieces are lossless, the number of paid calls is
bounded, each section holds its own spend, and no failure mode returns half a narration.
"""
import contextlib

import pytest
from app import agent, quotas


@pytest.fixture(autouse=True)
def _prompts_and_model(monkeypatch):
    monkeypatch.setattr(agent.prompts, "get",
                        {"narration_system": "narration instructions",
                         "self_contained_research": "self-contained"}.__getitem__)
    monkeypatch.setattr(agent.config, "load_settings", lambda: {"narration_model": "narrator"})


def _record(monkeypatch, reply=lambda text: "spoken: " + text[:20]):
    calls: list[dict] = []

    def fake_complete(messages, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return reply(messages[-1]["content"])

    monkeypatch.setattr(agent, "_complete", fake_complete)
    return calls


def _held(monkeypatch):
    """Count `per_unit` holds without touching the ledger."""
    units: list[tuple[str, str]] = []

    @contextlib.contextmanager
    def fake_per_unit(operation, job_id, *, model=None):
        units.append((operation, job_id))
        yield None

    monkeypatch.setattr(agent.spend_ceiling, "per_unit", fake_per_unit)
    return units


def _long_text(paragraphs=12, sentences=40):
    return ("Stacked DRAM raises the bandwidth the array can sustain. " * sentences
            + "\n\n") * paragraphs


def test_a_response_the_model_follows_is_still_one_call(monkeypatch):
    calls = _record(monkeypatch)
    units = _held(monkeypatch)
    text = "The paper reports a 135 Gbps link. " * 20
    assert len(text) <= agent.NARRATION_SECTION_CHARS

    assert agent.narrate(text) == ("spoken: " + text[:20]).strip()
    assert len(calls) == 1
    # The single-call path is unchanged, down to the system prompt: no section instruction is
    # added, because there are no other sections for it to be true about.
    assert calls[0]["messages"][0]["content"] == "narration instructions\n\nself-contained"
    assert calls[0]["messages"][1]["content"] == text
    assert units == []


def test_a_long_response_is_narrated_in_sections_and_joined(monkeypatch):
    calls = _record(monkeypatch, reply=lambda text: f"[{len(text)}]")
    text = _long_text()
    assert len(text) > agent.NARRATION_SECTION_CHARS

    spoken = agent.narrate(text, unit_id="job-1")

    assert len(calls) > 1, "a response past the measured compliance size must be sectioned"
    assert spoken == "\n\n".join(f"[{len(c['messages'][1]['content'])}]" for c in calls)
    # Every section is at or under the budget, and together they are the input untouched.
    sent = [c["messages"][1]["content"] for c in calls]
    assert max(len(s) for s in sent) <= agent.NARRATION_SECTION_CHARS
    assert "".join(sent) == text


def test_each_section_is_told_it_is_one_of_several(monkeypatch):
    calls = _record(monkeypatch)
    agent.narrate(_long_text(), unit_id="job-1")

    total = len(calls)
    for index, call in enumerate(calls, start=1):
        system = call["messages"][0]["content"]
        assert system.startswith("narration instructions\n\nself-contained")
        assert f"section {index} of {total}" in system
        # Without this the model writes an opening and a closing per section, and they land in
        # the middle of the transcript.
        assert "no introduction" in system


def test_display_math_is_never_cut_across_sections(monkeypatch):
    calls = _record(monkeypatch)
    # 156 is not arbitrary: it is the length at which the greedy pack would otherwise put the
    # `\\[` opener at the end of one section and its body in the next. Sized smaller, the
    # equation lands wholly inside a section by luck and the test passes with the guard removed.
    filler = "Stacked DRAM raises the bandwidth the array can sustain. " * 156
    equation = "\\[\n" + "  E = mc^2 + \\alpha \\beta\n\n" * 4 + "\\]"
    text = f"{filler}\n\n{equation}\n\n{filler}"
    agent.narrate(text, unit_id="job-1")

    sent = [c["messages"][1]["content"] for c in calls]
    assert len(sent) > 1
    for section in sent:
        assert section.count("\\[") == section.count("\\]"), section[:120]
    assert "".join(sent) == text


def test_dollar_display_math_is_never_cut_across_sections(monkeypatch):
    """`prompts.MATH_MARKDOWN_CONTRACT` asks for `\\[ … \\]`, but a model that answers in `$$`
    anyway must not have it cut in half — the contract governs what we ask for, not what
    arrives."""
    calls = _record(monkeypatch)
    filler = "Stacked DRAM raises the bandwidth the array can sustain. " * 157
    equation = "$$\n" + "  E = mc^2 + \\alpha\n\n" * 4 + "$$"
    agent.narrate(f"{filler}\n\n{equation}\n\n{filler}", unit_id="job-1")

    sent = [c["messages"][1]["content"] for c in calls]
    assert len(sent) > 1
    for section in sent:
        assert section.count("$$") % 2 == 0, section[:120]


def test_a_code_fence_is_never_cut_across_sections(monkeypatch):
    calls = _record(monkeypatch)
    # Same sizing as the math case above, for the same reason.
    filler = "Stacked DRAM raises the bandwidth the array can sustain. " * 156
    fenced = "```python\n" + "value = compute(row)\n\n" * 8 + "```"
    text = f"{filler}\n\n{fenced}\n\n{filler}"
    agent.narrate(text, unit_id="job-1")

    sent = [c["messages"][1]["content"] for c in calls]
    assert len(sent) > 1
    for section in sent:
        assert section.count("```") % 2 == 0, section[:120]
    assert "".join(sent) == text


def test_a_span_kept_whole_is_not_left_as_a_section_of_its_own(monkeypatch):
    """An equation with no prose around it narrates badly — the model has nothing to speak the
    symbols as — and is not worth its own paid call."""
    calls = _record(monkeypatch)
    filler = "Stacked DRAM raises the bandwidth the array can sustain. " * 156
    equation = "\\[\n" + "  E = mc^2 + \\alpha \\beta\n\n" * 4 + "\\]"
    agent.narrate(f"{filler}\n\n{equation}\n\n{filler}", unit_id="job-1")

    sent = [c["messages"][1]["content"] for c in calls]
    floor = agent.NARRATION_SECTION_CHARS * agent.NARRATION_MIN_SECTION_RATIO
    assert min(len(s) for s in sent) >= floor, [len(s) for s in sent]


def test_one_unmatched_delimiter_does_not_switch_sectioning_off(monkeypatch):
    """A stray `\\(` early in a long response must not swallow everything after it."""
    calls = _record(monkeypatch)
    text = "A stray \\( opens here. " + _long_text()
    agent.narrate(text, unit_id="job-1")

    assert len(calls) > 1
    assert "".join(c["messages"][1]["content"] for c in calls) == text


def test_a_paragraph_with_no_sentence_break_is_kept_whole(monkeypatch):
    calls = _record(monkeypatch)
    unsplittable = "x" * (agent.NARRATION_SECTION_CHARS + 500)
    text = f"{unsplittable}\n\nA short closing paragraph.\n"
    agent.narrate(text, unit_id="job-1")

    sent = [c["messages"][1]["content"] for c in calls]
    assert unsplittable in sent[0]
    assert "".join(sent) == text


def test_the_number_of_paid_calls_is_capped(monkeypatch):
    calls = _record(monkeypatch)
    text = _long_text(paragraphs=200)
    agent.narrate(text, unit_id="job-1")

    assert len(calls) <= agent.NARRATION_MAX_SECTIONS
    assert "".join(c["messages"][1]["content"] for c in calls) == text


def test_every_section_holds_its_own_spend(monkeypatch):
    calls = _record(monkeypatch)
    units = _held(monkeypatch)
    agent.narrate(_long_text(), unit_id="job-1")

    # The audio job's admission ticket reserved ONE narration lease; N calls under it would be
    # a ceiling that does not bound.
    assert units == [("narration", "job-1")] * len(calls)


def test_a_budget_refusal_mid_narration_does_not_return_half(monkeypatch):
    calls = _record(monkeypatch)

    @contextlib.contextmanager
    def refuse_after_first(operation, job_id, *, model=None):
        if calls:
            raise quotas.QuotaExceeded(used_nanousd=9, requested_nanousd=9,
                                       limit_nanousd=10)
        yield None

    monkeypatch.setattr(agent.spend_ceiling, "per_unit", refuse_after_first)

    with pytest.raises(quotas.QuotaError):
        agent.narrate(_long_text(), unit_id="job-1")
    assert len(calls) == 1


def test_an_empty_section_is_an_error_not_a_silent_gap(monkeypatch):
    seen: list[int] = []

    def fake_complete(messages, **kwargs):
        seen.append(1)
        return "" if len(seen) == 2 else "spoken"

    monkeypatch.setattr(agent, "_complete", fake_complete)
    _held(monkeypatch)

    with pytest.raises(agent.AgentError) as excinfo:
        agent.narrate(_long_text(), unit_id="job-1")
    assert "section 2" in str(excinfo.value)


def test_a_narration_that_runs_past_its_total_budget_stops(monkeypatch):
    calls = _record(monkeypatch)
    _held(monkeypatch)
    clock = iter([0.0, agent.NARRATION_TOTAL_TIMEOUT_S + 1])
    monkeypatch.setattr(agent.time, "monotonic", lambda: next(clock))

    with pytest.raises(agent.AgentError) as excinfo:
        agent.narrate(_long_text(), unit_id="job-1")
    # The per-call ceiling bounds one section; this bounds their sum.
    assert "1 of" in str(excinfo.value)
    assert len(calls) == 1


def test_blank_input_still_costs_nothing(monkeypatch):
    calls = _record(monkeypatch)
    assert agent.narrate("   \n  ") == ""
    assert calls == []


def test_a_sentence_cut_inside_inline_math_is_refused(monkeypatch):
    """The paragraph-level guard is not enough: one paragraph bigger than a section is divided
    at sentence ends, and a sentence end inside `\\( … \\)` is a cut through an equation.

    The sizes put the closing `\\)` just past the budget, so the greedy cut lands inside the
    span — with the guard removed this test fails, which is the point of the arithmetic.
    """
    calls = _record(monkeypatch)
    prose = "The measured latency is fine. " * 296
    math = "We write \\(x = 1. " + ("y = 2. " * 30) + "\\) and continue. "
    text = prose + math + "The measured latency is fine. " * 60
    agent.narrate(text, unit_id="job-1")

    sent = [c["messages"][1]["content"] for c in calls]
    assert len(sent) > 1
    for section in sent:
        assert section.count("\\(") == section.count("\\)"), section[-120:]
    assert "".join(sent) == text
