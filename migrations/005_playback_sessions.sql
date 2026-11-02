BEGIN;

CREATE TABLE playback_sessions (
  id                   UUID PRIMARY KEY,

  -- SET NULL, not CASCADE: telemetry outlives the thing it describes.
  asset_id             UUID REFERENCES assets(id) ON DELETE SET NULL,

  started_at           TIMESTAMPTZ NOT NULL,
  startup_ms           INT,          -- nullable: a session may never start
  playing_ms           INT NOT NULL,
  rebuffer_count       INT NOT NULL,
  rebuffer_ms          INT NOT NULL,
  switch_up_count      INT NOT NULL,
  switch_down_count    INT NOT NULL,
  average_bitrate_kbps INT,          -- nullable: nothing played, nothing to average
  dropped_frames       INT NOT NULL,
  fatal_error          TEXT,
  user_agent           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every question you will ask of this table is "how did asset X perform
-- recently", so index for that rather than adding it after the first slow query.
CREATE INDEX playback_sessions_asset_idx
  ON playback_sessions (asset_id, created_at DESC);

COMMIT;