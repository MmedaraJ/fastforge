BEGIN;

-- One row per audio language and per subtitle language an asset was packaged
-- with: what its manifests offer, and which file each came from.
--
-- assets.audio_path and audio_bitrate_kbps (004) stay. They describe the
-- default audio, which is all an asset packaged before this migration has.
CREATE TABLE tracks (
    asset_id   UUID    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL CHECK (kind IN ('audio', 'subtitles')),
    -- BCP 47, as written into the manifests: "en", not "eng".
    language   TEXT    NOT NULL,
    -- The menu name, HLS's NAME.
    label      TEXT    NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    -- The encoded audio file or the uploaded WebVTT file the packager read.
    path       TEXT    NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One row per file. Two tracks may share a language (a commentary beside
    -- the main English), so the language can't be the key.
    PRIMARY KEY (asset_id, kind, path)
);

COMMIT;