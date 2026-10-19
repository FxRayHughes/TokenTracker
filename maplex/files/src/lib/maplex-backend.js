"use strict";
// maplex: switchable cloud backend for the local CLI server.
//
// config.json keeps the selected backend in `backendChoice`:
//   "maplex"   → built-in defaults (our self-hosted InsForge). baseUrl/anonKey/
//                dashboardUrl are removed so DEFAULT_* apply.
//   "official" → upstream TokenTracker cloud. Its host is otherwise treated as
//                a legacy host and auto-migrated; the explicit choice opts out.
//   "custom"   → any InsForge instance with its own public anon key.
// Changing the backend changes the instance fingerprint, so the local server
// drops the previous instance's device token, relay session and upload cursor
// (local usage data is untouched) and the user signs in again.

const OFFICIAL_BACKEND = Object.freeze({
  baseUrl: "https://srctyff5.us-east.insforge.app",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY",
  dashboardUrl: "https://www.tokentracker.cc",
});
const OFFICIAL_HOST = new URL(OFFICIAL_BACKEND.baseUrl).hostname;
const CHOICES = ["maplex", "official", "custom"];

function explicitOfficial(config) {
  return Boolean(config) && config.backendChoice === "official";
}

function presets() {
  const { DEFAULT_BASE_URL, DEFAULT_DASHBOARD_URL } = require("./runtime-config");
  return [
    { id: "maplex", baseUrl: DEFAULT_BASE_URL, dashboardUrl: DEFAULT_DASHBOARD_URL },
    { id: "official", baseUrl: OFFICIAL_BACKEND.baseUrl, dashboardUrl: OFFICIAL_BACKEND.dashboardUrl },
    { id: "custom", baseUrl: "", dashboardUrl: "" },
  ];
}

function currentChoice(config, runtime) {
  const { DEFAULT_BASE_URL } = require("./runtime-config");
  if (CHOICES.includes(config?.backendChoice)) return config.backendChoice;
  if (runtime?.baseUrl === DEFAULT_BASE_URL) return "maplex";
  if (runtime?.baseUrl === OFFICIAL_BACKEND.baseUrl) return "official";
  return "custom";
}

function describe(config, runtime) {
  const choice = currentChoice(config, runtime);
  return {
    choice,
    presets: presets(),
    active: {
      baseUrl: runtime?.baseUrl || "",
      dashboardUrl: runtime?.dashboardUrl || "",
      configurationError: runtime?.configurationError || null,
      signedIn: Boolean(runtime?.deviceToken),
    },
    custom: choice === "custom"
      ? { baseUrl: config?.baseUrl || "", anonKey: config?.anonKey || "", dashboardUrl: config?.dashboardUrl || "" }
      : null,
  };
}

// Returns { ok, config } with the new config.json contents, or { ok:false, error }.
function applyChoice(config, body) {
  const { normalizeInstanceBaseUrl, isPublicAnonKey, DEFAULT_ANON_KEY } = require("./runtime-config");
  const choice = body && typeof body.choice === "string" ? body.choice : "";
  if (!CHOICES.includes(choice)) return { ok: false, error: "Unknown backend choice" };
  const next = { ...config };
  if (choice === "maplex") {
    delete next.baseUrl; delete next.anonKey; delete next.dashboardUrl;
  } else if (choice === "official") {
    Object.assign(next, OFFICIAL_BACKEND);
  } else {
    const baseUrl = normalizeInstanceBaseUrl(String(body.baseUrl || "").trim());
    if (!baseUrl) return { ok: false, error: "Backend URL must use HTTPS (or HTTP on localhost)." };
    const anonKey = String(body.anonKey || "").trim();
    if (!isPublicAnonKey(anonKey) || anonKey === DEFAULT_ANON_KEY) {
      return { ok: false, error: "Use this backend's own public anon key (never an admin ik_ key)." };
    }
    const dashboardRaw = String(body.dashboardUrl || "").trim();
    const dashboardUrl = dashboardRaw ? normalizeInstanceBaseUrl(dashboardRaw) : baseUrl;
    if (!dashboardUrl) return { ok: false, error: "Dashboard URL must use HTTPS (or HTTP on localhost)." };
    Object.assign(next, { baseUrl, anonKey, dashboardUrl });
  }
  next.backendChoice = choice;
  return { ok: true, config: next };
}

module.exports = { OFFICIAL_BACKEND, OFFICIAL_HOST, explicitOfficial, describe, applyChoice };
