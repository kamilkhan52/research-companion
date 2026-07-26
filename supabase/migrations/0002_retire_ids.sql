-- M2: a project id is never reused, even after the project is deleted.
--
-- Deleting a project used to remove its ownership row, which freed the id for `_unique_id` to hand
-- out again. That is an ABA: a request can pass the ownership check for project `foo`, and by the
-- time it resolves paths, `foo` has been deleted and RE-CREATED BY SOMEONE ELSE — so the request
-- reads or writes a different user's project while carrying an authorization that was genuine when
-- it was granted. Nothing in the request carries the incarnation, only the string.
--
-- So the row survives deletion as a tombstone: owner cleared (nobody can reach it) and `deleted_at`
-- set (the id stays taken). Ids are cheap; the alternative is threading a generation through every
-- request and draining in-flight ones before releasing an id.

alter table rc_projects alter column owner_id drop not null;
alter table rc_projects add column if not exists deleted_at timestamptz;

-- Reading "who owns this" must never return a retired project's former owner, so the tombstone
-- keeps the row but not the claim. A partial index keeps the live-ownership lookups unaffected.
create index if not exists rc_projects_live_owner_idx
    on rc_projects (owner_id) where deleted_at is null;
