BEGIN;

-- Video renditions are now video-only: one audio track is encoded once and
-- shared by every rung. A rendition row describes a FILE, and that file no
-- longer contains audio, so these columns must be allowed to be absent.
ALTER TABLE renditions ALTER COLUMN audio_codec DROP NOT NULL;
ALTER TABLE renditions ALTER COLUMN audio_bitrate_kbps DROP NOT NULL;

-- The shared audio track belongs to the asset, beside the manifests that
-- reference it.
--
-- Naming wart worth fixing later: assets.audio_codec (added in 001) is the
-- SOURCE's codec, read by ffprobe. These two describe the OUTPUT. A future
-- migration should rename the probe columns to source_*.
ALTER TABLE assets ADD COLUMN audio_path TEXT;
ALTER TABLE assets ADD COLUMN audio_bitrate_kbps INT;

COMMIT;