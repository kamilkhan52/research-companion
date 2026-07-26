-- M2, migration 1: who owns what.
--
-- Postgres holds OWNERSHIP AND INDEX ONLY. The content — papers, notes, transcripts — stays in
-- each project's git repository, because the git history *is* the record (an agent proposes, a
-- human approves, and only then does anything commit). Duplicating content here would create a
-- second source of truth that could disagree with the record, so this schema deliberately stores
-- no reading material at all.

create table if not exists rc_users (
    -- Mirrors the Supabase auth user id. Not a foreign key to auth.users: the backend connects as
    -- its own role and must work against a plain Postgres in tests and CI, where that schema does
    -- not exist. The id is only ever written from a VERIFIED JWT `sub` (app/auth.py), so the
    -- trust comes from the token check rather than from a constraint here.
    id           uuid primary key,
    email        text,
    created_at   timestamptz not null default now()
);

create table if not exists rc_projects (
    -- The project id is the directory name under PROJECTS_ROOT, so it is also a path segment.
    -- `projects._safe_pid` is the trust boundary that validates it; this constraint is a second,
    -- independent statement of the same rule, so a row that could not be turned back into a safe
    -- path cannot be stored in the first place.
    id           text primary key
                 constraint rc_projects_id_is_a_safe_path_segment
                 check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    owner_id     uuid not null references rc_users(id) on delete cascade,
    created_at   timestamptz not null default now(),
    adopted_at   timestamptz not null default now()
);

-- Every ownership question is "what does this user own?" or "who owns this project?". The primary
-- key answers the second; this answers the first.
create index if not exists rc_projects_owner_idx on rc_projects (owner_id);
