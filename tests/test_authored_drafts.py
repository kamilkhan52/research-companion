from app import sessions


def test_accepted_drafts_expose_only_human_authored_inputs(temp_project):
    sessions.start_session("paper", "Paper")
    sessions.record_user("paper", "What is the key result?", kind="reply")
    sessions.record_user("paper", "internal finish instruction", kind="finish")
    sessions.record_user(
        "paper",
        "rendered model instruction containing feedback",
        kind="revision",
        authored_text="Clarify the comparison.",
    )

    assert sessions.accepted_drafts("paper") == [
        {"kind": "reply", "text": "What is the key result?"},
        {"kind": "revision", "text": "Clarify the comparison."},
    ]


def test_editing_a_reply_updates_its_accepted_draft(temp_project):
    sessions.start_session("paper", "Paper")
    sessions.record_user("paper", "Original", kind="reply")

    assert sessions.edit_reply("paper", 0, "Edited") is True
    assert sessions.accepted_drafts("paper") == [{"kind": "reply", "text": "Edited"}]
