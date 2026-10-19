#!/usr/bin/env node
// Apply the maplex self-hosted overlay to an upstream TokenTracker checkout.
//
//   node maplex/apply.cjs <path-to-upstream-checkout>
//
// Every replacement is anchored to an exact upstream snippet. If upstream
// changes one of them the script FAILS instead of silently shipping a client
// that still talks to the official backend; then update the anchor here.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const root = path.resolve(process.argv[2] || ".");
const OFFICIAL_API = "https://srctyff5.us-east.insforge.app";
const OFFICIAL_FN = "https://srctyff5.function2.insforge.app";
const OFFICIAL_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY";
const UP = cfg.upstreamRepo, OWN = cfg.releaseRepo;

let failures = 0;
function edit(file, pairs, { optional = false } = {}) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) {
    if (optional) return;
    console.error(`✗ missing file ${file}`); failures++; return;
  }
  let s = fs.readFileSync(p, "utf8");
  for (const [from, to, opts = {}] of pairs) {
    const count = typeof from === "string" ? s.split(from).length - 1 : (s.match(from) || []).length;
    if (count === 0) {
      if (opts.optional) continue;
      console.error(`✗ ${file}: anchor not found: ${String(from).slice(0, 90)}`); failures++; continue;
    }
    s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
  }
  fs.writeFileSync(p, s);
  console.log(`✓ ${file}`);
}

// ── 1. CLI / embedded local server: default backend, anon key, dashboard ──
edit("src/lib/runtime-config.js", [
  [`const DEFAULT_BASE_URL = "${OFFICIAL_API}";`, `const DEFAULT_BASE_URL = "${cfg.backendUrl}";`],
  // Persisted official URLs (from an earlier official install) must fall back
  // to our backend, exactly like upstream treats its own retired project.
  [`const LEGACY_INSFORGE_HOSTS = new Set(["b46ug8xu.us-east.insforge.app"]);`,
   `const LEGACY_INSFORGE_HOSTS = new Set(${JSON.stringify(cfg.officialHosts)});`],
  [`const DEFAULT_DASHBOARD_URL = "https://www.tokentracker.cc";`, `const DEFAULT_DASHBOARD_URL = "${cfg.dashboardUrl}";`],
  [`"${OFFICIAL_ANON}"`, `"${cfg.anonKey}"`],
]);
edit("src/lib/function-url.js", [
  // Self-hosted InsForge serves functions through the API proxy only.
  [`const PROD_FUNCTIONS_URL = "${OFFICIAL_FN}";`, `const PROD_FUNCTIONS_URL = "${OFFICIAL_FN}"; // unused in maplex builds`],
  [/return root === DEFAULT_BASE_URL\s*\n\s*\?\s*`\$\{PROD_FUNCTIONS_URL\}\/\$\{slug\}`\s*\n\s*:\s*`\$\{root\}\/functions\/\$\{slug\}`;/,
   "return `${root}/functions/${slug}`;"],
]);
edit("src/commands/init.js", [
  [`const DEFAULT_DASHBOARD_URL = "https://www.tokentracker.cc";`, `const DEFAULT_DASHBOARD_URL = "${cfg.dashboardUrl}";`],
]);

