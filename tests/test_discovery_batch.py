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
