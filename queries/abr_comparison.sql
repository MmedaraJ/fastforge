-- How do the ABR algorithms compare, separately for each network condition?
--
-- Usage:
--   docker compose exec -T db psql -U fastforge -v since=<UTC timestamp> < queries/abr_comparison.sql
--
-- `since` keeps only sessions recorded after that moment. Use the timestamp
-- from your first clean run's printed command (the created_at >= '...' part),
-- so manual test sessions from earlier don't get mixed into the results.
-- Leave it off to include every labelled session.
\if :{?since}
\else
\set since '-infinity'
\endif

-- Grouped by network_profile first: an algorithm's numbers only mean something
-- next to other algorithms' numbers from the SAME conditions. Rows without a
-- profile (everything recorded before migration 007) are excluded on purpose.
--
-- net_kbps is the median MEASURED throughput for the group. If it doesn't
-- match the profile label, check the throttle setting before trusting the row.
-- failed counts sessions that ended in an error or a timeout.
SELECT network_profile, engine, protocol, abr_algorithm,
       count(*)                                                        AS sessions,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY measured_throughput_kbps) AS net_kbps,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY startup_ms)        AS p50_startup,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY startup_ms)        AS p95_startup,
       round(100.0 * sum(rebuffer_ms)
             / nullif(sum(playing_ms + rebuffer_ms), 0), 2)            AS rebuffer_pct,
       round(avg(average_bitrate_kbps))                                AS avg_kbps,
       round(avg(switch_up_count + switch_down_count), 1)              AS avg_switches,
       count(*) FILTER (WHERE fatal_error IS NOT NULL)                 AS failed
FROM playback_sessions
WHERE abr_algorithm IS NOT NULL
  AND network_profile IS NOT NULL
  AND created_at >= :'since'
GROUP BY network_profile, engine, protocol, abr_algorithm
ORDER BY network_profile, engine, protocol, abr_algorithm;
