-- maplex: self-hosted leaderboard schema for a TokenTracker self_hosted install.
-- Upstream's private self-host manifest omits the public leaderboard. This adds
-- the minimum schema the unmodified upstream edge functions need:
--   tokentracker-leaderboard / -leaderboard-profile / -leaderboard-refresh /
--   -public-visibility / -community-models / -profile-likes
-- The anti-cheat pipeline is replaced by an always-empty flags table.
-- Idempotent: safe to re-run.

BEGIN;

-- ── Per-user settings and public profile view ──
CREATE TABLE IF NOT EXISTS public.tokentracker_user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  leaderboard_public boolean NOT NULL DEFAULT false,
  leaderboard_anonymous boolean NOT NULL DEFAULT false,
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 50),
  github_url text,
  show_github_url boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tokentracker_user_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_user_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tokentracker_user_settings TO project_admin;

CREATE OR REPLACE VIEW public.tokentracker_user_profiles AS
  SELECT u.id AS user_id,
    COALESCE(NULLIF(s.display_name, ''), NULLIF(u.profile->>'name', ''), split_part(u.email, '@', 1)) AS display_name,
    NULLIF(COALESCE(u.profile->>'avatar_url', u.profile->>'avatarUrl'), '') AS avatar_url
  FROM auth.users u
  LEFT JOIN public.tokentracker_user_settings s ON s.user_id = u.id;
REVOKE ALL ON public.tokentracker_user_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tokentracker_user_profiles TO project_admin;

CREATE TABLE IF NOT EXISTS public.tokentracker_public_views (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tokentracker_public_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_public_views FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tokentracker_public_views TO project_admin;

-- ── Leaderboard snapshots ──
CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_snapshots (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('week', 'month', 'total')),
  from_day date NOT NULL,
  to_day date NOT NULL,
  rank integer NOT NULL,
  gpt_tokens bigint NOT NULL DEFAULT 0,
  claude_tokens bigint NOT NULL DEFAULT 0,
  gemini_tokens bigint NOT NULL DEFAULT 0,
  cursor_tokens bigint NOT NULL DEFAULT 0,
  opencode_tokens bigint NOT NULL DEFAULT 0,
  openclaw_tokens bigint NOT NULL DEFAULT 0,
  hermes_tokens bigint NOT NULL DEFAULT 0,
  kiro_tokens bigint NOT NULL DEFAULT 0,
  copilot_tokens bigint NOT NULL DEFAULT 0,
  kimi_tokens bigint NOT NULL DEFAULT 0,
  other_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  estimated_cost_usd numeric NOT NULL DEFAULT 0,
  display_name text,
  avatar_url text,
  github_url text,
  is_public boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period, from_day, to_day)
);
CREATE INDEX IF NOT EXISTS tokentracker_leaderboard_snapshots_rank_idx
  ON public.tokentracker_leaderboard_snapshots (period, from_day, to_day, rank);
ALTER TABLE public.tokentracker_leaderboard_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_leaderboard_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tokentracker_leaderboard_snapshots TO project_admin;

-- ── Anti-cheat placeholders (the refresh job reads them; always empty here) ──
CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_anomaly_flags (
  user_id uuid PRIMARY KEY,
  status text NOT NULL,
  peak_tokens bigint NOT NULL DEFAULT 0,
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.tokentracker_anticheat_run_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_completed_at timestamptz,
  last_queue_changed_at timestamptz,
  last_response_completed_at timestamptz
);
ALTER TABLE public.tokentracker_leaderboard_anomaly_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_anticheat_run_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_leaderboard_anomaly_flags, public.tokentracker_anticheat_run_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tokentracker_leaderboard_anomaly_flags, public.tokentracker_anticheat_run_state TO project_admin;

-- ── Refresh throttle ──
CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_refresh_claims (
  period text PRIMARY KEY,
  claimed_at timestamptz NOT NULL
);
ALTER TABLE public.tokentracker_leaderboard_refresh_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_leaderboard_refresh_claims FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.leaderboard_refresh_try_claim(p_period text, p_min_interval_s integer)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO public, pg_temp AS $func$
DECLARE v_ok boolean;
BEGIN
  INSERT INTO public.tokentracker_leaderboard_refresh_claims AS c (period, claimed_at)
  VALUES (p_period, clock_timestamp())
  ON CONFLICT (period) DO UPDATE SET claimed_at = EXCLUDED.claimed_at
    WHERE c.claimed_at <= clock_timestamp() - make_interval(secs => GREATEST(COALESCE(p_min_interval_s, 0), 0))
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $func$;

