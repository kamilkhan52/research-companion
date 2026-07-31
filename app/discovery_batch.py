"""Batched cheap-model screening: the protocol, and the reconciler that survives it.

Discovery's funnel asks a cheap model to judge hundreds of papers per run. Doing that one request
per paper is unaffordable, so items go up in batches — and batching introduces exactly one
dangerous failure: the model returns the wrong NUMBER of rows, or the same rows in a different
order, and a positional reader silently attaches every verdict to the wrong paper. That is
undetectable downstream: nothing about "paper 41 scored 8" looks wrong.

So the contract is:

**Line-oriented, never nested JSON.** A cheap model emitting 150 JSON objects is where this
breaks. One item per line, pipe-delimited, is the format cheap models hold onto longest. This is
the same reasoning behind the section-marker protocol for prose (CLAUDE.md invariant 5).

**Every row echoes its item number, and reconciliation is BY THAT NUMBER — never by position.**
A row whose number we did not send is discarded rather than guessed at.

**Fail toward recall.** A missing row means "we do not know", and not-knowing must not silently
delete a paper. Unanswered items take `default_value` (KEEP, at the screening stages) and are
counted so the loss is visible rather than inferred.

**No batch failure may kill the run.** A batch that loses more than `MAX_LOSS_RATIO` of its rows
is retried once at half size; if it still fails, every item in it passes through with the default
and the run records a `degraded` note. Contrast the pipeline this replaces, where one malformed
JSON response raised and discarded the entire run's work.
"""
from __future__ import annotations

import os
import re
from collections.abc import Callable, Sequence

from . import jobs, logging_config

log = logging_config.get("discovery.batch")

#: Above this fraction of unanswered items, the batch is not trustworthy enough to accept as-is.
#: Chosen loose rather than tight: a handful of dropped rows is normal cheap-model behaviour and
#: is already handled by the default, while losing a fifth of a batch means the model lost the
#: format and a smaller batch is likely to recover it.
MAX_LOSS_RATIO = 0.20

#: Guards against a runaway response (a model that repeats itself) costing unbounded parse time.
MAX_ROWS_MULTIPLIER = 4

LlmFn = Callable[[str, str], str]


class BatchResult:
    """Parsed verdicts plus everything needed to tell how much to trust them."""

    def __init__(self) -> None:
        self.values: dict[int, list[str]] = {}   # item number -> parsed fields after the number
        self.answered = 0
        self.missing: list[int] = []
        self.unknown_rows = 0        # rows echoing a number we never sent
        self.duplicate_rows = 0      # a number answered more than once (first answer wins)
        self.degraded: list[str] = []

    @property
    def loss_ratio(self) -> float:
        total = self.answered + len(self.missing)
        return (len(self.missing) / total) if total else 0.0


_ROW_RE = re.compile(r"^\s*(\d+)\s*\|(.*)$")


def parse_rows(text: str, expected: Sequence[int], *, min_fields: int = 1) -> BatchResult:
    """Reconcile a model's reply against the item numbers we actually sent.

    `expected` is the authoritative set; anything else in the reply is noise. The first answer for
    a number wins — a model that repeats a number has usually restated, not corrected, and
    preferring the later row would let a truncated retry overwrite a good answer.
    """
    result = BatchResult()
    wanted = set(expected)
    limit = max(len(wanted) * MAX_ROWS_MULTIPLIER, 32)

    for line_no, line in enumerate(str(text or "").splitlines()):
        if line_no > limit:
            result.degraded.append("reply had far more rows than items; ignored the tail")
            break
        match = _ROW_RE.match(line)
        if not match:
            continue                      # prose, preamble, code fences — not an answer row
        number = int(match.group(1))
        if number not in wanted:
            result.unknown_rows += 1
            continue
        if number in result.values:
            result.duplicate_rows += 1
            continue
        fields = [part.strip() for part in match.group(2).split("|")]
        if len([f for f in fields if f]) < min_fields:
            continue                      # an echoed number with no usable answer is not an answer
        result.values[number] = fields

    result.answered = len(result.values)
    result.missing = sorted(n for n in wanted if n not in result.values)
    return result