// ── 2. Dashboard bundle (web + every embedded native dashboard) ──
edit("dashboard/src/lib/insforge-config.ts", [
  [`const PROD_INSFORGE_BASE_URL = "${OFFICIAL_API}";`, `const PROD_INSFORGE_BASE_URL = "${cfg.backendUrl}";`],
  [`"${OFFICIAL_ANON}"`, `"${cfg.anonKey}"`],
]);
edit("dashboard/src/lib/insforge-deployment-config.mjs", [
  [`export const OFFICIAL_INSFORGE_URL = "${OFFICIAL_API}";`, `export const OFFICIAL_INSFORGE_URL = "${cfg.backendUrl}";`],
]);
edit("dashboard/src/lib/function-url.ts", [
  [`const PROD_API_URL = "${OFFICIAL_API}";`, `const PROD_API_URL = "${cfg.backendUrl}";`],
  [/return root === PROD_API_URL\s*\n\s*\?\s*`\$\{PROD_FUNCTIONS_URL\}\/\$\{slug\}`\s*\n\s*:\s*`\$\{root\}\/functions\/\$\{slug\}`;/,
   "return `${root}/functions/${slug}`;"],
]);
edit("dashboard/src/pages/DevicePage.jsx", [
  [`"${OFFICIAL_API}";`, `"${cfg.backendUrl}";`],
], { optional: true });
// The self-hosted instance is "official" for us, but it still runs the free
// self_hosted policy: never offer upstream paid/public-profile features.
edit("dashboard/src/lib/insforge-config.ts", [
  [/export function isOfficialInsforgeInstance\(\): boolean \{\n\s*return [^\n]*\n\}/,
   "export function isOfficialInsforgeInstance(): boolean {\n  return false; // maplex: private self-hosted instance\n}"],
]);
// Never report to the upstream PostHog project.
edit("dashboard/src/lib/analytics.js", [
  [`  if (import.meta.env.DEV || import.meta.env.MODE === "test") return;\n`,
   `  if (import.meta.env.DEV || import.meta.env.MODE === "test") return;\n  return; // maplex: analytics disabled in self-hosted builds\n`],
]);
// Download / star / release links → our fork.
for (const f of [
  "dashboard/src/lib/config.ts",
  "dashboard/src/pages/LeaderboardProfilePage.jsx",
  "dashboard/src/pages/WidgetsPage.jsx",
  "dashboard/src/components/LocalOnlyNotice.jsx",
  "dashboard/src/ui/dashboard/components/MacAppBanner.jsx",
  "dashboard/src/components/settings/MenuBarSection.jsx",
  "dashboard/src/ui/components/Sidebar.jsx",
  "dashboard/src/ui/components/HeaderGithubStar.jsx",
]) edit(f, [[UP, OWN]], { optional: true });

// ── 3. Native auto-updaters → our fork's GitHub Releases ──
edit("TokenTrackerBar/TokenTrackerBar/Services/UpdateChecker.swift", [[UP, OWN]]);
edit("TokenTrackerWin/UpdateReleaseClient.cs", [[UP, OWN]]);
edit("TokenTrackerWin/Constants.cs", [[UP, OWN]], { optional: true });
for (const f of [
  "TokenTrackerBar/TokenTrackerBar/Services/NativeBridge.swift",
  "TokenTrackerBar/TokenTrackerBar/Services/StatusBarController.swift",
  "TokenTrackerBar/TokenTrackerBar/Views/DynamicIslandView.swift",
]) edit(f, [[UP, OWN]], { optional: true });
for (const f of [
  "TokenTrackerBar/TokenTrackerBar/TokenTrackerBarApp.swift",
  "TokenTrackerBar/TokenTrackerBar/Views/DynamicIslandView.swift",
]) edit(f, [[`"https://www.tokentracker.cc"`, `"${cfg.dashboardUrl}"`]], { optional: true });

// ── 4. Switchable backend (Settings → Cloud backend): maplex / official / custom ──
function copyIn(rel) {
  const src = path.join(__dirname, "files", rel);
  const dst = path.join(root, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`✓ ${rel} (added)`);
}
copyIn("src/lib/maplex-backend.js");
copyIn("dashboard/src/hooks/use-backend-settings.js");
copyIn("dashboard/src/components/settings/BackendSection.jsx");

