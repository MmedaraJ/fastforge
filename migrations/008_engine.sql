BEGIN;

ALTER TABLE playback_sessions ADD COLUMN engine   TEXT;
ALTER TABLE playback_sessions ADD COLUMN protocol TEXT;

-- Filling in old rows is correct here, unlike with network_profile. Every
-- session before this migration ran on hls.js over HLS; there was no other
-- engine. That's a known fact, not a guess. Only fill in values you actually
-- know: a guessed value looks exactly as trustworthy as a real one, and nobody
-- can tell them apart later.
UPDATE playback_sessions SET engine = 'hlsjs', protocol = 'hls' WHERE engine IS NULL;

-- The control arm has been renamed; old rows get the new name.
UPDATE playback_sessions SET abr_algorithm = 'engine-default' WHERE abr_algorithm = 'hls-default';

COMMIT;