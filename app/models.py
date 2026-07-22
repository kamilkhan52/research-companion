"""Shared data shapes. Internal state uses dataclasses; the API layer (main.py) wraps
these in pydantic request/response models."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

# Paper lifecycle states (Section 2 of the architecture).
# Reserved "paper" for the cross-paper working-notes review chat (not a real list paper).
REVIEW_SLUG = "_review"
REVIEW_TITLE = "Working Notes Review"

UNREAD = "unread"
RETRIEVING = "retrieving"
IN_DISCUSSION = "in_discussion"
NOTES_DRAFTED = "notes_drafted"
COMMITTED = "committed"  # maps to reading-list status "read"


@dataclass
class Paper:
    slug: str
    title: str
    group: str
    list_status: str          # "unread" | "read" — from reading-list.md
    cites: list[str] = field(default_factory=list)
    retrieved: bool = False
    has_notes: bool = False
    session_state: str | None = None  # transient working state if a session exists
    arxiv_id: str = ""                # the entry's <!-- arxiv: ... --> id, when it has one
    source_url: str = ""              # original PDF/source URL recorded in the corpus header
    year: int | None = None           # publication year (explicit <!-- year --> or arXiv id)
    title_confirmed: bool = False      # human resolved the source-title confirmation prompt

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ProposedCommit:
    """What the agent proposes at completion; the human approves before it lands."""
    summary: str                 # one-line change description
    notes_block: str             # markdown Notes block appended to corpus/<slug>.md
    synthesis: str               # full rewritten content of synthesis.md

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Turn:
    role: str                    # "user" | "assistant"
    canonical: str               # scholarly version (the record)
    narration: str = ""          # spoken-word script (the ear)
    state_signal: str = ""       # "in_discussion" | "ready_to_draft_notes"
    proposed_commit: dict | None = None
    ts: str = ""

    def to_dict(self) -> dict:
        return asdict(self)
