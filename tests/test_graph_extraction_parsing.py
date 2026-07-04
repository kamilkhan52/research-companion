"""_extract_json / _clean_reference: parsing the LLM's response text into clean records.
No network calls — these operate purely on strings/dicts."""
from __future__ import annotations

import json

import pytest
from app.graph import GraphError, _clean_reference, _extract_json, _salvage_references


def test_extract_json_plain():
    assert _extract_json('{"references": []}') == {"references": []}


def test_extract_json_strips_markdown_fences():
    raw = '```json\n{"references": [{"title": "X"}]}\n```'
    assert _extract_json(raw) == {"references": [{"title": "X"}]}


def test_extract_json_strips_bare_fences():
    raw = '```\n{"references": []}\n```'
    assert _extract_json(raw) == {"references": []}


def test_extract_json_recovers_outermost_braces_amid_chatter():
    raw = 'Sure, here is the JSON:\n{"references": []}\nHope that helps!'
    assert _extract_json(raw) == {"references": []}


def test_extract_json_raises_graph_error_on_garbage():
    with pytest.raises(GraphError):
        _extract_json("not json at all, no braces either")


def test_clean_reference_fills_defaults_for_sparse_input():
    out = _clean_reference({"title": "Just a title"}, fallback_index=3)
    assert out["index"] == 3
    assert out["title"] == "Just a title"
    assert out["authors"] == []
    assert out["year"] is None
    assert out["significant"] is False
    assert out["confidence"] == 0.5


def test_clean_reference_clamps_confidence_to_0_1():
    assert _clean_reference({"confidence": 5}, 1)["confidence"] == 1.0
    assert _clean_reference({"confidence": -2}, 1)["confidence"] == 0.0


def test_clean_reference_truncates_long_raw_text_and_limits_contexts():
    ref = {"raw_text": "x" * 5000, "contexts": ["c1", "c2", "c3", "c4", "c5", "c6"]}
    out = _clean_reference(ref, 1)
    assert len(out["raw_text"]) == 2000
    assert len(out["contexts"]) == 4


def test_clean_reference_rejects_non_dict():
    assert _clean_reference("not a dict", 1) is None


def test_clean_reference_coerces_bad_year_to_none():
    assert _clean_reference({"year": "2024"}, 1)["year"] is None  # not an int -> dropped, not guessed
    assert _clean_reference({"year": 2024}, 1)["year"] == 2024


# ---------- salvage: recovering references from truncated/malformed JSON ----------

def test_salvage_recovers_complete_objects_before_truncation():
    # Simulates hitting max_tokens mid-array: two complete objects, then a cut-off third.
    content = (
        '{"references": ['
        '{"index": 1, "title": "Paper One", "significant": true},'
        '{"index": 2, "title": "Paper Two", "significant": false},'
        '{"index": 3, "title": "Paper Thr'  # truncated mid-string
    )
    refs = _salvage_references(content)
    assert [r["title"] for r in refs] == ["Paper One", "Paper Two"]


def test_salvage_handles_a_full_well_formed_array_too():
    payload = {"references": [{"title": "A"}, {"title": "B"}]}
    refs = _salvage_references(json.dumps(payload))
    assert [r["title"] for r in refs] == ["A", "B"]


def test_salvage_skips_one_malformed_object_but_keeps_the_rest():
    # A comma-corrupted middle object shouldn't sink the well-formed ones around it.
    content = (
        '{"references": ['
        '{"title": "Good One"},'
        '{"title": "Bad" "missing_comma": true},'
        '{"title": "Good Two"}'
        ']}'
    )
    refs = _salvage_references(content)
    titles = [r["title"] for r in refs]
    assert "Good One" in titles
    assert "Good Two" in titles
    assert "Bad" not in titles


def test_salvage_returns_empty_list_when_no_references_key_present():
    assert _salvage_references('{"something_else": []}') == []
    assert _salvage_references("not json at all") == []


def test_salvage_handles_quotes_and_braces_inside_string_values():
    # A context excerpt containing literal braces/quotes must not confuse the brace matcher.
    content = (
        '{"references": ['
        '{"title": "X", "contexts": ["as shown in {Figure 2} they say \\"it works\\""]}'
        ']}'
    )
    refs = _salvage_references(content)
    assert len(refs) == 1
    assert refs[0]["contexts"][0].startswith("as shown in {Figure 2}")
