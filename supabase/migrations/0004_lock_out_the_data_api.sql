-- Take these tables off Supabase's Data API.
--
-- Found in review of slice 4; it applies to every table since 0001.
--
-- Supabase exposes the `public` schema through PostgREST, and its default privileges grant the
-- `anon` and `authenticated` roles full DML on tables created there. The anon key is *published* —
-- it ships inside the mobile app, by design — so as things stood, anyone holding the app could
-- reach `https://<ref>.supabase.co/rest/v1/rc_projects` directly and skip this backend entirely.
--
-- Reading `rc_users` would hand over every user's email. Reading `rc_projects` would map out who
-- owns what. WRITING `rc_projects.owner_id` would be a full takeover: `tenancy.may_access` trusts
-- that column, so setting it to your own id makes another person's reading list yours, and the
-- backend would then serve it to you correctly, having been told the truth by a table the attacker
-- controls. `rc_user_settings` is the newest of the three and no different.
--
-- Two independent locks, because one of them not applying must not be enough:
--
-- 1. **RLS on, with no policies.** Supabase's guidance is unconditional — RLS must be enabled on
--    every table in an exposed schema — and a table with RLS on and zero policies denies every
--    API role. NOT `force`: the backend connects as the role that owns these tables (it created
--    them), and an owner is exempt from its own table's RLS unless forced. Forcing would lock out
--    the application instead of the attacker.
-- 2. **Revoke the grants outright.** RLS is a filter on top of a privilege; taking the privilege
--    away is the stronger statement, and it holds even if some later migration adds a policy that
--    is more generous than it looks. Wrapped in a role-existence check so this file also applies
--    to a plain Postgres — CI's service container and the local throwaway database have no `anon`
--    or `authenticated` role, and a migration that only runs on Supabase is a migration whose
--    effect is never tested.

alter table rc_users             enable row level security;
alter table rc_projects          enable row level security;
alter table rc_user_settings     enable row level security;
-- The bookkeeping table is in the exposed schema too, and it is not merely informational: a row
-- inserted here naming a migration that has not run yet makes `migrate()` skip it forever, and
-- deleting one makes it re-run. Both are reachable from the anon key without this.
alter table rc_schema_migrations enable row level security;

do $$
declare
    api_role text;
begin
    foreach api_role in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = api_role) then
            execute format(
                'revoke all on rc_users, rc_projects, rc_user_settings, rc_schema_migrations
                 from %I', api_role);
        end if;
    end loop;
end
$$;
