BEGIN;

-- enum: adding values is easy, removing is not; chose enum over TEXT+CHECK for storage/type-safety
CREATE TYPE asset_status AS ENUM ('queued', 'processing', 'ready', 'failed');

CREATE TABLE assets (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    source_size_bytes BIGINT NOT NULL,
    status asset_status NOT NULL DEFAULT 'queued',
    video_codec TEXT,
    width INT,
    height INT,
    duration_s NUMERIC,
    fps NUMERIC,
    audio_codec TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- SET status=$1, updated_at=now()
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE renditions (
    id UUID PRIMARY KEY,
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    video_codec TEXT NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    fps NUMERIC NOT NULL,
    bitrate_kbps INT NOT NULL,
    maxrate_kbps INT NOT NULL,
    bufsize_kbps INT NOT NULL,
    audio_codec TEXT NOT NULL,
    audio_bitrate_kbps INT NOT NULL,
    vmaf NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (asset_id, height)
);

COMMIT;