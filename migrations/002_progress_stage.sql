BEGIN;

-- Stage-level progress for observability while status='processing'.
-- Deliberately TEXT, not enum: stages will change as the pipeline grows,
-- and nothing branches on this value — enum-enforce decisions, keep
-- descriptive fields loose. NULL = no stage info (not yet started).
ALTER TABLE assets ADD COLUMN progress_stage TEXT;

COMMIT;