-- No closed-day rollup on a small private instance: totals scan hourly rows.
CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_advance_v2()
RETURNS void LANGUAGE sql VOLATILE AS $func$ SELECT $func$;

-- ── Aggregation (same cross-device semantics as account_usage_grouped) ──
-- Machine-level sources: one row per machine cluster/hour/source/model, summed
-- across the user's ACTIVE devices. Account-level cursor: deduped across
-- devices. trae-cn: account session states.
CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '25s' AS $func$
  WITH base AS MATERIALIZED (
    SELECT h.user_id, h.device_id, h.hour_start, h.source, h.model,
      h.total_tokens, h.input_tokens, h.output_tokens, h.cached_input_tokens,
      h.cache_creation_input_tokens, h.reasoning_output_tokens, h.total_cost_usd, h.updated_at
    FROM public.tokentracker_hourly h
    WHERE h.hour_start >= p_from AND h.hour_start < p_to AND h.source <> 'trae-cn'
  ), machine AS (
    SELECT DISTINCT ON (b.user_id, COALESCE(dm.machine_cluster_id, b.device_id::text), b.hour_start, b.source, b.model)
      b.user_id, b.hour_start, b.source, b.model, b.total_tokens, b.input_tokens, b.output_tokens,
      b.cached_input_tokens, b.cache_creation_input_tokens, b.reasoning_output_tokens, b.total_cost_usd
    FROM base b
    JOIN public.tokentracker_devices d ON d.id = b.device_id AND d.revoked_at IS NULL
    LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = b.device_id
    WHERE b.source <> 'cursor'
    ORDER BY b.user_id, COALESCE(dm.machine_cluster_id, b.device_id::text), b.hour_start, b.source, b.model,
      b.total_tokens DESC, b.updated_at DESC
  ), account AS (
    SELECT DISTINCT ON (b.user_id, b.hour_start, b.source, b.model)
      b.user_id, b.hour_start, b.source, b.model, b.total_tokens, b.input_tokens, b.output_tokens,
      b.cached_input_tokens, b.cache_creation_input_tokens, b.reasoning_output_tokens, b.total_cost_usd
    FROM base b WHERE b.source = 'cursor'
    ORDER BY b.user_id, b.hour_start, b.source, b.model, b.total_tokens DESC, b.updated_at DESC
  ), sessions AS (
    SELECT s.user_id, s.bucket_start AS hour_start, s.source, s.model,
      SUM(s.total_tokens)::bigint, SUM(s.input_tokens)::bigint, SUM(s.output_tokens)::bigint,
      SUM(s.cached_input_tokens)::bigint, SUM(s.cache_creation_input_tokens)::bigint,
      SUM(s.reasoning_output_tokens)::bigint, 0::numeric
    FROM public.tokentracker_account_session_states s
    WHERE s.bucket_start >= p_from AND s.bucket_start < p_to AND s.source = 'trae-cn'
    GROUP BY s.user_id, s.bucket_start, s.source, s.model
  ), rows AS (
    SELECT * FROM machine UNION ALL SELECT * FROM account UNION ALL SELECT * FROM sessions
  ), tiered AS (
    SELECT r.*, CASE WHEN lower(r.model) LIKE '%deepseek-v4-flash%' OR lower(r.model) LIKE '%deepseek-v4-pro%' THEN CASE
        WHEN r.hour_start >= timestamptz '2026-08-22T16:00:00Z'
          AND extract(dow FROM ((r.hour_start AT TIME ZONE 'UTC') + interval '8 hours')) IN (0,6) THEN 'off_peak'
        WHEN extract(hour FROM r.hour_start AT TIME ZONE 'UTC') >= 1 AND extract(hour FROM r.hour_start AT TIME ZONE 'UTC') < 4
          OR extract(hour FROM r.hour_start AT TIME ZONE 'UTC') >= 6 AND extract(hour FROM r.hour_start AT TIME ZONE 'UTC') < 10
          THEN 'peak' ELSE 'off_peak' END ELSE 'peak' END AS pricing_tier
    FROM rows r
  ), grouped AS (
    SELECT user_id, source, model, pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens, SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens, SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens,
      SUM(total_cost_usd)::numeric AS total_cost_usd
    FROM tiered GROUP BY user_id, source, model, pricing_tier
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(g.*) ORDER BY user_id, source, model, pricing_tier), '[]'::jsonb) FROM grouped g
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_pack(p_rows jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO public, pg_temp AS $func$
  WITH raw AS MATERIALIZED (
    SELECT e, ord, COALESCE(e->'user_id', 'null'::jsonb) AS u, COALESCE(e->'source', 'null'::jsonb) AS s,
      COALESCE(e->'model', 'null'::jsonb) AS m, COALESCE(e->'pricing_tier', 'null'::jsonb) AS p
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS entries(e, ord)
  ), users AS MATERIALIZED (SELECT u, (row_number() OVER (ORDER BY u) - 1)::integer AS i FROM (SELECT DISTINCT u FROM raw) d),
  sources AS MATERIALIZED (SELECT s, (row_number() OVER (ORDER BY s) - 1)::integer AS i FROM (SELECT DISTINCT s FROM raw) d),
  models AS MATERIALIZED (SELECT m, (row_number() OVER (ORDER BY m) - 1)::integer AS i FROM (SELECT DISTINCT m FROM raw) d),
  tiers AS MATERIALIZED (SELECT p, (row_number() OVER (ORDER BY p) - 1)::integer AS i FROM (SELECT DISTINCT p FROM raw) d)
  SELECT jsonb_build_object(
    'format', 'leaderboard-usage-v1',
    'user_ids', COALESCE((SELECT jsonb_agg(u ORDER BY i) FROM users), '[]'::jsonb),
    'sources', COALESCE((SELECT jsonb_agg(s ORDER BY i) FROM sources), '[]'::jsonb),
    'model_names', COALESCE((SELECT jsonb_agg(m ORDER BY i) FROM models), '[]'::jsonb),
    'pricing_tiers', COALESCE((SELECT jsonb_agg(p ORDER BY i) FROM tiers), '[]'::jsonb),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_array(u.i, s.i, m.i, p.i,
        r.e->'total_tokens', r.e->'input_tokens', r.e->'output_tokens', r.e->'cached_input_tokens',
        r.e->'cache_creation_input_tokens', r.e->'reasoning_output_tokens', r.e->'total_cost_usd') ORDER BY r.ord)
      FROM raw r JOIN users u ON u.u = r.u JOIN sources s ON s.s = r.s JOIN models m ON m.m = r.m JOIN tiers p ON p.p = r.p), '[]'::jsonb))
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_compact(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO public, pg_temp SET statement_timeout TO '25s' AS $func$
  SELECT public.leaderboard_usage_pack(public.leaderboard_usage_grouped(p_from, p_to))
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_compact_total_shard(p_to timestamptz, p_user_from uuid, p_user_to uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO public, pg_temp SET statement_timeout TO '20s' AS $func$
  SELECT public.leaderboard_usage_pack(COALESCE((
    SELECT jsonb_agg(e) FROM jsonb_array_elements(public.leaderboard_usage_grouped('1970-01-01T00:00:00Z', p_to)) e
    WHERE (e->>'user_id')::uuid >= p_user_from AND (p_user_to IS NULL OR (e->>'user_id')::uuid < p_user_to)
  ), '[]'::jsonb))
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_user_metadata(p_user_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO public, pg_temp SET statement_timeout TO '5s' AS $func$
  WITH requested AS (SELECT DISTINCT user_id FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS ids(user_id))
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', r.user_id,
    'leaderboard_public', COALESCE(s.leaderboard_public, false),
    'leaderboard_anonymous', COALESCE(s.leaderboard_anonymous, false),
    'github_url', s.github_url,
    'show_github_url', COALESCE(s.show_github_url, false),
    'display_name', p.display_name,
    'avatar_url', p.avatar_url) ORDER BY r.user_id), '[]'::jsonb)
  FROM requested r
  LEFT JOIN public.tokentracker_user_settings s ON s.user_id = r.user_id
  LEFT JOIN public.tokentracker_user_profiles p ON p.user_id = r.user_id
