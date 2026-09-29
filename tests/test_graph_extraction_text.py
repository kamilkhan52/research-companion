"""DR-141: a long paper's reference list must reach the reference extraction.

The call used to send `text[:MAX_FULL_TEXT_CHARS]`. A long paper keeps its bibliography at the
end, so the model was asked for references from a text that held none and answered with none:
"No parseable references in the model's response", bought again on every rebuild.
"""
from __future__ import annotations

from app import graph


def _long_paper(body_chars: int, refs: int = 60) -> tuple[str, str]:
    body = "Stacked DRAM raises the bandwidth the array can sustain [12]. " * (body_chars // 60)
    entries = " ".join(f"[{i}] A. Author and B. Writer. Paper number {i}. In Proc. VLSI, 2024."
                       for i in range(1, refs + 1))
    return body, "References " + entries


def test_a_paper_that_fits_is_sent_whole():
    body, refs = _long_paper(20_000)
    text = body + refs
    assert graph.extraction_text(text) == text.strip()


def test_a_reference_list_past_the_cap_is_still_sent():
    """DeepSeek-V4.1-Flash: 160k characters, bibliography from 120,745, cap 120,000."""
    body, refs = _long_paper(150_000)
    text = body + refs
    assert text.index("References [1]") > graph.MAX_FULL_TEXT_CHARS

    sent = graph.extraction_text(text)

    assert len(sent) <= graph.MAX_FULL_TEXT_CHARS
    assert "[1] A. Author" in sent and "Paper number 60." in sent, "every reference arrives"
    assert sent.startswith(body[:1000]), "the body is cut from its end, not its start"
    assert "omitted here for length" in sent
    assert "[1] A. Author" not in text[:graph.MAX_FULL_TEXT_CHARS], "the old slice held none"


def test_the_word_references_in_running_prose_is_not_taken_for_the_list():
    prose = "The References To Prior Work section is later. " + "Body sentence here. " * 8_000
    _, refs = _long_paper(0)
    sent = graph.extraction_text(prose + refs)
    assert sent.count("omitted here for length") == 1
    assert sent.rstrip().endswith("2024.")
    assert "[1] A. Author" in sent


def test_a_long_paper_with_no_heading_keeps_the_old_slice():
    text = "lowercase body text without any list heading. " * 4_000
    assert graph.extraction_text(text) == text.strip()[:graph.MAX_FULL_TEXT_CHARS]


def test_a_very_long_reference_list_is_bounded():
    body, refs = _long_paper(150_000, refs=2_000)
    sent = graph.extraction_text(body + refs)
    assert len(sent) <= graph.MAX_FULL_TEXT_CHARS
    assert "[1] A. Author" in sent


def test_the_extraction_call_is_given_the_reference_list(monkeypatch):
    """The opposite side of the contract: what `extract_references_for_paper` actually sends."""
    sent: list[str] = []

    def fake_complete(messages, **kwargs):
        sent.append(messages[-1]["content"])
        return '{"references": [{"index": 1, "title": "Paper number 1", "significant": true}]}'

    monkeypatch.setattr(graph.config, "load_settings",
                        lambda: {"openrouter_api_key": "k", "model": "m"})
    monkeypatch.setattr(graph.llm, "complete", fake_complete)
    body, refs = _long_paper(150_000)

    result = graph.extract_references_for_paper("p", "Paper P", body + refs, "m")

    assert result["status"] == "done"
    assert "[60] A. Author" in sent[0]


def test_a_list_before_the_halfway_point_with_a_long_appendix_after_it_is_sent():
    """Llama 2: 260k characters, bibliography at 124k (47%), appendix after. A "second half of
    the paper" rule rejected the only heading and sent the old slice, which held no list."""
    body, refs = _long_paper(124_000)
    appendix = " A Appendix. " + "Additional results and prompts follow in detail. " * 2_700
    text = body + refs + appendix
    at = text.index("References [1]")
    assert graph.MAX_FULL_TEXT_CHARS < at < len(text) // 2

    sent = graph.extraction_text(text)

    assert len(sent) <= graph.MAX_FULL_TEXT_CHARS
    assert "[1] A. Author" in sent and "Paper number 60." in sent
