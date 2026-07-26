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
    -- `projects._safe_pid` is the trust boundary that validates it; this constraint restates the
    -- SAME rule independently, so a row that could not be turned back into a safe path cannot be
    -- stored in the first place.
    --
    -- It must mirror `_PID_RE` exactly, not tighten it. A stricter constraint would create a class
    -- of project the app can create and the database cannot record — `_PID_RE` allows uppercase
    -- and underscores (the code comment there notes underscores are tolerated for env-configured
    -- ids), so an id like `My_Project` would be accepted on disk and then abort the backfill
    -- part-way through with a raw constraint violation. The length bound is the filesystem's own
    -- limit on a path segment, so it cannot reject an id that already exists as a directory.
    id           text primary key
                 constraint rc_projects_id_is_a_safe_path_segment
                 check (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' and length(id) <= 255),
    -- RESTRICT, not CASCADE. A project is a DIRECTORY on disk with a git history in it, and no
    -- foreign key can delete that. Cascading would drop the ownership rows while leaving the
    -- directories in place — and the next backfill would then see them as unowned and adopt one
    -- person's reading under whoever RC_ADOPT_OWNER happens to name. Deleting a user has to be a
    -- deliberate operation that deals with the filesystem too (M7), so the database refuses to
    -- let it happen as a side effect.
    owner_id     uuid not null references rc_users(id) on delete restrict,
    created_at   timestamptz not null default now(),
    adopted_at   timestamptz not null default now()
);

-- Every ownership question is "what does this user own?" or "who owns this project?". The primary
-- key answers the second; this answers the first.
create index if not exists rc_projects_owner_idx on rc_projects (owner_id);