def run_batches(
    items: Sequence[dict],
    *,
    batch_size: int,
    system: str,
    render_item: Callable[[int, dict], str],
    llm_fn: LlmFn,
    min_fields: int = 1,
    stage: str = "batch",
) -> tuple[dict[int, list[str]], dict]:
    """Screen `items` in batches, returning `{index -> fields}` and an audit block.

    Indices are 1-based positions in `items`, stable across the whole stage rather than per batch,
    so a caller can map a verdict back to a candidate without tracking batch boundaries.

    Never raises for model-side problems: a batch that fails twice passes through unanswered, and
    the audit block records it. A transport failure inside `llm_fn` is also absorbed — losing one
    batch to a network blip must not discard the batches that succeeded.
    """
    values: dict[int, list[str]] = {}
    audit = {"stage": stage, "items": len(items), "batches": 0, "answered": 0,
             "missing": 0, "unknown_rows": 0, "duplicate_rows": 0,
             "retried": 0, "failed_open": 0, "degraded": []}

    chunks = [list(enumerate(items[start:start + batch_size], start=start + 1))
              for start in range(0, len(items), batch_size)]

    # Batches are independent, and this stage dominated wall-clock: 6 sequential title batches took
    # 707s and 16 abstract batches took 878s on a 53-paper project — half an hour for one run. They
    # are network-bound, so running them concurrently is nearly free, and `run_parallel` rebinds the
    # contextvars each worker needs to attribute its own token spend (invariant 2).
    results = jobs.run_parallel(
        chunks, lambda chunk: _judge(chunk, system, render_item, llm_fn, min_fields),
        max_workers=concurrency(), thread_name_prefix=f"discover-{stage}")

    # Merge serially, in submission order, so the audit and the "first answer wins" rule stay
    # deterministic regardless of which batch happened to return first.
    for chunk, result in zip(chunks, results, strict=True):
        _absorb(chunk, result, values, audit)

    audit["answered"] = len(values)
    audit["missing"] = len(items) - len(values)
    return values, audit


def concurrency() -> int:
    """How many screening batches run at once. Bounded 1-12; 1 restores the serial behaviour."""
    try:
        n = int(os.environ.get("RC_DISCOVERY_BATCH_CONCURRENCY", "6"))
    except ValueError:
        n = 6
    return max(1, min(12, n))


def _judge(chunk: list[tuple[int, dict]], system: str,
           render_item: Callable[[int, dict], str], llm_fn: LlmFn, min_fields: int,
           *, allow_retry: bool = True) -> list[tuple[list, object]]:
    """Ask the model about one batch. Returns `[(subchunk, parsed_or_exception), ...]`.

    Pure with respect to the caller's state — it touches neither `values` nor the audit — so it is
    safe to run on a pool thread. A retry returns TWO entries, one per half, which is what lets the
    serial merge below reconstruct exactly what happened.
    """
    numbers = [n for n, _ in chunk]
    user = "\n".join(render_item(n, item) for n, item in chunk)

    try:
        reply = llm_fn(system, user)
    except Exception as e:  # noqa: BLE001 — one failed batch must not discard the others
        log.warning("discovery batch failed (%s); failing open for %d items",
                    type(e).__name__, len(chunk))
        return [(chunk, e)]

    parsed = parse_rows(reply, numbers, min_fields=min_fields)

    if parsed.loss_ratio > MAX_LOSS_RATIO and allow_retry and len(chunk) > 1:
        # The model lost the format rather than skipping a few rows. Halve and retry ONCE; a
        # retry loop here would multiply cost against a model that is not going to recover.
        log.info("discovery batch lost %.0f%% of %d rows; retrying at half size",
                 parsed.loss_ratio * 100, len(chunk))
        mid = len(chunk) // 2
        return [*_judge(chunk[:mid], system, render_item, llm_fn, min_fields, allow_retry=False),
                *_judge(chunk[mid:], system, render_item, llm_fn, min_fields, allow_retry=False),
                ("retried", None)]

    return [(chunk, parsed)]


def _absorb(chunk: list, result: object, values: dict[int, list[str]], audit: dict) -> None:
    """Fold one batch's outcome into the shared values/audit. Serial, so no locking is needed."""
    if isinstance(result, Exception):          # the whole stage failed for this batch
        audit["batches"] += 1
        audit["failed_open"] += len(chunk)
        audit["degraded"].append(
            f"batch of {len(chunk)} failed ({type(result).__name__}); "
            f"items passed through unjudged")
        return

    for subchunk, parsed in result:
        if subchunk == "retried":
            audit["retried"] += 1
            continue
        audit["batches"] += 1
        if isinstance(parsed, Exception):
            audit["failed_open"] += len(subchunk)
            audit["degraded"].append(
                f"batch of {len(subchunk)} failed ({type(parsed).__name__}); "
                f"items passed through unjudged")
            continue
        audit["unknown_rows"] += parsed.unknown_rows
        audit["duplicate_rows"] += parsed.duplicate_rows
        audit["degraded"].extend(parsed.degraded)
        for number, fields in parsed.values.items():
            values.setdefault(number, fields)   # first answer wins, across retries too
        if parsed.missing:
            audit["failed_open"] += len(parsed.missing)
            if parsed.loss_ratio > MAX_LOSS_RATIO:
                audit["degraded"].append(
                    f"batch of {len(subchunk)} answered only {parsed.answered}; "
                    f"{len(parsed.missing)} items passed through unjudged")
