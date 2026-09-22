"""retriever.text_names_title (DR-165): is this extracted PDF the paper we asked for?

Two retrieval paths accept a PDF without comparing it to anything — the rate-limit web fallback
and the agentic hunt — and both filed a paper that CITES the requested one as its full text. The
fixtures below are the real first-page shapes from that incident and from the project corpus the
check was calibrated against.
"""
from __future__ import annotations

from app.retriever import text_names_title

CAPACITORLESS = "Accelerator Design using 3D Stacked Capacitorless DRAM for Large Language Models"
FULL_STACK_HEAD = (
    "A Full-Stack Performance Evaluation Infrastructure for 3D-DRAM-based LLM Accelerators "
    "Cong Li1 Chenhao Xue1 Yi Ren1 1Peking University 2Xi'an UniIC Semiconductors Abstract Large "
    "language models (LLMs) exhibit memory-intensive behavior during decoding, making it a key "
    "bottleneck in LLM inference. To accelerate decoding execution, hybrid-bonding-based 3D-DRAM "
    "has been adopted in LLM accelerators. We design a full-stack evaluation infrastructure using "
    "stacked DRAM models for large language model accelerator design. "
)


def test_the_paper_itself_is_recognised():
    assert text_names_title(CAPACITORLESS + " Janak Sharda, Shimeng Yu. Abstract …", CAPACITORLESS)


def test_a_same_field_paper_sharing_most_title_words_is_refused():
    # Most of the words (accelerator, design, using, stacked, dram, large, language, models) are
    # on this page — a bag-of-words test passes it. Order and proximity are what refuse it.
    assert not text_names_title(FULL_STACK_HEAD * 3, CAPACITORLESS)


def test_a_citer_carrying_the_title_only_in_its_bibliography_is_refused():
    body = FULL_STACK_HEAD + "Body. " * 2000 + f"[12] J. Sharda et al., {CAPACITORLESS}, AICAS 2024."
    assert not text_names_title(body, CAPACITORLESS)


def test_pypdf_dropping_the_spaces_in_a_large_title_still_matches():
    assert text_names_title("AcceleratorDesignusing3DStackedCapacitorlessDRAMforLarge"
                            "LanguageModels Janak Sharda Abstract", CAPACITORLESS)


def test_ligatures_and_punctuation_do_not_break_the_match():
    title = "Efficient Fine-Tuning: Flash Offloading"
    assert text_names_title("Eﬃcient Fine Tuning — Flash Oﬄoading\nAuthors", title)


def test_a_trailing_author_year_note_on_the_reading_list_title_is_ignored():
    head = "Training Compute-Optimal Large Language Models Jordan Hoffmann Abstract"
    assert text_names_title(head, "Training Compute-Optimal Large Language Models (Hoffmann et al., 2022)")


def test_a_system_name_prefix_at_the_top_vouches_for_another_version_title():
    head = "GPipe: Easy Scaling with Micro-Batch Pipeline Parallelism Yanping Huang Abstract"
    assert text_names_title(head, "Gpipe: Efficient training of giant neural networks using pipeline parallelism")


def test_the_name_prefix_is_found_past_a_column_of_review_line_numbers():
    head = (" ".join(str(i) for i in range(1, 111))
            + " MemServe: Flexible Mem Pool for Building Disaggregated LLM Serving with Caching"
            + " Cunchen Hu")
    assert text_names_title(head, "MemServe: Context Caching for Disaggregated LLM Serving")


def test_a_system_name_mentioned_only_in_a_citer_abstract_does_not_vouch():
    head = FULL_STACK_HEAD.replace("We design", "Unlike Tasa, we design")
    assert not text_names_title(head * 2, "Tasa: Thermal-aware 3D-stacked architecture design")


def test_a_follow_up_opening_on_the_same_system_name_needs_more_of_the_title():
    # Review P2: the name alone vouched for "Orca-2" when "Orca: …" was asked for.
    head = "Orca 2: Teaching Small Language Models How to Reason. Arindam Mitra Abstract …"
    assert not text_names_title(head, "Orca: A Distributed Serving System for Generative Models")


def test_a_short_title_is_not_matched_by_the_spaces_removed_comparison_deep_in_the_head():
    # Review P2: "flashattention" squashed matched any citer mentioning it in its abstract.
    head = ("PagedAttention for LLM Serving. Woosuk Kwon. Abstract: " + "filler words here. " * 20
            + "Unlike FlashAttention, we page the KV cache. " + "More text. " * 50)
    assert not text_names_title(head, "FlashAttention")


def test_a_pasted_paragraph_as_title_stays_cheap():
    import time
    title = " ".join(f"word{i}" for i in range(400))
    start = time.monotonic()
    text_names_title(" ".join(f"word{i}" for i in range(0, 800, 2)), title)
    assert time.monotonic() - start < 1.0


def test_a_title_with_nothing_to_check_is_not_refused():
    assert text_names_title("anything", "")
    assert text_names_title("anything", "On the")