$func$;

-- Badges are not computed on this instance: list/profile render without them.
CREATE OR REPLACE FUNCTION public.user_badges_compact(p_user_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE AS $func$ SELECT '{}'::jsonb $func$;
CREATE OR REPLACE FUNCTION public.user_badges_full(p_user_id uuid, p_include_unearned boolean)
RETURNS jsonb LANGUAGE sql STABLE AS $func$ SELECT '[]'::jsonb $func$;

-- ── Profile likes ──
CREATE TABLE IF NOT EXISTS public.tokentracker_profile_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  liker_id text NOT NULL,
  is_authenticated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_user_id, liker_id)
);
ALTER TABLE public.tokentracker_profile_likes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_profile_likes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.tokentracker_profile_likes TO project_admin;

-- ── Community stats snapshot ──
CREATE TABLE IF NOT EXISTS public.tokentracker_community_stats (
  id text PRIMARY KEY CHECK (id = 'total'),
  total_tokens bigint NOT NULL DEFAULT 0,
  top_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  daily_growth jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_mix jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_distribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  platform_distribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  active_developers_total integer NOT NULL DEFAULT 0,
  active_developers_30d integer NOT NULL DEFAULT 0,
  tokens_30d bigint NOT NULL DEFAULT 0,
  token_growth_pct numeric,
  developer_growth_pct numeric,
  from_day date NOT NULL,
  to_day date NOT NULL,
  generated_at timestamptz NOT NULL
);
ALTER TABLE public.tokentracker_community_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_community_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tokentracker_community_stats TO project_admin;

