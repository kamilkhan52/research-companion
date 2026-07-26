# Migrations

Plain `.sql` files, applied in filename order by `app.db.migrate()` and recorded in
`rc_schema_migrations` so re-running is a no-op.

**Forward-only.** There are no down-migrations: the roadmap's rollback plan for M2 is a database
snapshot taken before applying, not a reverse script. A down-migration that is never exercised is
a false comfort, and one that *is* exercised on live ownership data is a way to lose it.

**Every migration must be idempotent** — `create table if not exists`, `add column if not exists`,
`create index if not exists`, and alters that are no-ops when already applied. This is not style. The
ledger (`rc_schema_migrations`) lives in the schema Supabase exposes over its Data API, so it cannot
be trusted to say what actually ran: `app.db.migrate()` verifies the schema against
`db._REQUIRED_TABLES` afterwards and, if the two disagree, clears the ledger and re-applies
everything. A migration that is not safe to run twice turns that recovery into a failure.

Adding a table also means adding it to `_REQUIRED_TABLES`; `tests/test_tenancy.py` asserts the two
match by running a real migrate, so forgetting fails in CI. Nothing else is needed — taking the
table off the Data API is handled for every `rc_*` table by `db._enforce_data_api_lockout`.

Name them `NNNN_short_description.sql`. The number orders them; nothing parses the description.
