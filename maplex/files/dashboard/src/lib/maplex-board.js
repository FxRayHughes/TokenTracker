// maplex: leaderboard sources, preview identity and the official-leaderboard
// bridge. Everything here is optional and controlled by local preferences
// (Settings → 官方排行榜); with every switch off the leaderboard behaves exactly
// like upstream.
import { getLeaderboard } from "./api";
import { getInsforgeRemoteUrl } from "./insforge-config";

export const MAPLEX_INSTANCE = Object.freeze({
  id: "maplex",
  baseUrl: "https://insforge.maplex.top",
  functionsUrl: "https://insforge.maplex.top/functions",
  anonKey: "anon_ccd53a08643fee52b46be47046ce44c69d0cd34b",
  profileUrl: "https://tokentracker.maplex.top/u/",
});
export const OFFICIAL_INSTANCE = Object.freeze({
  id: "official",
  baseUrl: "https://srctyff5.us-east.insforge.app",
  functionsUrl: "https://srctyff5.function2.insforge.app",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY",
  profileUrl: "https://www.tokentracker.cc/u/",
  deviceUrl: "https://www.tokentracker.cc/device",
});
const INSTANCES = { maplex: MAPLEX_INSTANCE, official: OFFICIAL_INSTANCE };

// ── preferences ────────────────────────────────────────────────────────────
const PREFS_KEY = "tt.maplex.board.prefs";
const VIEW_KEY = "tt.maplex.board.view";
export const DEFAULT_PREFS = Object.freeze({
  showOfficialBoard: true, // source switch on the leaderboard page
  mergeSelf: true, // insert my Maplex totals into the official board (local preview)
  previewSwitcher: true, // "preview as" selector on the leaderboard page
});
const listeners = new Set();
function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}
let prefsCache = null;
export function getBoardPrefs() {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  if (!prefsCache) prefsCache = readJson(PREFS_KEY, DEFAULT_PREFS);
  return prefsCache;
}
export function setBoardPrefs(patch) {
  prefsCache = { ...getBoardPrefs(), ...patch };
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefsCache)); } catch { /* memory only */ }
  listeners.forEach((fn) => fn());
}
export function subscribeBoardPrefs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function readBoardView() {
  if (typeof window === "undefined") return { source: null, preview: "self", customUserId: "" };
  return readJson(VIEW_KEY, { source: null, preview: "self", customUserId: "" });
}
export function writeBoardView(view) {
  try { window.localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* memory only */ }
}

// ── instances ──────────────────────────────────────────────────────────────
export function currentInstanceId() {
  const baseUrl = getInsforgeRemoteUrl();
  if (baseUrl === MAPLEX_INSTANCE.baseUrl) return "maplex";
  if (baseUrl === OFFICIAL_INSTANCE.baseUrl) return "official";
  return "current";
}
export function boardSources() {
  const current = currentInstanceId();
  return current === "current" ? ["current", "maplex", "official"] : ["maplex", "official"];
}
export function profileUrlFor(source, userId) {
  const instance = INSTANCES[source];
  return instance && userId ? `${instance.profileUrl}${encodeURIComponent(userId)}` : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUserId(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

async function fetchRemoteBoard(instance, { period, limit, offset, userId }) {
  const url = new URL(`${instance.functionsUrl}/tokentracker-leaderboard`);
  const params = { period, limit, offset, user_id: userId };
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", apikey: instance.anonKey },
    cache: "no-store",
  });
  if (!res.ok) throw Object.assign(new Error(`Request failed with HTTP ${res.status}`), { status: res.status });
  return res.json();
}

export function fetchBoard(source, params) {
  const current = currentInstanceId();
  if (source === "current" || source === current || !INSTANCES[source]) return getLeaderboard(params);
  return fetchRemoteBoard(INSTANCES[source], params);
}

// Rank my totals would have on another board: binary search for the first
// entry with fewer tokens (one row per probe, cached per board snapshot).
const rankCache = new Map();
async function rankOnBoard(source, period, totalTokens, totalEntries, generatedAt) {
  const key = `${source}|${period}|${generatedAt}|${totalTokens}`;
  if (rankCache.has(key)) return rankCache.get(key);
  let lo = 0;
  let hi = Math.max(0, Number(totalEntries) || 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const data = await fetchBoard(source, { period, limit: 1, offset: mid });
    const tokens = Number(data?.entries?.[0]?.total_tokens) || 0;
    if (tokens >= totalTokens) lo = mid + 1;
    else hi = mid;
  }
  rankCache.set(key, lo + 1);
  return lo + 1;
}

function shiftRanks(entries, fromRank) {
  return entries.map((entry) => (Number(entry?.rank) >= fromRank ? { ...entry, rank: Number(entry.rank) + 1 } : entry));
}

// Insert `self` (my row from the backend I sync to) into another board's page.
export async function mergeSelfIntoBoard(data, self, { source, period, offset, limit }) {
  const total = Number(self?.total_tokens) || 0;
  if (!data || !self || total <= 0) return data;
  const rank = await rankOnBoard(source, period, total, data.total_entries, data.generated_at || "");
  const mine = { ...self, rank, is_me: true, maplex_self: true };
  let entries = shiftRanks((data.entries || []).map((e) => ({ ...e, is_me: false })), rank);
  const index = rank - 1 - offset;
  if (index >= 0 && index <= entries.length && index < limit) {
    entries = [...entries.slice(0, index), mine, ...entries.slice(index)].slice(0, limit);
  }
  const totalEntries = (Number(data.total_entries) || 0) + 1;
  return {
    ...data,
    entries,
    me: mine,
    total_entries: totalEntries,
    total_pages: Math.max(1, Math.ceil(totalEntries / limit)),
  };
}

// ── official bridge (Maplex cloud → official leaderboard) ─────────────────
const BRIDGE_URL = `${MAPLEX_INSTANCE.functionsUrl}/maplex-official-bridge`;
export function bridgeAvailable() {
  return currentInstanceId() === "maplex";
}
export async function callBridge(accessToken, action, extra = {}) {
  if (!accessToken) throw new Error("not_signed_in");
  const res = await fetch(BRIDGE_URL, {
    method: action ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: MAPLEX_INSTANCE.anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
    ...(action ? { body: JSON.stringify({ action, ...extra }) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && (data.detail || data.error)) || `HTTP ${res.status}`);
  return data;
}
