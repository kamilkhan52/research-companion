from app import sessions
from app.routers.session import ReplyComment, ReplyReq, _compose_reply_text, _prep_reply

from tests.conftest import add_paper


def test_empty_comments_preserve_plain_reply_exactly():
    req = ReplyReq(slug="paper", text="  ordinary reply  ")
    assert _compose_reply_text(req) == "  ordinary reply  "


def test_sentence_comments_compose_into_grounded_markdown_with_optional_free_text():
    req = ReplyReq(
        slug="paper",
        text="Also compare this with the baseline.",
        comments=[
            ReplyComment(
                quote="The SIMD execution model is a poor fit.",
                comment="Why is SIMD specifically the mismatch?",
            ),
            ReplyComment(
                quote="Bandwidth is not the only bottleneck.",
                comment="What evidence separates the bottlenecks?",
            ),
        ],
    )

    assert _compose_reply_text(req) == (
        "Regarding specific passages of your last response:\n\n"
        "> “The SIMD execution model is a poor fit.”\n"
        ">\n"
        "> — Why is SIMD specifically the mismatch?\n\n"
        "> “Bandwidth is not the only bottleneck.”\n"
        ">\n"
        "> — What evidence separates the bottlenecks?\n\n"
        "Also compare this with the baseline."
    )


def test_pure_annotation_reply_is_recorded_and_keeps_authored_text_for_reconciliation(
    temp_project,
):
    add_paper(temp_project, "paper", "Paper", full_text="body")
    sessions.start_session("paper", "Paper")
    req = ReplyReq(
        slug="paper",
        comments=[ReplyComment(quote="A precise claim.", comment="Please justify this.")],
    )

    _prep_reply(req)

    record = sessions.read_records("paper")[-1]
    assert record["text"].startswith("Regarding specific passages")
    assert "> “A precise claim.”" in record["text"]
    assert record["authored_text"] == ""
    assert sessions.accepted_drafts("paper")[-1] == {"kind": "reply", "text": ""}
