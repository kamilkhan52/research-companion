-- M2.5: retain the former owner of a recoverably deleted project.
--
-- `owner_id` is deliberately cleared when a project is retired so no authorization query can
-- accidentally treat the tombstone as live. The repository remains under `.trash`, however, and
-- account deletion must still be able to find it. Keep that non-authorizing link separately.
--
-- RESTRICT is intentional. Deleting an rc_users row before its trashed repositories are removed
-- would orphan personal data on disk. The eventual account-deletion coordinator must remove the
-- repositories and clear/delete these links before it can delete the user row.

alter table rc_projects
    add column if not exists deleted_owner_id uuid
    references rc_users(id) on delete restrict;

create index if not exists rc_projects_deleted_owner_idx
    on rc_projects (deleted_owner_id) where deleted_at is not null;
