"""The batch protocol: reconciliation by number, and failing open rather than failing shut.

These are the tests that matter most in the funnel. A batched cheap screen that misaligns its
rows attaches verdicts to the wrong papers, and nothing downstream can tell — "paper 41 scored 8"
looks identical whether or not 41 is the paper the model actually judged.
"""
from __future__ import annotations

from app import discovery_batch


def _items(n: int) -> list[dict]:
    return [{"title": f"Paper {i}"} for i in range(1, n + 1)]


def _render(index: int, item: dict) -> str:
    return f"{index}|{item['title']}"


def _llm(reply: str):
    return lambda system, user: reply


# ---------- parse_rows ----------

def test_rows_are_matched_by_echoed_number_not_by_position():
    """The whole point of the protocol. A model that answers out of order must still be read
    correctly — reading positionally would silently swap two papers' verdicts."""
    reply = "3|K|SURVEY\n1|D|OFF-TOPIC\n2|K|METHOD"
    parsed = discovery_batch.parse_rows(reply, [1, 2, 3])
    assert parsed.values[1][0] == "D"
    assert parsed.values[2][0] == "K"
    assert parsed.values[3][0] == "K"
    assert parsed.missing == []


def test_a_number_we_never_sent_is_discarded_rather_than_guessed_at():
    parsed = discovery_batch.parse_rows("1|K|METHOD\n99|K|METHOD", [1, 2])
    assert parsed.unknown_rows == 1
    assert parsed.missing == [2]          # 99 did not stand in for the missing 2
    assert 99 not in parsed.values


def test_the_first_answer_for_a_number_wins():
    """A repeated number is usually a restatement, not a correction — and preferring the later
    row would let a truncated retry overwrite a good answer."""
    parsed = discovery_batch.parse_rows("1|K|METHOD\n1|D|OFF-TOPIC", [1])
    assert parsed.values[1][0] == "K"
    assert parsed.duplicate_rows == 1


def test_prose_around_the_rows_is_ignored():
    reply = "Here are my judgements:\n```\n1|K|METHOD\n```\nLet me know if you need more."
    parsed = discovery_batch.parse_rows(reply, [1])
    assert parsed.values[1][0] == "K"


def test_a_truncated_tail_is_reported_as_missing_not_silently_accepted():
    parsed = discovery_batch.parse_rows("1|K|A\n2|K|B", [1, 2, 3, 4])
    assert parsed.missing == [3, 4]
    assert parsed.loss_ratio == 0.5


def test_an_echoed_number_with_no_answer_is_not_an_answer():
    parsed = discovery_batch.parse_rows("1|\n2|K|METHOD", [1, 2])
    assert parsed.missing == [1]


def test_a_runaway_reply_is_cut_off_rather_than_parsed_forever():
    reply = "\n".join("1|K|METHOD" for _ in range(5_000))
    parsed = discovery_batch.parse_rows(reply, [1])
    assert parsed.degraded and "tail" in parsed.degraded[0]


# ---------- run_batches ----------

def test_items_are_numbered_across_the_whole_stage_not_per_batch():
    """Indices must be stable across batch boundaries, or a caller cannot map a verdict back to
    a candidate without tracking where each batch started."""
    seen: list[str] = []

    def llm(system, user):
        seen.append(user)
        return "\n".join(line.split("|")[0] + "|K|METHOD" for line in user.splitlines())

    values, audit = discovery_batch.run_batches(
        _items(5), batch_size=2, system="s", render_item=_render, llm_fn=llm)

    assert sorted(values) == [1, 2, 3, 4, 5]
    assert seen[1].splitlines()[0].startswith("3|")   # second batch continues at 3, not 1
    assert audit["batches"] == 3


def test_an_unanswered_item_is_counted_rather_than_quietly_dropped():
    values, audit = discovery_batch.run_batches(
        _items(3), batch_size=3, system="s", render_item=_render,
        llm_fn=_llm("1|K|METHOD"))
    assert sorted(values) == [1]
    assert audit["missing"] == 2
    assert audit["failed_open"] == 2