// An explicit "official" choice keeps the official URL instead of migrating it.
edit("src/lib/runtime-config.js", [
  [`  const persistedBaseUrl = normalizePersistedBaseUrl(config.baseUrl);`,
   `  const persistedBaseUrl = require("./maplex-backend").explicitOfficial(config)\n    ? normalizeString(config.baseUrl)\n    : normalizePersistedBaseUrl(config.baseUrl);`],
]);
edit("src/commands/sync.js", [
  [`    if (config && isLegacyInsforgeBaseUrl(config.baseUrl) &&`,
   `    if (config && config.backendChoice !== "official" && isLegacyInsforgeBaseUrl(config.baseUrl) &&`],
]);
// The official API serves functions from its dedicated functions origin.
edit("src/lib/function-url.js", [
  ["return `${root}/functions/${slug}`;",
   "return root === require(\"./maplex-backend\").OFFICIAL_BACKEND.baseUrl\n    ? `${PROD_FUNCTIONS_URL}/${slug}`\n    : `${root}/functions/${slug}`;"],
  [`const PROD_FUNCTIONS_URL = "${OFFICIAL_FN}"; // unused in maplex builds`, `const PROD_FUNCTIONS_URL = "${OFFICIAL_FN}";`],
]);
edit("dashboard/src/lib/function-url.ts", [
  [`const PROD_API_URL = "${cfg.backendUrl}";`, `const PROD_API_URL = "${OFFICIAL_API}";`],
  ["return `${root}/functions/${slug}`;",
   "return root === PROD_API_URL\n    ? `${PROD_FUNCTIONS_URL}/${slug}`\n    : `${root}/functions/${slug}`;"],
]);
// Local route: GET/POST /functions/tokentracker-backend-config.
edit("src/lib/local-api.js", [
  [`    if (p === "/api/runtime-config.js") {`,
   `    if (p === "/functions/tokentracker-backend-config") {
      const maplexBackend = require("./maplex-backend");
      const method = String(req.method || "GET").toUpperCase();
      let current = {};
      try { current = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8")) || {}; } catch { current = {}; }
      if (method === "GET") { json(res, maplexBackend.describe(current, selectedRuntime), 200); return true; }
      if (method !== "POST") { json(res, { error: "Method Not Allowed" }, 405); return true; }
      if (!isAuthorizedLocalMutation(req)) { json(res, { error: "Unauthorized" }, 401); return true; }
      let body;
      try { body = await readJsonBody(req); } catch { json(res, { error: "Invalid JSON" }, 400); return true; }
      const result = maplexBackend.applyChoice(current, body);
      if (!result.ok) { json(res, { error: result.error }, 400); return true; }
      // Keep one login per backend: stash the current backend's sign-in,
      // then bring back the target backend's sign-in if it has one.
      const vaultFiles = { "relay-cookies.json": cookiePath };
      const fromBase = selectedRuntime.baseUrl;
      const tokenBelongsHere = Boolean(current.deviceToken) &&
        normalizeInstanceBaseUrl(current.deviceTokenBaseUrl) === fromBase;
      if (!selectedRuntime.configurationError && (relayCookies.size > 0 || tokenBelongsHere)) {
        persistRelayCookies();
        maplexBackend.saveVault(trackerDataDir, fromBase, tokenBelongsHere ? current : {}, vaultFiles);
      }
      let nextConfig = maplexBackend.stripIdentity(result.config);
      const probe = resolveRuntimeConfig({ config: nextConfig, env: process.env });
      const targetBase = probe.configurationError ? "" : probe.baseUrl;
      let restored = null;
      if (targetBase && targetBase !== fromBase) {
        restored = maplexBackend.restoreVault(trackerDataDir, targetBase, {});
        if (restored) nextConfig = { ...nextConfig, ...restored };
      } else if (targetBase === fromBase) {
        nextConfig = result.config;
      }
      fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
      writeJsonAtomicSync(runtimeConfigPath, nextConfig);
      try { fs.chmodSync(runtimeConfigPath, 0o600); } catch { /* best effort */ }
      // getRuntime() notices the new instance and clears the old session...
      const nextRuntime = getRuntime();
      // ...then the target backend's own login cookies are put back.
      if (restored && !nextRuntime.configurationError) {
        maplexBackend.restoreVault(trackerDataDir, nextRuntime.baseUrl, vaultFiles);
        relayCookies.clear();
        try {
          const saved = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
          for (const [k, v] of Object.entries(saved || {})) relayCookies.set(k, v);
        } catch { /* no saved cookies: CLI token still restored */ }
      }
      json(res, { ...maplexBackend.describe(nextConfig, nextRuntime), restoredLogin: Boolean(restored) }, 200);
      return true;
    }
    if (p === "/api/runtime-config.js") {`],
]);
// Dashboard: "official" = upstream cloud. Both it and maplex run the public
// leaderboard / public-profile features.
edit("dashboard/src/lib/insforge-config.ts", [
  [/export function isOfficialInsforgeInstance\(\): boolean \{\n\s*return false;[^\n]*\n\}/,
   `export function isOfficialInsforgeInstance(): boolean {\n  return getInsforgeConfiguration().baseUrl === "${OFFICIAL_API}";\n}\nexport function isFirstPartyInsforgeInstance(): boolean {\n  const baseUrl = getInsforgeConfiguration().baseUrl;\n  return baseUrl === PROD_INSFORGE_BASE_URL || baseUrl === "${OFFICIAL_API}";\n}`],
]);
edit("dashboard/src/components/settings/useAccountProfileSettings.js", [
  [`import { isOfficialInsforgeInstance } from "../../lib/insforge-config";`,
   `import { isFirstPartyInsforgeInstance, isOfficialInsforgeInstance } from "../../lib/insforge-config";`],
  [`  const publicProfileAvailable = !selfHosted && (isOfficialInsforgeInstance() || promptState.membership?.hosting_mode === "hosted");`,
   `  const publicProfileAvailable = isFirstPartyInsforgeInstance() || (!selfHosted && (isOfficialInsforgeInstance() || promptState.membership?.hosting_mode === "hosted"));`],
]);
edit("dashboard/src/contexts/InsforgeAuthContext.jsx", [
  [`  isOfficialInsforgeInstance,\n`, `  isFirstPartyInsforgeInstance,\n`],
  [`    if (!user || !client || !isOfficialInsforgeInstance()) {`, `    if (!user || !client || !isFirstPartyInsforgeInstance()) {`],
]);
edit("dashboard/src/pages/SettingsPage.jsx", [
  [`import { Cloud, FlaskConical, Gauge, Globe, Monitor, Palette, Settings, UserRound } from "lucide-react";`,
   `import { Cloud, FlaskConical, Gauge, Globe, Monitor, Palette, Server, Settings, UserRound } from "lucide-react";\nimport { BackendSection } from "../components/settings/BackendSection.jsx";\nimport { useBackendSettings } from "../hooks/use-backend-settings.js";`],
  [`  NETWORK: "network",\n`, `  NETWORK: "network",\n  BACKEND: "backend",\n`],
  [`  const { available: proxySettingsAvailable } = proxySettings;\n`,
   `  const { available: proxySettingsAvailable } = proxySettings;\n  const backendSettings = useBackendSettings();\n`],
  [`    (requestedSection !== SETTINGS_SECTION_IDS.NETWORK || proxySettingsAvailable);`,
   `    (requestedSection !== SETTINGS_SECTION_IDS.NETWORK || proxySettingsAvailable) &&\n    (requestedSection !== SETTINGS_SECTION_IDS.BACKEND || backendSettings.available);`],
  [`    ...(proxySettingsAvailable\n      ? [{`,
   `    ...(backendSettings.available && backendSettings.config
      ? [{
          id: SETTINGS_SECTION_IDS.BACKEND,
          label: copy("settings.section.backend"),
          description: copy("settings.section.backend.description"),
          group: SETTINGS_GROUP_IDS.APP,
          Icon: Server,
          content: <BackendSection backendSettings={backendSettings} />,
        }]
      : []),
    ...(proxySettingsAvailable\n      ? [{`],
]);
// Copy strings: English registry row + translations.
{
  const strings = JSON.parse(fs.readFileSync(path.join(__dirname, "files", "backend-copy.json"), "utf8"));
  const csvPath = path.join(root, "dashboard/src/content/copy.csv");
  let csv = fs.readFileSync(csvPath, "utf8");
  if (!csv.endsWith("\n")) csv += "\n";
  for (const [key, text] of Object.entries(strings.en)) {
    if (csv.includes(`\n${key},`)) continue;
    csv += `${key},ui,SettingsPage,BackendSection,${key.split(".").slice(2).join("_") || "title"},"${text.replace(/"/g, '""')}",maplex,active\n`;
  }
  fs.writeFileSync(csvPath, csv);
  for (const [locale, table] of Object.entries(strings)) {
    if (locale === "en") continue;
    const p = path.join(root, `dashboard/src/content/i18n/${locale}/core.json`);
    if (!fs.existsSync(p)) continue;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    Object.assign(data, table);
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  }
  console.log("✓ backend settings copy");
}

