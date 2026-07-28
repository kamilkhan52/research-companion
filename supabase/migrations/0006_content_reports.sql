-- M2.5: in-app reports of offensive AI-generated content.
--
-- Google Play's AI-Generated Content policy (verified 2026-07-28) requires that an app whose
-- content is AI-generated "contain in-app user reporting or flagging features that allow users to
-- report or flag offensive content to developers without needing to exit the app", and that those
-- reports inform moderation. This table is where they land.
--
-- **It stores a POINTER, not the content.** The offending text is an assistant turn, and turns live
-- in the project's git transcript, which is the record (invariant 4). Copying it here would create
-- a second copy able to disagree with the first, and would put paper and reading content into
-- Postgres, which holds ownership and index rows only. `project_id` + `paper_slug` + `reference`
-- are enough for an operator to find the exact turn; `reporter_note` is the reporter's own words,
-- which exist nowhere else and so are stored.
--
-- Deletion: `reporter_id` cascades from `rc_users`, so a reporter deleting their account takes
-- their reports with them. That is the same promise account deletion makes everywhere else and is
-- deliberate, even though it means losing moderation signal. Revisit only with a documented
-- retention basis; do not quietly switch it to `set null`, which would leave the note behind.

create table if not exists rc_content_reports (
    id            uuid primary key default gen_random_uuid(),
    reporter_id   uuid not null references rc_users (id) on delete cascade,
    -- Where the content was, not what it said. Nullable because not every surface is per-paper.
    -- 255 because that is what a project id actually is: `projects._PID_MAX_LENGTH` and
    -- `rc_projects.id`'s own CHECK both allow it, and `slugify` does not truncate. A tighter
    -- ceiling here made a LEGITIMATE project unreportable — the insert raised, the route returned
    -- 503 "please try again", and retrying could never succeed. Keep this in step with those two.
    project_id    text
                  constraint rc_content_reports_project_id_bounded
                  check (project_id is null or length(project_id) <= 255),
    paper_slug    text
                  constraint rc_content_reports_paper_slug_bounded
                  check (paper_slug is null or length(paper_slug) <= 256),
    reference     text
                  constraint rc_content_reports_reference_bounded
                  check (reference is null or length(reference) <= 256),
    -- Constrained in the schema as well as in Python: the allowed set is part of the contract, and
    -- a client that invents a value must fail at the boundary rather than store an unknown surface
    -- that no moderation query will ever look at. Same reasoning as rc_user_settings' key CHECK.
    surface       text not null
                  constraint rc_content_reports_surface_allowed
                  check (surface in ('discussion', 'narration', 'discovery', 'notes')),
    reason        text not null
                  constraint rc_content_reports_reason_allowed
                  check (reason in (
                      'offensive', 'harmful', 'sexual', 'violent',
                      'harassment', 'misinformation', 'other'
                  )),
    reporter_note text
                  constraint rc_content_reports_note_bounded
                  check (reporter_note is null or length(reporter_note) <= 2000),
    created_at    timestamptz not null default now(),
    -- Set when an operator has actioned it. Nullable rather than a status enum: the only two states
    -- that matter now are "waiting" and "dealt with", and M7 owns the review workflow.
    reviewed_at   timestamptz
);

-- The operator's one query: what is still waiting, oldest first.
create index if not exists rc_content_reports_pending_idx
    on rc_content_reports (created_at) where reviewed_at is null;
