# Migrations

Plain `.sql` files, applied in filename order by `app.db.migrate()` and recorded in
`rc_schema_migrations` so re-running is a no-op.

**Forward-only.** There are no down-migrations: the roadmap's rollback plan for M2 is a database
snapshot taken before applying, not a reverse script. A down-migration that is never exercised is
a false comfort, and one that *is* exercised on live ownership data is a way to lose it.

Name them `NNNN_short_description.sql`. The number orders them; nothing parses the description.
