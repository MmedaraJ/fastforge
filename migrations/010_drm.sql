BEGIN;

-- How an asset is encrypted: 'clearkey' (your own key, your licence server)
-- or 'widevine-test' (Google's test key server and licence server). NULL is
-- a clear asset, which is every asset packaged before this migration.
ALTER TABLE assets ADD COLUMN drm TEXT CHECK (drm IN ('clearkey', 'widevine-test'));

-- One content key per clearkey asset, stored wrapped by the key-encryption
-- key (CONTENT_KEK). The key ID is public: every init segment and manifest
-- carries it. The key leaves this table unwrapped only inside a licence.
CREATE TABLE content_keys (
    asset_id    UUID        PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    key_id      BYTEA       NOT NULL UNIQUE CHECK (length(key_id) = 16),
    -- AES-256-GCM: a 12-byte nonce, the 16-byte key encrypted, a 16-byte tag.
    wrapped_key BYTEA       NOT NULL CHECK (length(wrapped_key) = 44),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;