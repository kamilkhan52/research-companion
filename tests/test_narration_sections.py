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
import re

import pytest
from app import agent, quotas


@pytest.fixture(autouse=True)
def _prompts_and_model(monkeypatch):
    monkeypatch.setattr(agent.prompts, "get",
                        {"narration_system": "narration instructions",
                         "self_contained_research": "self-contained"}.__getitem__)
    monkeypatch.setattr(agent.config, "load_settings", lambda: {"narration_model": "narrator"})


#: A stand-in for a narration model that OBEYS the prompt. It has to be length-proportional
#: rather than a fixed stub, because DR-163's fidelity guard re-dispatches a passage that comes
#: back far shorter than its source — a fake returning twenty characters for a nine-thousand
#: character section is exactly the failure being guarded, and would make every call count
#: below a measurement of the guard instead of of sectioning.
def _faithful(text: str) -> str:
    return "Spoken sentence. " * max(1, len(text) // 12)


def _record(monkeypatch, reply=_faithful):
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


def _section_of(messages) -> int:
    """Which section a call is for, read off the instruction it was actually given. The test
    corpus repeats one sentence, so identical sections are indistinguishable by their bodies."""
    match = re.search(r"section (\d+) of \d+", messages[0]["content"])
    return int(match.group(1)) if match else 1


def _insisted(call) -> bool:
    return "came back far shorter" in call["messages"][0]["content"]


def _long_text(paragraphs=12, sentences=40):
    return ("Stacked DRAM raises the bandwidth the array can sustain. " * sentences
            + "\n\n") * paragraphs


def test_a_response_the_model_follows_is_still_one_call(monkeypatch):
    calls = _record(monkeypatch)
    units = _held(monkeypatch)
    text = "The paper reports a 135 Gbps link. " * 20
    assert len(text) <= agent.NARRATION_SECTION_CHARS

    assert agent.narrate(text) == _faithful(text).strip()
    assert len(calls) == 1
    # The single-call path is unchanged, down to the system prompt: no section instruction is
    # added, because there are no other sections for it to be true about.
    assert calls[0]["messages"][0]["content"] == "narration instructions\n\nself-contained"
    assert calls[0]["messages"][1]["content"] == text
    assert units == []


def test_a_long_response_is_narrated_in_sections_and_joined(monkeypatch):
    calls = _record(monkeypatch, reply=lambda text: f"Section of {len(text)}. " * 400)
    text = _long_text()
    assert len(text) > agent.NARRATION_SECTION_CHARS

    spoken = agent.narrate(text, unit_id="job-1")

    assert len(calls) > 1, "a response past the measured compliance size must be sectioned"
    assert spoken == "\n\n".join(
        (f"Section of {len(c['messages'][1]['content'])}. " * 400).strip() for c in calls)
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
    """A section the model never answers ends the narration. It is retried first (DR-163 refuses
    an empty transcript at any size), but a second silence is still an error rather than a gap
    the listener hears as the argument skipping a third of itself."""
    sections: list[str] = []

    def fake_complete(messages, **kwargs):
        sections.append(_section_of(messages))
        # Silent on BOTH attempts at section 2 — one silence is retried, by design.
        return "" if _section_of(messages) == 2 else _faithful(messages[1]["content"])

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


def test_a_narration_with_no_project_reserves_against_none(monkeypatch):
    """`audio_jobs` binds `usage.UNATTRIBUTED` as the active project around the narration call so
    the spend lands on that ledger. It is not a row in `rc_projects`, so a hold taken under it
    would be refused — "The project is no longer available." — and the FIRST hold ever taken
    inside that rebind is this PR's per-section one. Long responses would simply stop playing.
    """
    from app import config, spend_ceiling, spend_limits, usage

    seen: list[dict] = []

    class _Stop(Exception):
        pass

    def fake_reserve(**kwargs):
        seen.append(kwargs)
        raise _Stop  # everything after the argument is the ledger's business, not this test's

    monkeypatch.setattr(spend_limits, "enabled", lambda: True)
    monkeypatch.setattr(spend_ceiling.config, "active_user_id", lambda: "user-1")
    monkeypatch.setattr(spend_ceiling.quotas, "reserve", fake_reserve)

    token = config.set_active_project(usage.UNATTRIBUTED)
    try:
        with pytest.raises(_Stop):
            spend_ceiling.hold("narration", "job-1", model="narrator")
    finally:
        config.reset_active_project(token)

    assert seen and seen[0]["project_id"] is None


def test_a_cancel_stops_the_remaining_sections(monkeypatch):
    """`audio_jobs.cancel_job` promises at most one in-flight upstream call completes after a
    cancel returns. A narration that is several calls has to honour that too."""
    calls = _record(monkeypatch)
    _held(monkeypatch)

    with pytest.raises(agent.AgentError) as excinfo:
        agent.narrate(_long_text(), unit_id="job-1", should_stop=lambda: len(calls) >= 1)
    assert "cancelled" in str(excinfo.value)
    assert len(calls) == 1


# ---- DR-163: a compressed transcript is narrated again ------------------------------------
#
# Kamil's second sighting of DR-153's symptom, on /paper/stratum, after sectioning shipped.
# Sectioning lowered the CHANCE of the collapse; these pin the check that notices it happened.


def _compressing(threshold: int):
    """A model that obeys on short passages and summarizes long ones — DR-153's measured shape,
    and the only thing that separates a failure from the responses around it."""
    def reply(text: str) -> str:
        return "It compresses. " if len(text) > threshold else _faithful(text)
    return reply


def test_a_section_narrated_to_a_fraction_of_itself_is_narrated_again(monkeypatch):
    calls = _record(monkeypatch, reply=_compressing(0))
    _held(monkeypatch)

    text = _long_text()
    agent.narrate(text, unit_id="job-1")

    # Every section is attempted exactly twice: once, then once more because the first
    # transcript was a fortieth of its source. The retry re-sends the SAME section text.
    sections = len(agent.narration_sections(text))
    assert sections > 1
    assert len(calls) == 2 * sections
    for index in range(1, sections + 1):
        attempts = [c for c in calls if _section_of(c["messages"]) == index]
        assert len(attempts) == 2
        assert [_insisted(c) for c in attempts] == [False, True]
        assert attempts[0]["messages"][1]["content"] == attempts[1]["messages"][1]["content"]


def test_the_second_attempt_is_told_what_went_wrong(monkeypatch):
    calls = _record(monkeypatch, reply=_compressing(0))
    _held(monkeypatch)

    agent.narrate(_long_text(), unit_id="job-1")

    first, second = calls[0]["messages"][0]["content"], calls[1]["messages"][0]["content"]
    assert "came back far shorter" not in first, "the first attempt has nothing to be told yet"
    assert "came back far shorter" in second
    # It is an ADDITION to the same prompt, not a replacement: the section instruction and the
    # narration rules still govern the retry.
    assert second.startswith(first)


def test_a_faithful_transcript_is_never_narrated_twice(monkeypatch):
    calls = _record(monkeypatch)
    units = _held(monkeypatch)

    text = _long_text()
    agent.narrate(text, unit_id="job-1")

    assert len(calls) == len(agent.narration_sections(text)), \
        "a compliant model must cost exactly one call per section"
    assert not any(_insisted(c) for c in calls)
    assert units == [("narration", "job-1")] * len(calls)


def test_the_retry_holds_its_own_spend(monkeypatch):
    """The audio job's admission ticket reserved ONE narration lease. A retry is an extra paid
    call under it, so it holds for itself exactly as a section does (DR-150)."""
    calls = _record(monkeypatch, reply=_compressing(0))
    units = _held(monkeypatch)

    text = _long_text()
    agent.narrate(text, unit_id="job-1")

    assert len(calls) == 2 * len(agent.narration_sections(text))
    assert units == [("narration", "job-1")] * len(calls)


def test_the_single_call_path_also_holds_for_its_retry(monkeypatch):
    """On the single-section path the FIRST call is the one the ticket reserved, so only the
    retry takes a lease — otherwise the common case would start double-holding for nothing."""
    calls = _record(monkeypatch, reply=lambda text: "It compresses. ")
    units = _held(monkeypatch)
    text = "The paper reports a 135 Gbps stacked link. " * 40
    assert len(text) <= agent.NARRATION_SECTION_CHARS

    agent.narrate(text, unit_id="job-1")

    assert len(calls) == 2
    assert units == [("narration", "job-1")]


def test_a_worse_second_attempt_is_discarded(monkeypatch):
    """A retry that is also short must not be allowed to make the result worse than not having
    tried: the longer transcript wins."""
    seen: list[int] = []

    def fake_complete(messages, **kwargs):
        seen.append(1)
        return "The first attempt said this much and no more. " if len(seen) == 1 else "Nope. "

    monkeypatch.setattr(agent, "_complete", fake_complete)
    _held(monkeypatch)
    text = "The paper reports a 135 Gbps stacked link. " * 40

    assert agent.narrate(text, unit_id="job-1") == "The first attempt said this much and no more."
    assert len(seen) == 2


def test_markdown_scaffolding_is_not_counted_as_content_that_went_missing(monkeypatch):
    """The prompt asks for fences, markup and bare URLs to be REMOVED. Counting them on the
    source side would make a correctly converted code-heavy passage look compressed and buy a
    second call for every one of them."""
    prose = "The kernel fuses the two passes into one sweep. " * 30
    fence = "```python\n" + "value = compute(row_index, column_index)\n" * 60 + "```\n\n"
    source = fence + prose
    spoken = prose  # the fence is gone, as instructed

    assert len(spoken) < len(source) * agent.NARRATION_MIN_FIDELITY_RATIO
    assert agent._narration_is_faithful(source, spoken)


def test_an_empty_transcript_is_refused_at_any_length(monkeypatch):
    assert not agent._narration_is_faithful("Two sentences. Short ones.", "")
    assert not agent._narration_is_faithful("Two sentences. Short ones.", "   \n ")


def test_a_short_passage_is_not_judged_on_its_ratio(monkeypatch):
    """Below the guarded size the ratio is noise — one heading of a two-sentence passage is
    already a third of it — so the guard stays out of the way."""
    short = "Key results. " + "x" * (agent.NARRATION_MIN_GUARDED_CHARS - 40)
    assert agent._speakable_length(short) < agent.NARRATION_MIN_GUARDED_CHARS
    assert agent._narration_is_faithful(short, "Key results.")


def test_a_cancel_between_the_attempts_keeps_what_arrived(monkeypatch):
    """`audio_jobs.cancel_job` promises at most one in-flight upstream call completes after a
    cancel. The retry is a second call, so a cancel must land before it is dispatched."""
    calls = _record(monkeypatch, reply=lambda text: "It compresses. ")
    _held(monkeypatch)
    text = "The paper reports a 135 Gbps stacked link. " * 40

    assert agent.narrate(text, unit_id="job-1", should_stop=lambda: True) == "It compresses."
    assert len(calls) == 1


def test_a_narration_out_of_wall_clock_does_not_buy_a_retry(monkeypatch):
    """The total deadline bounds the SUM of the section calls. Past it, a compressed section is
    kept rather than spending the next section's budget re-reading this one."""
    calls = _record(monkeypatch, reply=_compressing(0))
    _held(monkeypatch)
    # Section 1 dispatches at t=0, its retry decision is taken after the deadline.
    clock = iter([0.0] + [agent.NARRATION_TOTAL_TIMEOUT_S + 1] * 20)
    monkeypatch.setattr(agent.time, "monotonic", lambda: next(clock))

    with pytest.raises(agent.AgentError) as excinfo:
        agent.narrate(_long_text(), unit_id="job-1")
    assert "1 of" in str(excinfo.value)
    assert len(calls) == 1, "no retry once the wall clock is gone"
