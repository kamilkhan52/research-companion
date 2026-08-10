-- Which plan an account is on, and why.
--
-- Until now `plans.for_user` took a user id and ignored it: every account was on the
-- deployment-wide `RC_DEFAULT_PLAN`, and two accounts could not differ. This is the table that
-- makes the lookup real, and it is deliberately separate from `rc_user_settings`: a setting is
-- something a reader chooses, and this is something granted to them.
--
-- `source` records WHO decided. `operator` is a manual grant; `revenuecat` is an entitlement
-- carried by a webhook. Keeping the provenance means a manual grant is never silently overwritten
-- by a subscription sync that has no opinion about it, and an entitlement that lapses can be
-- distinguished from one that was never there.
--
-- `external_id` is the entitlement/product identifier the source used, kept so a mapping can be
-- audited against the provider dashboard without guessing. Never a payment token or a secret.
create table if not exists rc_account_plans (
    user_id      uuid primary key references rc_users(id) on delete cascade,
    -- Mirrors `plans.PLANS`. A CHECK rather than trust in the writer: the webhook is an EXTERNAL
    -- caller, and a plan name is what decides an allowance, so a typo must not become a stored
    -- entitlement. Adding a plan therefore needs a migration — that friction is the point.
    plan         text        not null check (plan in ('tester', 'free', 'basic')),
    source       text        not null check (source in ('operator', 'revenuecat')),
    external_id  text,
    updated_at   timestamptz not null default now()
);
