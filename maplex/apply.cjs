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

// ── 5. Safety net: nothing that ships may still point at the official backend ──
const shipped = ["src", "bin", "dashboard/src", "TokenTrackerBar/TokenTrackerBar", "TokenTrackerWin",
  "TokenTrackerLinux/src", "TokenTrackerLinux/src-tauri/src"];
const leaks = [];
const offenders = [OFFICIAL_API.replace("https://", ""), OFFICIAL_FN.replace("https://", ""), OFFICIAL_ANON.slice(-24)];
function walk(dir) {
  const p = path.join(root, dir);
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
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
const allowed = ["src/lib/runtime-config.js", "src/lib/function-url.js", "dashboard/src/lib/function-url.ts"];
const realLeaks = leaks.filter(l => !allowed.some(a => l.startsWith(a + ":")));
if (realLeaks.length) {
  console.error("✗ official backend still referenced in shipped sources:\n  " + realLeaks.join("\n  "));
  failures++;
}

if (failures) { console.error(`\n${failures} problem(s); overlay NOT applied cleanly.`); process.exit(1); }
console.log("\nmaplex overlay applied.");