CREATE OR REPLACE FUNCTION public.refresh_tokentracker_community_stats()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public SET statement_timeout TO '120s' AS $func$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  r record;
BEGIN
  WITH usage AS MATERIALIZED (
    SELECT (e->>'user_id')::uuid AS user_id, trim(e->>'source') AS source, trim(e->>'model') AS model,
      (e->>'day')::date AS day, (e->>'total_tokens')::bigint AS total_tokens,
      (e->>'input_tokens')::bigint AS input_tokens, (e->>'output_tokens')::bigint AS output_tokens,
      (e->>'cached_input_tokens')::bigint AS cached_input_tokens,
      (e->>'cache_creation_input_tokens')::bigint AS cache_creation_input_tokens,
      (e->>'reasoning_output_tokens')::bigint AS reasoning_output_tokens
    FROM jsonb_array_elements(public.leaderboard_usage_daily()) e
    WHERE trim(e->>'model') <> '' AND lower(trim(e->>'model')) <> 'auto'
  ), totals AS (
    SELECT COALESCE(SUM(total_tokens),0)::bigint AS total_tokens, COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
      COALESCE(SUM(output_tokens),0)::bigint AS output_tokens, COALESCE(SUM(cached_input_tokens),0)::bigint AS cached_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens),0)::bigint AS cache_creation_input_tokens,
      COALESCE(SUM(reasoning_output_tokens),0)::bigint AS reasoning_output_tokens,
      COUNT(DISTINCT user_id)::integer AS developers_total,
      COUNT(DISTINCT user_id) FILTER (WHERE day >= v_today - 29)::integer AS developers_30d,
      COALESCE(SUM(total_tokens) FILTER (WHERE day >= v_today - 29),0)::bigint AS tokens_30d
    FROM usage
  ), daily AS (
    SELECT days.day::date AS day, COALESCE(SUM(u.total_tokens),0)::bigint AS tokens,
      COUNT(DISTINCT u.user_id)::integer AS active_developers
    FROM generate_series(v_today - 29, v_today, interval '1 day') days(day)
    LEFT JOIN usage u ON u.day = days.day::date GROUP BY 1
  ), daily_w AS (
    SELECT d.*, ROUND(AVG(d.tokens::numeric) OVER (ORDER BY d.day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW))::bigint AS tokens_7d_avg FROM daily d
  ), week AS (
    SELECT COALESCE(SUM(tokens) FILTER (WHERE day >= v_today - 6),0)::numeric AS ct,
      COALESCE(SUM(tokens) FILTER (WHERE day BETWEEN v_today - 13 AND v_today - 7),0)::numeric AS pt,
      COALESCE(AVG(active_developers) FILTER (WHERE day >= v_today - 6),0)::numeric AS cd,
      COALESCE(AVG(active_developers) FILTER (WHERE day BETWEEN v_today - 13 AND v_today - 7),0)::numeric AS pd
    FROM daily
  ), mix AS (
    SELECT * FROM (VALUES (1,'input',(SELECT input_tokens FROM totals)),(2,'cache_read',(SELECT cached_input_tokens FROM totals)),
      (3,'cache_write',(SELECT cache_creation_input_tokens FROM totals)),(4,'output',(SELECT output_tokens FROM totals)),
      (5,'reasoning',(SELECT reasoning_output_tokens FROM totals))) AS m(sort_order,key,tokens)
  ), users_t AS (SELECT user_id, SUM(total_tokens)::bigint AS tokens FROM usage GROUP BY user_id
  ), bands AS (
    SELECT CASE WHEN tokens < 1e6 THEN 1 WHEN tokens < 1e7 THEN 2 WHEN tokens < 1e8 THEN 3 WHEN tokens < 1e9 THEN 4 ELSE 5 END AS so,
      CASE WHEN tokens < 1e6 THEN 'lt_1m' WHEN tokens < 1e7 THEN '1m_10m' WHEN tokens < 1e8 THEN '10m_100m' WHEN tokens < 1e9 THEN '100m_1b' ELSE '1b_plus' END AS key,
      COUNT(*)::integer AS developers, SUM(tokens)::bigint AS tokens
    FROM users_t GROUP BY 1,2
  ), plat AS (
    SELECT lower(CASE WHEN d.platform ILIKE 'mac%' OR d.platform = 'darwin' THEN 'darwin'
      WHEN d.platform ILIKE 'win%' THEN 'win32' ELSE COALESCE(NULLIF(d.platform,''),'linux') END) AS platform, COUNT(*)::integer AS machines
    FROM public.tokentracker_devices d WHERE d.revoked_at IS NULL GROUP BY 1
  )
  SELECT
    t.total_tokens,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.model,'tokens',x.tokens,'share',
        CASE WHEN t.total_tokens>0 THEN round((x.tokens::numeric/t.total_tokens)*1000)/10 ELSE 0 END) ORDER BY x.tokens DESC),'[]'::jsonb)
      FROM (SELECT model, SUM(total_tokens)::bigint AS tokens FROM usage GROUP BY model ORDER BY 2 DESC LIMIT 15) x) AS top_models,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.source,'tokens',x.tokens,'developers',x.developers,'share',
        CASE WHEN t.total_tokens>0 THEN round((x.tokens::numeric/t.total_tokens)*1000)/10 ELSE 0 END) ORDER BY x.tokens DESC),'[]'::jsonb)
      FROM (SELECT source, SUM(total_tokens)::bigint AS tokens, COUNT(DISTINCT user_id)::integer AS developers FROM usage WHERE source<>'' GROUP BY source) x) AS providers,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('day',d.day,'tokens',d.tokens,'tokens_7d_avg',d.tokens_7d_avg,'active_developers',d.active_developers) ORDER BY d.day),'[]'::jsonb) FROM daily_w d) AS daily,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('key',m.key,'tokens',m.tokens,'share',
        CASE WHEN s.tokens>0 THEN round((m.tokens::numeric/s.tokens)*1000)/10 ELSE 0 END) ORDER BY m.sort_order),'[]'::jsonb)
      FROM mix m CROSS JOIN (SELECT COALESCE(SUM(tokens),0)::numeric AS tokens FROM mix) s) AS token_mix,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('key',b.key,'developers',b.developers,'tokens',b.tokens,
        'developer_share',CASE WHEN t.developers_total>0 THEN round((b.developers::numeric/t.developers_total)*1000)/10 ELSE 0 END,
        'token_share',CASE WHEN t.total_tokens>0 THEN round((b.tokens::numeric/t.total_tokens)*1000)/10 ELSE 0 END) ORDER BY b.so),'[]'::jsonb) FROM bands b) AS bands,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.platform,'machines',p.machines,'share',
        CASE WHEN s.m>0 THEN round((p.machines::numeric/s.m)*1000)/10 ELSE 0 END) ORDER BY p.machines DESC),'[]'::jsonb)
      FROM plat p CROSS JOIN (SELECT COALESCE(SUM(machines),0) AS m FROM plat) s) AS platforms,
    t.developers_total, t.developers_30d, t.tokens_30d,
    CASE WHEN w.pt>0 THEN round(((w.ct-w.pt)/w.pt)*1000)/10 END AS tg,
    CASE WHEN w.pd>0 THEN round(((w.cd-w.pd)/w.pd)*1000)/10 END AS dg
  INTO r FROM totals t CROSS JOIN week w;

  INSERT INTO public.tokentracker_community_stats (id,total_tokens,top_models,provider_breakdown,daily_growth,token_mix,
    user_distribution,platform_distribution,active_developers_total,active_developers_30d,tokens_30d,token_growth_pct,
    developer_growth_pct,from_day,to_day,generated_at)
  VALUES ('total',r.total_tokens,r.top_models,r.providers,r.daily,r.token_mix,r.bands,r.platforms,r.developers_total,
    r.developers_30d,r.tokens_30d,r.tg,r.dg,DATE '1970-01-01',v_today,now())
  ON CONFLICT (id) DO UPDATE SET total_tokens=EXCLUDED.total_tokens, top_models=EXCLUDED.top_models,
    provider_breakdown=EXCLUDED.provider_breakdown, daily_growth=EXCLUDED.daily_growth, token_mix=EXCLUDED.token_mix,
    user_distribution=EXCLUDED.user_distribution, platform_distribution=EXCLUDED.platform_distribution,
    active_developers_total=EXCLUDED.active_developers_total, active_developers_30d=EXCLUDED.active_developers_30d,
    tokens_30d=EXCLUDED.tokens_30d, token_growth_pct=EXCLUDED.token_growth_pct,
    developer_growth_pct=EXCLUDED.developer_growth_pct, to_day=EXCLUDED.to_day, generated_at=EXCLUDED.generated_at;
  RETURN jsonb_build_object('total_tokens', r.total_tokens, 'active_developers_30d', r.developers_30d);
