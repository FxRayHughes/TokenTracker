-- maplex: relay each opted-in user's aggregated usage to the official
-- TokenTracker leaderboard (tokentracker.cc).
--
-- One row per Maplex user who linked an official account. The official device
-- token (and a pending device-flow code) are stored AES-GCM encrypted by the
-- maplex-official-bridge edge function (key: function secret MAPLEX_BRIDGE_KEY).
-- Idempotent; run with:
--   psql -v ON_ERROR_STOP=1 -v refresh_secret="$LEADERBOARD_REFRESH_SECRET" -f official-bridge.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.maplex_official_links (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  device_token_ct text,
  official_user_id uuid,
  official_device_id uuid,
  pending_code_ct text,
  pending_user_code text,
  pending_verification_uri text,
  pending_expires_at timestamptz,
  relay_watermark timestamptz,
  relay_watermark_key text,
  last_relay_at timestamptz,
  next_allowed_at timestamptz,
  last_status text,
  last_error text,
  rows_sent bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.maplex_official_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maplex_official_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maplex_official_links TO project_admin;

-- Usage summed over the user's active devices, one row per hour/source/model,
-- oldest change first so a partial relay can resume from a watermark.
ALTER TABLE public.maplex_official_links ADD COLUMN IF NOT EXISTS relay_watermark_key text;

DROP FUNCTION IF EXISTS public.maplex_official_relay_rows(uuid, timestamptz, integer);
CREATE OR REPLACE FUNCTION public.maplex_official_relay_rows(p_user_id uuid, p_since timestamptz, p_since_key text, p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.max_updated, g.cursor_key), '[]'::jsonb)
  FROM (
    SELECT h.hour_start, h.source, h.model,
      sum(h.input_tokens)::bigint AS input_tokens,
      sum(h.cached_input_tokens)::bigint AS cached_input_tokens,
      sum(h.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      sum(h.output_tokens)::bigint AS output_tokens,
      sum(h.reasoning_output_tokens)::bigint AS reasoning_output_tokens,
      sum(h.total_tokens)::bigint AS total_tokens,
      sum(coalesce(h.billable_total_tokens, h.total_tokens))::bigint AS billable_total_tokens,
      sum(h.total_cost_usd) AS total_cost_usd,
      sum(h.conversations)::integer AS conversations,
      max(h.updated_at) AS max_updated,
      to_char(h.hour_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '|' || h.source || '|' || h.model AS cursor_key
    FROM public.tokentracker_hourly h
    JOIN public.tokentracker_devices d ON d.id = h.device_id AND d.revoked_at IS NULL
    WHERE h.user_id = p_user_id
    GROUP BY h.hour_start, h.source, h.model
    HAVING p_since IS NULL OR (max(h.updated_at), to_char(h.hour_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '|' || h.source || '|' || h.model)
      > (p_since, coalesce(p_since_key, ''))
    ORDER BY 13, 14
    LIMIT greatest(1, least(p_limit, 10000))
  ) g
$fn$;
REVOKE ALL ON FUNCTION public.maplex_official_relay_rows(uuid, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.maplex_official_relay_rows(uuid, timestamptz, text, integer) TO project_admin;

-- Cron: every 30 minutes the bridge uploads changes for every enabled link.
-- The secret is passed in by psql (-v refresh_secret=...) and never committed.
CREATE OR REPLACE FUNCTION public.maplex_official_bridge_cron(p_secret text)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $fn$
  SELECT (http(('POST','http://insforge:7130/functions/maplex-official-bridge',
    ARRAY[http_header('x-refresh-secret', p_secret)],'application/json','{"action":"cron"}')::http_request)).status
$fn$;
REVOKE ALL ON FUNCTION public.maplex_official_bridge_cron(text) FROM PUBLIC, anon, authenticated, project_admin;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'maplex-official-bridge';
SELECT cron.schedule('maplex-official-bridge', '17,47 * * * *',
  format('SELECT public.maplex_official_bridge_cron(%L)', :'refresh_secret'));

NOTIFY pgrst, 'reload schema';
COMMIT;
