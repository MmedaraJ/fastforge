BEGIN;

-- What you SAY the network was during the session: a free-text label set from
-- the ?net= URL parameter ("2500k", "3g", "none"). TEXT rather than an enum
-- because you'll invent new profiles per experiment.
ALTER TABLE playback_sessions ADD COLUMN network_profile TEXT;

-- What the network actually DELIVERED, measured by the player: total video
-- bytes downloaded divided by total time spent downloading them. This is the
-- check on the label above. If a session labelled "2500k" measured 900, the
-- throttle wasn't set the way you thought.
ALTER TABLE playback_sessions ADD COLUMN measured_throughput_kbps INT;

COMMIT;
