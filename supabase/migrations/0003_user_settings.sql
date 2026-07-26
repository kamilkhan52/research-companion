-- Per-user preferences.
--
-- `/api/settings` used to be one document holding both the instance's provider keys and every
-- reader's model/voice choice. Slice 2a restricted writing it to the operator, which was right for
-- the keys and wrong for the rest — a reader could no longer change their own voice. This table is
-- the "rest": preferences that belong to a person, layered over the instance defaults at read time
-- rather than copied, so an operator changing a default still moves everyone who has not chosen.
--
-- Key-value rows rather than one jsonb blob, for the CHECK below.

create table if not exists rc_user_settings (
    user_id     uuid        not null references rc_users(id) on delete cascade,
    key         text        not null,
    value       text        not null,
    updated_at  timestamptz not null default now(),
    primary key (user_id, key),

    -- The trust boundary, in the schema rather than only in Python.
    --
    -- `config.USER_SETTING_KEYS` is checked before anything is written here, so this constraint is
    -- redundant on the happy path — which is the point. A user who could get an arbitrary key into
    -- this table could store `openrouter_api_key`, and since these rows are layered OVER the
    -- instance document at read time, the instance would then make paid calls with a key that user
    -- chose. Postgres refusing the row means that requires a mistake in two places, not one.
    --
    -- Adding a preference therefore needs a migration extending this list. That friction is
    -- deliberate; `tests/test_user_settings.py` asserts every key in USER_SETTING_KEYS actually
    -- stores, so the two cannot drift silently.
    constraint rc_user_settings_key_allowed check (key in (
        'model', 'narration_model', 'preview_model',
        'speech_provider', 'tts_model', 'tts_voice', 'prior_notes_scope')),

    -- These are model ids and voice names. The column is user-writable, so it gets a ceiling:
    -- without one a signed-in user can grow the database a megabyte per request.
    constraint rc_user_settings_value_bounded check (length(value) <= 4096)
);
