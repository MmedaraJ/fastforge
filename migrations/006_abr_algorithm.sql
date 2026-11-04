BEGIN;
-- TEXT, not an enum. You will add algorithms and tune variants constantly
-- during this phase; a migration per experiment would make you stop running
-- experiments. Same reasoning as progress_stage in 002: enum-enforce
-- decisions, keep descriptive fields loose.
ALTER TABLE playback_sessions ADD COLUMN abr_algorithm TEXT;
COMMIT;