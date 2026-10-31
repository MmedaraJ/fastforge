BEGIN;

-- Where the packaged output lives, relative to the storage root.
-- NULL until the packaging stage runs, which also distinguishes assets
-- transcoded before this stage existed.
ALTER TABLE assets ADD COLUMN hls_path  TEXT;
ALTER TABLE assets ADD COLUMN dash_path TEXT;

COMMIT;