def test_a_batch_that_loses_most_rows_is_retried_once_at_half_size():
    calls = {"n": 0}

    def llm(system, user):
        calls["n"] += 1
        lines = user.splitlines()
        if calls["n"] == 1:
            return "1|K|METHOD"                       # 1 of 4 -> 75% loss, over the threshold
        return "\n".join(line.split("|")[0] + "|K|METHOD" for line in lines)

    values, audit = discovery_batch.run_batches(
        _items(4), batch_size=4, system="s", render_item=_render, llm_fn=llm)

    assert audit["retried"] == 1
    assert calls["n"] == 3                            # the original, then two halves
    assert sorted(values) == [1, 2, 3, 4]             # the retry recovered everything


def test_a_batch_that_fails_twice_passes_its_items_through_rather_than_killing_the_run():
    values, audit = discovery_batch.run_batches(
        _items(4), batch_size=4, system="s", render_item=_render, llm_fn=_llm("garbage"))
    assert values == {}                               # nothing judged
    assert audit["failed_open"] == 4                  # ...and nothing lost either
    assert audit["degraded"]


def test_a_transport_failure_in_one_batch_does_not_discard_the_others():
    """The pipeline this replaces raised on a single bad response and threw away the whole run."""
    calls = {"n": 0}

    def llm(system, user):
        calls["n"] += 1
        if calls["n"] == 1:
            raise TimeoutError("provider hiccup")
        return "\n".join(line.split("|")[0] + "|K|METHOD" for line in user.splitlines())

    values, audit = discovery_batch.run_batches(
        _items(4), batch_size=2, system="s", render_item=_render, llm_fn=llm)

    assert sorted(values) == [3, 4]                   # the second batch still produced verdicts
    assert audit["failed_open"] == 2
    assert any("TimeoutError" in note for note in audit["degraded"])


# ---------- lane fairness and merge safety (Sol review, PR #306) ----------

def test_one_recall_lane_cannot_starve_another_at_the_cap():
    """A single well-cited anchor can contribute hundreds of forward citations, and grounded
    candidates are merged first. Applying the cap in input order would fill the entire budget
    from one lane and silently delete the lexical results — the only lane a project with no
    library has at all."""
    from app.discovery import _interleave_by_lane
    grounded = [{"title": f"g{i}", "channels": ["cites"]} for i in range(500)]
    lexical = [{"title": f"l{i}", "channels": ["lexical"]} for i in range(50)]

    capped = _interleave_by_lane(grounded + lexical, 100)
    lanes = {c["channels"][0] for c in capped}
    assert lanes == {"cites", "lexical"}
    assert sum(1 for c in capped if c["channels"][0] == "lexical") >= 40
    assert len(capped) == 100


def test_a_cap_larger_than_the_input_changes_nothing():
    from app.discovery import _interleave_by_lane
    items = [{"title": "a", "channels": ["cites"]}, {"title": "b", "channels": ["lexical"]}]
    assert _interleave_by_lane(items, 10) == items


def test_title_drop_protections_keep_each_lane_and_time_stratum():
    from app.discovery import _title_protections

    candidates = [
        {"title": "old bulk", "year": 1995, "citation_count": 2, "channels": ["bulk"]},
        {"title": "new bulk", "year": 2026, "citation_count": 1, "channels": ["bulk"]},
        {"title": "topic one", "year": 2015, "citation_count": 3, "channels": ["topic"]},
        {"title": "topic two", "year": 2016, "citation_count": 2, "channels": ["topic"]},
    ]
    protected = _title_protections(candidates, "profile")
    assert all(id(candidate) in protected for candidate in candidates)


def test_title_drop_audit_sample_is_stable_and_nonempty_at_realistic_scale():
    from app.discovery import _title_protections

    candidates = [{"title": f"Paper {i}", "channels": ["bulk"]} for i in range(1_000)]
    first = _title_protections(candidates, "profile")
    second = _title_protections(candidates, "profile")
    audited = {key for key, priority in first.items() if priority == 10}
    assert audited == {key for key, priority in second.items() if priority == 10}
    assert 8 <= len(audited) <= 35   # deterministic ~2%, allowing ordinary hash variance


