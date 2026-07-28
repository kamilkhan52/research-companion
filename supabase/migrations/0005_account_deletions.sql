-- M2.5: durable, retry-safe account deletion and post-deletion admission tombstones.
--
-- This row must outlive rc_users: Supabase access tokens already issued to a deleted Auth user
-- remain valid until their expiry, and a process can crash after application data is gone but
-- before the Auth Admin request completes. `subject_key` is a one-way pseudonym of the verified
-- JWT subject. The raw UUID is retained only while a request still needs the Auth deletion call,
-- then cleared on completion.

create table if not exists rc_account_deletions (
    subject_key  text primary key
                 constraint rc_account_deletions_subject_key_is_hash
                 check (subject_key ~ '^[0-9a-f]{32}$'),
    user_id      uuid,
    status       text not null default 'pending'
                 constraint rc_account_deletions_status_allowed
                 check (status in (
                     'pending', 'draining', 'deleting_data',
                     'deleting_identity', 'error', 'completed'
                 )),
    error_code   text
                 constraint rc_account_deletions_error_code_bounded
                 check (error_code is null or length(error_code) <= 128),
    attempts     integer not null default 0
                 constraint rc_account_deletions_attempts_nonnegative check (attempts >= 0),
    requested_at timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    completed_at timestamptz
);

-- A raw identity can have only one active durable request. Completed rows clear user_id but keep
-- subject_key as the non-content admission tombstone for old JWTs and anti-reentry.
create unique index if not exists rc_account_deletions_live_user_idx
    on rc_account_deletions (user_id) where user_id is not null;
