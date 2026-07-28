-- M2.5: retain the former owner of every recoverably deleted project incarnation.
--
-- `owner_id` is deliberately cleared when a project is retired so no authorization query can
-- accidentally treat the tombstone as live. The repository remains under `.trash`, however, and
-- account deletion must still be able to find it. Keep the transition link separately, then index
-- the concrete trash directory too: before tombstones existed, one project id could be deleted and
-- reused, so project id alone does not identify a recoverable repository.
--
-- RESTRICT is intentional. Deleting an rc_users row before its trashed repositories are removed
-- would orphan personal data on disk. The eventual account-deletion coordinator must remove the
-- repositories and clear/delete these links before it can delete the user row.

alter table rc_projects
    add column if not exists deleted_owner_id uuid
    references rc_users(id) on delete restrict;

create index if not exists rc_projects_deleted_owner_idx
    on rc_projects (deleted_owner_id) where deleted_at is not null;

create table if not exists rc_project_trash (
    trash_name  text primary key
                constraint rc_project_trash_name_is_safe
                check (
                    trash_name ~ '^[A-Za-z0-9][A-Za-z0-9_-]*-[0-9]{8}-[0-9]{6}$'
                    and length(trash_name) <= 255
                ),
    project_id  text not null
                constraint rc_project_trash_project_id_is_safe
                check (
                    project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
                    and length(project_id) <= 255
                ),
    owner_id    uuid not null references rc_users(id) on delete restrict,
    trashed_at  timestamptz not null default now()
);

create index if not exists rc_project_trash_owner_idx
    on rc_project_trash (owner_id);

-- A deployment may briefly have an old application process connected after this migration lands.
-- Its release() statement knows nothing about deleted_owner_id. Preserve the owner in the database
-- so that transition cannot erase it; the adoption script can then bind the one matching concrete
-- trash entry. New code also writes rc_project_trash atomically and does not depend on the trigger.
create or replace function public.rc_preserve_deleted_project_owner()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    if old.owner_id is not null
       and new.owner_id is null
       and new.deleted_at is not null then
        new.deleted_owner_id := coalesce(new.deleted_owner_id, old.owner_id);
    elsif new.owner_id is not null then
        new.deleted_owner_id := null;
    end if;
    return new;
end
$$;

drop trigger if exists rc_preserve_deleted_project_owner on rc_projects;
create trigger rc_preserve_deleted_project_owner
before update on rc_projects
for each row execute function public.rc_preserve_deleted_project_owner();