def test_two_papers_sharing_a_title_are_not_merged_into_a_hybrid():
    """Distinct works share exact titles. Merging them would blend two papers into one row whose
    screening verdict, citations and provenance describe neither."""
    from app import discovery_recall
    from app.discovery import _identity_keys, _merge_candidate

    same_title = "A Study of Scaling"
    a = {"title": same_title, "doi": "10.1/aaa", "citation_count": 10}
    b = {"title": same_title, "doi": "10.1/bbb", "citation_count": 9000}

    merged = discovery_recall.merge_candidates(
        [[a], [b]], identity_keys=_identity_keys, merge_fn=_merge_candidate)
    assert len(merged) == 2, "two different DOIs were collapsed into one candidate"
    assert {c["doi"] for c in merged} == {"10.1/aaa", "10.1/bbb"}


def test_the_same_paper_from_two_channels_merges_and_unions_its_provenance():
    from app import discovery_recall
    from app.discovery import _identity_keys, _merge_candidate

    from_cites = {"title": "T", "doi": "10.1/x", "channels": ["cites"],
                  "provenance": [{"channel": "cites"}], "sources": ["openalex"]}
    from_lexical = {"title": "T", "doi": "10.1/x", "channels": ["lexical"],
                    "provenance": [{"channel": "lexical"}], "sources": ["arxiv"]}

    merged = discovery_recall.merge_candidates(
        [[from_cites], [from_lexical]], identity_keys=_identity_keys, merge_fn=_merge_candidate)
    assert len(merged) == 1
    assert set(merged[0]["channels"]) == {"cites", "lexical"}
    assert len(merged[0]["provenance"]) == 2


# DR-113 — Kamil's Discover results showed the same paper at two adjacent ranks, under a React
# "two children with the same key" error toast. Both halves of that are asserted here: the merge
# that should have happened, and the invariant that must hold even when it must not.

def test_an_arxiv_doi_and_a_publisher_doi_for_one_arxiv_id_are_the_same_paper():
    """arXiv mints its own DOI for every preprint, so a published work has TWO real DOIs and
    which one a row carries is a property of the PROVIDER. SpAtten reached the pipeline as
    10.48550/arXiv.2012.09852 from one source and 10.1109/hpca… from another, and the pipeline
    split it into two rows that then collided."""
    from app import discovery_recall
    from app.discovery import _identity_keys, _merge_candidate

    from_openalex = {"title": "SpAtten", "arxiv_id": "2012.09852",
                     "doi": "10.1109/hpca51647.2021.00018", "channels": ["cites"],
                     "sources": ["openalex"]}
    from_arxiv = {"title": "SpAtten", "arxiv_id": "2012.09852",
                  "doi": "10.48550/arxiv.2012.09852", "channels": ["lexical"],
                  "sources": ["arxiv"]}

    merged = discovery_recall.merge_candidates(
        [[from_openalex], [from_arxiv]], identity_keys=_identity_keys, merge_fn=_merge_candidate)
    assert len(merged) == 1, "one paper, reported under both of its real DOIs, became two rows"
    assert set(merged[0]["channels"]) == {"cites", "lexical"}
    # A DOI that merely LOOKS arXiv-ish must not excuse a real disagreement.
    other = {"title": "SpAtten", "arxiv_id": "2012.09852", "doi": "10.48550/arxiv.9999.99999"}
    assert discovery_recall._strong_ids_conflict(from_openalex, other)


def test_an_arxiv_version_suffix_is_not_a_different_paper():
    """The second half of the same hazard, found while probing the first: `_identity_keys` strips
    `vN` when it builds `arxiv:` keys, so `2012.09852v2` and `2012.09852` are FOUND as one row —
    and a conflict test comparing the raw values would then declare them different papers, which
    is exactly how DR-113 put one paper on screen twice. The two normalisations must agree."""
    from app import discovery_recall
    from app.discovery import _identity_keys, _merge_candidate

    versioned = {"title": "P", "arxiv_id": "2012.09852v2", "doi": "10.48550/arxiv.2012.09852"}
    plain = {"title": "P", "arxiv_id": "2012.09852", "doi": "10.1109/hpca"}
    assert _identity_keys(versioned)[0] == _identity_keys(plain)[0]
    assert not discovery_recall._strong_ids_conflict(versioned, plain)
    assert len(discovery_recall.merge_candidates(
        [[versioned, plain]], identity_keys=_identity_keys, merge_fn=_merge_candidate)) == 1
    # Different papers still conflict, version suffixes or not.
    assert discovery_recall._strong_ids_conflict(
        {"arxiv_id": "2012.09852v1"}, {"arxiv_id": "2401.00001v1"})