END $func$;

-- Daily-grain variant of leaderboard_usage_grouped used by community stats.
CREATE OR REPLACE FUNCTION public.leaderboard_usage_daily()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO public, pg_temp AS $func$
  WITH base AS MATERIALIZED (
    SELECT h.* FROM public.tokentracker_hourly h WHERE h.source <> 'trae-cn'
  ), rows AS (
    SELECT DISTINCT ON (b.user_id, COALESCE(dm.machine_cluster_id, b.device_id::text), b.hour_start, b.source, b.model)
      b.user_id, b.hour_start, b.source, b.model, b.total_tokens, b.input_tokens, b.output_tokens,
      b.cached_input_tokens, b.cache_creation_input_tokens, b.reasoning_output_tokens
    FROM base b JOIN public.tokentracker_devices d ON d.id = b.device_id AND d.revoked_at IS NULL
    LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = b.device_id
    WHERE b.source <> 'cursor'
    ORDER BY b.user_id, COALESCE(dm.machine_cluster_id, b.device_id::text), b.hour_start, b.source, b.model, b.total_tokens DESC, b.updated_at DESC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(g.*)), '[]'::jsonb) FROM (
    SELECT user_id, source, model, (hour_start AT TIME ZONE 'UTC')::date AS day,
      SUM(total_tokens) AS total_tokens, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cached_input_tokens) AS cached_input_tokens, SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens) AS reasoning_output_tokens
    FROM rows GROUP BY 1,2,3,4
  ) g
$func$;

-- Private RPCs: server role only.
DO $grants$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'leaderboard_refresh_try_claim(text,integer)', 'leaderboard_rollup_daily_advance_v2()',
    'leaderboard_usage_grouped(timestamptz,timestamptz)', 'leaderboard_usage_pack(jsonb)',
    'leaderboard_usage_compact(timestamptz,timestamptz)', 'leaderboard_usage_compact_total_shard(timestamptz,uuid,uuid)',
    'leaderboard_user_metadata(uuid[])', 'user_badges_compact(uuid[])', 'user_badges_full(uuid,boolean)',
    'refresh_tokentracker_community_stats()', 'leaderboard_usage_daily()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO project_admin', f);
  END LOOP;
END $grants$;

INSERT INTO public.tokentracker_self_host_installations(step, checksum)
VALUES ('maplex-leaderboard', 'maplex-v1') ON CONFLICT (step) DO UPDATE SET checksum = EXCLUDED.checksum;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT public.refresh_tokentracker_community_stats();