// ── 4b. maplex sub-releases: vX.Y.Z.N on top of upstream vX.Y.Z ──
// Updaters compare the native app version, so only those fields (and the
// dashboard's displayed version) carry the 4th part; npm / Linux (semver only)
// keep the upstream version. Upstream's next X.Y.(Z+1) still sorts higher.
edit("TokenTrackerWin/UpdateReleaseClient.cs", [
  [`if (!Version.TryParse(version, out var parsed) || parsed.Build < 0 || parsed.Revision >= 0)`,
   `if (!Version.TryParse(version, out var parsed) || parsed.Build < 0) // maplex: allow X.Y.Z.N sub-releases`],
]);
{
  const release = (process.env.MAPLEX_RELEASE_VERSION || "").replace(/^v/, "");
  const base = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (release && release !== base) {
    if (!new RegExp(`^${base.replace(/\./g, "\\.")}\\.[1-9]\\d*$`).test(release)) {
      console.error(`✗ MAPLEX_RELEASE_VERSION ${release} is not a sub-release of upstream ${base}`); failures++;
    } else {
      edit("TokenTrackerBar/project.yml", [[/MARKETING_VERSION: "[^"]+"/g, `MARKETING_VERSION: "${release}"`]]);
      edit("TokenTrackerWin/TokenTrackerWin.csproj", [[`<Version>${base}</Version>`, `<Version>${release}</Version>`]]);
      fs.writeFileSync(path.join(root, "dashboard/.env.production.local"), `VITE_APP_VERSION=${release}\n`);
      console.log(`✓ sub-release version ${release} (upstream ${base})`);
    }
  }
}

// ── 5. Safety net: nothing that ships may still point at the official backend ──
const shipped = ["src", "bin", "dashboard/src", "TokenTrackerBar/TokenTrackerBar", "TokenTrackerWin",
  "TokenTrackerLinux/src", "TokenTrackerLinux/src-tauri/src"];
const leaks = [];
const offenders = [OFFICIAL_API.replace("https://", ""), OFFICIAL_FN.replace("https://", ""), OFFICIAL_ANON.slice(-24)];
function walk(dir) {
  const p = path.join(root, dir);
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const rel = path.posix.join(dir.split(path.sep).join('/'), e.name);
    if (e.isDirectory()) {
      if (["node_modules", "__tests__", "tests", "test", "dist", "bin", "obj", "target", "publish"].includes(e.name) && dir !== ".") {
        if (!(rel === "bin")) continue;
      }
      walk(rel);
    } else if (/\.(c?js|mjs|ts|tsx|jsx|swift|cs|rs|json)$/.test(e.name) && !/\.test\./.test(e.name)) {
      const s = fs.readFileSync(path.join(root, rel), "utf8");
      for (const o of offenders) if (s.includes(o)) leaks.push(`${rel}: ${o}`);
    }
  }
}
shipped.forEach(walk);
// The official host only appears inside the legacy-hosts list (intentional).
// function-url.{js,ts} keep the (now unused) official functions constant only
// for the GET 404 legacy-retry branch, which can never match our origin.
// maplex-backend.js / insforge-config.ts also carry the official instance as
// the user-selectable "official" backend preset.
const allowed = ["src/lib/runtime-config.js", "src/lib/function-url.js", "dashboard/src/lib/function-url.ts",
  "src/lib/maplex-backend.js", "dashboard/src/lib/insforge-config.ts"];
const realLeaks = leaks.filter(l => !allowed.some(a => l.startsWith(a + ":")));
if (realLeaks.length) {
  console.error("✗ official backend still referenced in shipped sources:\n  " + realLeaks.join("\n  "));
  failures++;
}

if (failures) { console.error(`\n${failures} problem(s); overlay NOT applied cleanly.`); process.exit(1); }
console.log("\nmaplex overlay applied.");
