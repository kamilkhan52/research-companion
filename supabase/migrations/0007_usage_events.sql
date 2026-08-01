-- M3: append-only, per-user provider usage events.
--
-- The existing per-project `.state/usage.json` is a presentation cache: useful for a project
-- total, but unable to answer cost-per-user/day and unsafe as the source of a hard quota. This
-- table records one immutable fact per provider response (or one pending marker when the response
-- was accepted but authoritative cost did not arrive). It stores accounting metadata only — no
-- prompt, paper, transcript, narration, provider body, email, or other reading content.

create table if not exists rc_usage_events (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references rc_users(id) on delete cascade,
    -- Null is the explicit app-global/unattributed project scope. A project id is intentionally
    -- not a foreign key: deleting a project retires its ownership row in place by clearing
    -- owner_id, while historical spend must remain attributable to the account until that account
    -- is deleted. The INSERT in app/usage_events.py proves the live (user, project) ownership pair.
    project_id        text
                      constraint rc_usage_events_project_id_safe
                      check (
                          project_id is null or (
                              project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
                              and length(project_id) <= 255
                          )
                      ),
    event_type        text not null
                      constraint rc_usage_events_type_allowed
                      check (event_type in ('usage', 'pending')),
    operation         text not null
                      constraint rc_usage_events_operation_bounded
                      check (length(operation) between 1 and 64),
    model             text not null
                      constraint rc_usage_events_model_bounded
                      check (length(model) between 1 and 256),
    prompt_tokens     bigint not null default 0
                      constraint rc_usage_events_prompt_nonnegative check (prompt_tokens >= 0),
    completion_tokens bigint not null default 0
                      constraint rc_usage_events_completion_nonnegative
                      check (completion_tokens >= 0),
    total_tokens      bigint not null default 0
                      constraint rc_usage_events_total_nonnegative check (total_tokens >= 0),
    cost_nanousd      bigint not null default 0
                      constraint rc_usage_events_cost_nonnegative check (cost_nanousd >= 0),
    generation_id     text
                      constraint rc_usage_events_generation_bounded
                      check (generation_id is null or length(generation_id) between 1 and 256),
    estimated         boolean not null default false,
    created_at        timestamptz not null default now(),

    -- A pending row is a marker, never a fictional zero-cost completed call. Exact usage that
    -- later reconciles it is appended as a separate `usage` row with the same generation id.
    constraint rc_usage_events_pending_is_marker check (
        event_type <> 'pending' or (
            estimated and prompt_tokens = 0 and completion_tokens = 0
            and total_tokens = 0 and cost_nanousd = 0
        )
    )
);

-- Provider generation ids are idempotency keys. Retrying the analytics write must not double bill;
-- pending and resolved usage each get one row, preserving the append-only reconciliation history.
create unique index if not exists rc_usage_events_generation_kind_uniq
    on rc_usage_events (user_id, generation_id, event_type)
    where generation_id is not null;

create index if not exists rc_usage_events_user_time_idx
    on rc_usage_events (user_id, created_at desc);
create index if not exists rc_usage_events_user_operation_time_idx
    on rc_usage_events (user_id, operation, created_at desc);
create index if not exists rc_usage_events_project_time_idx
    on rc_usage_events (project_id, created_at desc) where project_id is not null;
