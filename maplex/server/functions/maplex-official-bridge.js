// maplex-official-bridge — relay a Maplex user's usage to the official
// TokenTracker leaderboard (tokentracker.cc).
//
// The user links an official account once through the official device flow
// (they approve a code at https://www.tokentracker.cc/device). The issued
// official device token is stored AES-GCM encrypted (MAPLEX_BRIDGE_KEY). Then
// this function uploads the user's usage, summed over all their Maplex
// devices, to the official ingest endpoint as one "Maplex relay" device.
// Uploads replace rows by (hour, source, model), so re-sending is idempotent.
//
// Requests:
//   GET                          → link status            (user JWT)
//   POST {action:"link_start"}   → device code for the official site
//   POST {action:"link_poll"}    → finish linking once approved
//   POST {action:"set_enabled", enabled}
//   POST {action:"relay_now"}    → upload now (official throttling applies)
//   POST {action:"unlink"}
//   POST {action:"cron"} + header x-refresh-secret: <LEADERBOARD_REFRESH_SECRET>
//
// Secrets: MAPLEX_BRIDGE_KEY (encryption), LEADERBOARD_REFRESH_SECRET (cron),
// plus the platform's API_KEY / ANON_KEY / JWT_SECRET / INSFORGE_INTERNAL_URL.
module.exports = async function (req) {
  const OFFICIAL_FUNCTIONS = "https://srctyff5.function2.insforge.app";
  const OFFICIAL_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY";
  // Optional overrides (testing against another TokenTracker instance).
  const TARGET_FUNCTIONS = Deno.env.get("MAPLEX_BRIDGE_TARGET_FUNCTIONS") || OFFICIAL_FUNCTIONS;
  const TARGET_ANON = Deno.env.get("MAPLEX_BRIDGE_TARGET_ANON") || OFFICIAL_ANON;
  const TARGET_DASHBOARD = Deno.env.get("MAPLEX_BRIDGE_TARGET_DASHBOARD") || "https://www.tokentracker.cc/";
  const BATCH = 500;
  const MAX_BATCHES = 10;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const env = (k) => Deno.env.get(k) || "";
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64url = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const sha256Hex = async (s) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");

  async function userIdFromJwt(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    try {
      const header = JSON.parse(dec.decode(b64url(parts[0])));
      const signed = enc.encode(`${parts[0]}.${parts[1]}`);
      let ok = false;
      if (header.alg === "HS256" && env("JWT_SECRET")) {
        const key = await crypto.subtle.importKey("raw", enc.encode(env("JWT_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
        ok = await crypto.subtle.verify("HMAC", key, b64url(parts[2]), signed);
      } else if (header.alg === "RS256" && env("JWT_PUBLIC_KEY")) {
        const der = unb64(env("JWT_PUBLIC_KEY").replace(/-----[^-]+-----|\s/g, ""));
        const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), signed);
      }
      if (!ok) return null;
      const payload = JSON.parse(dec.decode(b64url(parts[1])));
      if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
      if (payload.role && payload.role !== "authenticated") return null;
      return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  }

  let aesKey = null;
  async function cryptoKey() {
    if (!env("MAPLEX_BRIDGE_KEY")) throw new Error("bridge_not_configured");
    if (!aesKey) {
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(env("MAPLEX_BRIDGE_KEY")));
      aesKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    return aesKey;
  }
  async function seal(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), enc.encode(text));
    return `v1.${b64(iv)}.${b64(ct)}`;
  }
  async function open(sealed) {
    const [v, iv, ct] = String(sealed || "").split(".");
    if (v !== "v1") throw new Error("bad_ciphertext");
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await cryptoKey(), unb64(ct)));
  }

  const { createClient } = await import("npm:@insforge/sdk@1.4.5");
  const db = createClient({
    baseUrl: env("INSFORGE_INTERNAL_URL") || env("INSFORGE_BASE_URL"),
    edgeFunctionToken: env("API_KEY") || env("INSFORGE_SERVICE_ROLE_KEY"),
    anonKey: env("ANON_KEY") || undefined,
  }).database;
  const LINKS = "maplex_official_links";

  async function getLink(userId) {
    const { data, error } = await db.from(LINKS).select("*").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message || "db_error");
    return data || null;
  }
  async function saveLink(userId, patch) {
    const row = { ...patch, user_id: userId, updated_at: new Date().toISOString() };
    const { error } = await db.from(LINKS).upsert([row], { onConflict: "user_id" });
    if (error) throw new Error(error.message || "db_error");
  }
  function publicStatus(link) {
    const pending = link?.pending_user_code && link.pending_expires_at && Date.parse(link.pending_expires_at) > Date.now()
      ? { user_code: link.pending_user_code, verification_uri: link.pending_verification_uri, expires_at: link.pending_expires_at }
      : null;
    return {
      ok: true,
      linked: Boolean(link?.device_token_ct),
      enabled: link ? link.enabled !== false : false,
      official_user_id: link?.official_user_id || null,
      pending,
      last_relay_at: link?.last_relay_at || null,
      next_allowed_at: link?.next_allowed_at || null,
      last_status: link?.last_status || null,
      last_error: link?.last_error || null,
      rows_sent: Number(link?.rows_sent || 0),
    };
  }
  async function official(slug, body, token) {
    const res = await fetch(`${TARGET_FUNCTIONS}/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", apikey: TARGET_ANON,
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  }

  async function linkStart(userId) {
    const link = await getLink(userId);
    if (link?.pending_user_code && Date.parse(link.pending_expires_at) > Date.now() + 60000) return publicStatus(link);
    const machineId = `maplex-relay-${(await sha256Hex(userId)).slice(0, 40)}`;
    const r = await official("tokentracker-device-flow-authorize", { client_info: "Maplex relay (insforge.maplex.top)", machine_id: machineId });
    if (!r.ok || !r.data?.device_code || !r.data?.user_code) return json({ error: "official_authorize_failed", status: r.status }, 502);
    const uri = String(r.data.verification_uri_complete || r.data.verification_uri || "");
    if (!uri.startsWith(TARGET_DASHBOARD)) return json({ error: "official_unexpected_uri" }, 502);
    await saveLink(userId, {
      pending_code_ct: await seal(r.data.device_code),
      pending_user_code: r.data.user_code,
      pending_verification_uri: uri,
      pending_expires_at: new Date(Date.now() + Number(r.data.expires_in || 900) * 1000).toISOString(),
      ...(link ? {} : { enabled: true }),
    });
    return publicStatus(await getLink(userId));
  }

  async function linkPoll(userId) {
    const link = await getLink(userId);
    if (!link?.pending_code_ct) return publicStatus(link);
    const r = await official("tokentracker-device-flow-poll", { device_code: await open(link.pending_code_ct) });
    const clearPending = { pending_code_ct: null, pending_user_code: null, pending_verification_uri: null, pending_expires_at: null };
    if (r.status === 404 || r.status === 410) {
      await saveLink(userId, clearPending);
      return { ...publicStatus(await getLink(userId)), poll: "expired" };
    }
    if (r.ok && r.data?.status === "approved" && r.data.device_token) {
      await saveLink(userId, {
        ...clearPending,
        device_token_ct: await seal(String(r.data.device_token)),
        official_user_id: r.data.user_id || null,
        official_device_id: r.data.device_id || null,
        relay_watermark: null, relay_watermark_key: null, next_allowed_at: null,
        enabled: true, last_status: "linked", last_error: null,
      });
      const relayed = await relay(await getLink(userId));
      return { ...publicStatus(await getLink(userId)), poll: "approved", relay: relayed };
    }
    if (!r.ok) return { ...publicStatus(link), poll: "error", poll_status: r.status };
    return { ...publicStatus(link), poll: "pending" };
  }

  async function relay(link, { force = false } = {}) {
    if (!link?.device_token_ct || link.enabled === false) return { skipped: "not_enabled" };
    if (!force && link.next_allowed_at && Date.parse(link.next_allowed_at) > Date.now()) return { skipped: "throttled", next_allowed_at: link.next_allowed_at };
    const token = await open(link.device_token_ct);
    const uploadId = crypto.randomUUID();
    let since = link.relay_watermark || null;
    let sinceKey = link.relay_watermark_key || "";
    let sent = 0, batches = 0, status = "ok", error = null, nextAllowed = null;
    while (batches < MAX_BATCHES) {
      const { data: rows, error: rpcError } = await db.rpc("maplex_official_relay_rows", {
        p_user_id: link.user_id, p_since: since, p_since_key: sinceKey, p_limit: BATCH,
      });
      if (rpcError) { status = "error"; error = rpcError.message || "rows_failed"; break; }
      if (!Array.isArray(rows) || rows.length === 0) break;
      const hourly = rows.map((r) => ({
        hour_start: r.hour_start, source: r.source, model: r.model,
        input_tokens: Number(r.input_tokens) || 0, cached_input_tokens: Number(r.cached_input_tokens) || 0,
        cache_creation_input_tokens: Number(r.cache_creation_input_tokens) || 0, output_tokens: Number(r.output_tokens) || 0,
        reasoning_output_tokens: Number(r.reasoning_output_tokens) || 0, total_tokens: Number(r.total_tokens) || 0,
        billable_total_tokens: Number(r.billable_total_tokens) || 0, total_cost_usd: Number(r.total_cost_usd) || 0,
        conversation_count: Number(r.conversations) || 0,
      }));
      const r = await official("tokentracker-ingest", { upload_id: uploadId, hourly }, token);
      if (!r.ok) {
        nextAllowed = r.data?.next_allowed_at || null;
        status = r.status === 429 ? "throttled" : r.status === 401 ? "token_rejected" : "error";
        error = status === "throttled" ? null : String(r.data?.error || r.data?.code || `HTTP ${r.status}`).slice(0, 200);
        if (status === "throttled" && !nextAllowed) nextAllowed = new Date(Date.now() + 3600000).toISOString();
        break;
      }
      const last = rows[rows.length - 1];
      since = last.max_updated;
      sinceKey = last.cursor_key;
      sent += rows.length;
      batches += 1;
      nextAllowed = r.data?.next_allowed_at || null;
      if (rows.length < BATCH) break;
    }
    await saveLink(link.user_id, {
      relay_watermark: since, relay_watermark_key: sinceKey || null,
      last_relay_at: new Date().toISOString(), next_allowed_at: sent === 0 && status === "ok" ? link.next_allowed_at || null : nextAllowed,
      last_status: sent === 0 && status === "ok" ? "up_to_date" : status, last_error: error,
      rows_sent: Number(link.rows_sent || 0) + sent,
    });
    return { sent, batches, status, next_allowed_at: nextAllowed };
  }

  try {
    let body = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    else if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

    if (body.action === "cron") {
      const secret = env("LEADERBOARD_REFRESH_SECRET");
      if (!secret || req.headers.get("x-refresh-secret") !== secret) return json({ error: "Unauthorized" }, 401);
      const { data: links, error } = await db.from(LINKS).select("*").eq("enabled", true).not("device_token_ct", "is", null);
      if (error) return json({ error: error.message }, 500);
      const results = [];
      for (const link of links || []) {
        try { results.push({ user: link.user_id.slice(0, 8), ...(await relay(link)) }); }
        catch (e) { results.push({ user: link.user_id.slice(0, 8), error: String(e?.message || e) }); }
      }
      return json({ ok: true, results });
    }

    const auth = req.headers.get("Authorization") || "";
    const userId = await userIdFromJwt(auth.replace(/^Bearer\s+/i, ""));
    if (!userId) return json({ error: "Unauthorized" }, 401);

    if (req.method === "GET") return json(publicStatus(await getLink(userId)));
    switch (body.action) {
      case "link_start": {
        const out = await linkStart(userId);
        return out instanceof Response ? out : json(out);
      }
      case "link_poll": return json(await linkPoll(userId));
      case "set_enabled": {
        if (!(await getLink(userId))) return json({ error: "not_linked" }, 400);
        await saveLink(userId, { enabled: Boolean(body.enabled) });
        return json(publicStatus(await getLink(userId)));
      }
      case "relay_now": {
        const relayed = await relay(await getLink(userId));
        return json({ ...publicStatus(await getLink(userId)), relay: relayed });
      }
      case "unlink": {
        const { error } = await db.from(LINKS).delete().eq("user_id", userId);
        if (error) return json({ error: error.message }, 500);
        return json(publicStatus(null));
      }
      default: return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    const msg = String(e?.message || e);
    return json({ error: msg === "bridge_not_configured" ? msg : "bridge_failed", detail: msg.slice(0, 200) }, 500);
  }
};
