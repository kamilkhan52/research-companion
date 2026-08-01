-- M3: durable, fail-closed provider-spend reservations.
--
-- Usage events are observational and best-effort. They cannot authorize spend: an analytics
-- outage must not fail work that already completed, while an admission outage must refuse work
-- before a provider call begins. These rows are the authoritative second system. A reservation
-- consumes its pessimistic maximum until it is settled to actual cost or safely released.

create table if not exists rc_usage_reservations (
    id                   uuid primary key default gen_random_uuid(),
    user_id              uuid not null references rc_users(id) on delete cascade,
    -- Null is app-global work attributed to the verified user. As with usage events, project_id
    -- deliberately has no FK: ordinary project deletion retains accounting history. The reserve
    -- transaction locks and proves the live (user, project) ownership row before inserting.
    project_id           text
                         constraint rc_usage_reservations_project_id_safe
                         check (
                             project_id is null or (
                                 project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
                                 and length(project_id) <= 255
                             )
                         ),
    -- Stable internal retry key, normally job-id + provider. It contains no reader content.
    reservation_key      text not null
                         constraint rc_usage_reservations_key_bounded
                         check (length(reservation_key) between 1 and 192),
    job_id               text not null
                         constraint rc_usage_reservations_job_bounded
                         check (length(job_id) between 1 and 128),
    provider             text not null
                         constraint rc_usage_reservations_provider_allowed
                         check (provider in (
                             'openrouter', 'openai', 'firecrawl',
                             'openalex', 'semantic_scholar'
                         )),
    operation            text not null
                         constraint rc_usage_reservations_operation_bounded
                         check (length(operation) between 1 and 64),
    model                text not null
                         constraint rc_usage_reservations_model_bounded
                         check (length(model) between 1 and 256),
    state                text not null default 'reserved'
                         constraint rc_usage_reservations_state_allowed
                         check (state in ('reserved', 'settled', 'released', 'expired')),
    reserved_nanousd     bigint not null
                         constraint rc_usage_reservations_reserved_positive
                         check (reserved_nanousd > 0),
    actual_nanousd       bigint
                         constraint rc_usage_reservations_actual_nonnegative
                         check (actual_nanousd is null or actual_nanousd >= 0),
    settlement_kind      text
                         constraint rc_usage_reservations_settlement_kind_allowed
                         check (settlement_kind is null or settlement_kind in ('exact', 'conservative')),
    period_start         timestamptz not null,
    period_end           timestamptz not null,
    lease_expires_at     timestamptz not null,
    dispatched_at        timestamptz,
    -- Set only after every provider attempt in this reservation has returned and every known
    -- generation/cost has been durably linked. Without it, a crash may have left one more request
    -- in flight, so summing the generation ids we happened to receive could under-count spend.
    dispatches_complete_at timestamptz,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    finalized_at         timestamptz,

    constraint rc_usage_reservations_period_valid check (period_end > period_start),
    constraint rc_usage_reservations_lease_valid check (lease_expires_at >= created_at),
    -- A possibly-dispatched reservation is never released or expired. If exact provider data is
    -- unavailable after a crash, it is settled conservatively to the reserved maximum instead.
    constraint rc_usage_reservations_state_shape check (
        (state = 'reserved' and actual_nanousd is null
                            and settlement_kind is null and finalized_at is null)
        or
        (state = 'settled' and actual_nanousd is not null and dispatched_at is not null
             and settlement_kind is not null and finalized_at is not null
             and (settlement_kind = 'conservative' or dispatches_complete_at is not null))
        or
        (state in ('released', 'expired') and actual_nanousd is null
             and settlement_kind is null and finalized_at is not null
             and dispatched_at is null and dispatches_complete_at is null)
    ),
    unique (user_id, reservation_key)
);

-- Every network dispatch gets its own durable attempt BEFORE bytes are sent. Without this table a
-- multi-request job can crash with one known generation and another request still in flight; a
-- reconciler that sums only known generations would silently under-count the second. The sum of
-- attempt maxima may never exceed the parent reservation.
create table if not exists rc_usage_reservation_attempts (
    id               uuid primary key default gen_random_uuid(),
    reservation_id   uuid not null references rc_usage_reservations(id) on delete cascade,
    attempt_key      text not null
                     constraint rc_usage_reservation_attempts_key_bounded
                     check (length(attempt_key) between 1 and 128),
    provider         text not null
                     constraint rc_usage_reservation_attempts_provider_allowed
                     check (provider in (
                         'openrouter', 'openai', 'firecrawl',
                         'openalex', 'semantic_scholar'
                     )),
    maximum_nanousd  bigint not null
                     constraint rc_usage_reservation_attempts_maximum_positive
                     check (maximum_nanousd > 0),
    state            text not null default 'dispatched'
                     constraint rc_usage_reservation_attempts_state_allowed
                     check (state in ('dispatched', 'resolved')),
    actual_nanousd   bigint
                     constraint rc_usage_reservation_attempts_actual_nonnegative
                     check (actual_nanousd is null or actual_nanousd >= 0),
    settlement_kind  text
                     constraint rc_usage_reservation_attempts_settlement_kind_allowed
                     check (settlement_kind is null or settlement_kind in ('exact', 'conservative')),
    generation_id    text
                     constraint rc_usage_reservation_attempts_generation_bounded
                     check (generation_id is null or length(generation_id) between 1 and 256),
    dispatched_at    timestamptz not null default now(),
    resolved_at      timestamptz,

    constraint rc_usage_reservation_attempts_state_shape check (
        (state = 'dispatched' and actual_nanousd is null
                              and settlement_kind is null and resolved_at is null)
        or
        (state = 'resolved' and actual_nanousd is not null
                            and settlement_kind is not null and resolved_at is not null)
    ),
    unique (reservation_id, attempt_key)
);

create unique index if not exists rc_usage_reservation_attempts_generation_uniq
    on rc_usage_reservation_attempts (provider, generation_id)
    where generation_id is not null;
create index if not exists rc_usage_reservation_attempts_unresolved_idx
    on rc_usage_reservation_attempts (reservation_id, dispatched_at)
    where state = 'dispatched';

create index if not exists rc_usage_reservations_user_period_idx
    on rc_usage_reservations (user_id, period_start, period_end);
create index if not exists rc_usage_reservations_stale_idx
    on rc_usage_reservations (lease_expires_at)
    where state = 'reserved';
create index if not exists rc_usage_reservations_job_idx
    on rc_usage_reservations (user_id, job_id);