def test_a_row_kept_apart_by_a_conflict_never_replaces_the_row_it_lost_to():
    """The duplicate Kamil saw was not two similar rows — it was ONE row emitted twice while the
    other was dropped: the conflicting row re-registered the winner's identity keys, so both
    `order` slots resolved to the same object."""
    from app import discovery_recall
    from app.discovery import _identity_keys, _merge_candidate

    # The rows must share their FIRST identity key for this to bite: that is the key the
    # incumbent's `order` slot resolves through, and the one the conflicting row used to
    # overwrite. Two rows that merely share a title each keep a private primary key and never
    # showed the bug — which is why the suite stayed green while Kamil's results held duplicates.
    a = {"title": "Same Words", "arxiv_id": "2401.00001", "doi": "10.1/aaa", "abstract": "first"}
    b = {"title": "Same Words", "arxiv_id": "2401.00001", "doi": "10.1/bbb", "abstract": "second"}
    assert _identity_keys(a)[0] == _identity_keys(b)[0]

    merged = discovery_recall.merge_candidates(
        [[a, b]], identity_keys=_identity_keys, merge_fn=_merge_candidate)
    assert len(merged) == 2
    assert merged[0] is not merged[1], "the same object was returned twice"
    assert [c["abstract"] for c in merged] == ["first", "second"], "a candidate was lost"


def test_merged_candidates_never_repeat_one_paper():
    """The property the client depends on: whatever identity disagreements arrive, the list it
    renders has no repeated identity (its React keys are candidate ids)."""
    from app import discovery_recall
    from app.discovery import _identity_keys, _merge_candidate

    rows = [
        {"title": "P", "arxiv_id": "2012.09852", "doi": "10.1109/x"},
        {"title": "P", "arxiv_id": "2012.09852", "doi": "10.48550/arxiv.2012.09852"},
        {"title": "P", "arxiv_id": "2012.09852"},
        {"title": "Q", "doi": "10.1/q"},
        {"title": "Q", "doi": "10.1/q"},
    ]
    merged = discovery_recall.merge_candidates(
        [rows], identity_keys=_identity_keys, merge_fn=_merge_candidate)
    ids = [id(c) for c in merged]
    assert len(ids) == len(set(ids))
    keys = [tuple(_identity_keys(c)) for c in merged]
    assert len(keys) == len(set(keys))


def test_an_openalex_only_row_matches_on_its_work_id_rather_than_its_title():
    from app import discovery_recall
    from app.discovery import _identity_keys, _merge_candidate

    a = {"title": "Same Words", "openalex_id": "https://openalex.org/W1", "sources": ["openalex"]}
    b = {"title": "Same Words", "openalex_id": "https://openalex.org/W2", "sources": ["openalex"]}
    merged = discovery_recall.merge_candidates(
        [[a], [b]], identity_keys=_identity_keys, merge_fn=_merge_candidate)
    assert len(merged) == 2


def test_screening_batches_run_concurrently():
    """Six sequential title batches took 707s and sixteen abstract batches took 878s on a real
    project — half an hour for one run. The batches are independent and network-bound, so this
    pins that they actually fan out rather than silently degrading to a serial loop."""
    import threading
    started = threading.Barrier(3, timeout=5)

    def llm(system, user):
        started.wait()          # only completes if three batches are in flight together
        return "\n".join(line.split("|")[0] + "|K|METHOD" for line in user.splitlines())

    values, audit = discovery_batch.run_batches(
        _items(6), batch_size=2, system="s", render_item=_render, llm_fn=llm)
    assert sorted(values) == [1, 2, 3, 4, 5, 6]
    assert audit["batches"] == 3
