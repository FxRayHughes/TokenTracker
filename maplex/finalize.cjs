#!/usr/bin/env node
// Post-patch steps that depend on the build, not on upstream source:
//   1. maplex sub-release version stamp (MAPLEX_RELEASE_VERSION=X.Y.Z.N)
//   2. safety net: nothing that ships may still point at the official backend
//
//   node maplex/finalize.cjs <checkout>
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || ".");
const OFFICIAL_API = "https://srctyff5.us-east.insforge.app";
const OFFICIAL_FN = "https://srctyff5.function2.insforge.app";
const OFFICIAL_ANON_TAIL = "T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY".slice(-24);
let failures = 0;

// ── 1. Sub-release: only the versions the updaters compare get the 4th part ──
{
  const release = (process.env.MAPLEX_RELEASE_VERSION || "").replace(/^v/, "");
  const base = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (release && release !== base) {
    if (!new RegExp(`^${base.replace(/\./g, "\\.")}\\.[1-9]\\d*$`).test(release)) {
      console.error(`✗ MAPLEX_RELEASE_VERSION ${release} is not a sub-release of upstream ${base}`);
      failures++;
    } else {
      const stamp = (rel, from, to) => {
        const p = path.join(root, rel);
        const s = fs.readFileSync(p, "utf8");
        const next = s.replace(from, to);
        if (next === s) { console.error(`✗ ${rel}: version not found`); failures++; return; }
        fs.writeFileSync(p, next);
      };
      stamp("TokenTrackerBar/project.yml", /MARKETING_VERSION: "[^"]+"/g, `MARKETING_VERSION: "${release}"`);
      stamp("TokenTrackerWin/TokenTrackerWin.csproj", `<Version>${base}</Version>`, `<Version>${release}</Version>`);
      fs.writeFileSync(path.join(root, "dashboard/.env.production.local"), `VITE_APP_VERSION=${release}\n`);
      console.log(`✓ sub-release version ${release} (upstream ${base})`);
    }
  }
}

// ── 2. maplex UI copy (kept out of the patches: upstream appends to these
// files every release, so a patch hunk at their end conflicts every time) ──
{
  const dir = path.join(__dirname, "copy");
  const csvPath = path.join(root, "dashboard/src/content/copy.csv");
  let csv = fs.readFileSync(csvPath, "utf8");
  const have = new Set(csv.split("\n").map((l) => l.split(",")[0]));
  const rows = fs.readFileSync(path.join(dir, "copy.csv.rows"), "utf8").split("\n").filter(Boolean);
  const add = [];
  for (const row of rows) {
    const key = row.split(",")[0];
    if (!have.has(key)) add.push(row);
    else if (!csv.includes(`\n${row}\n`) && !csv.endsWith(`\n${row}`)) {
      console.error(`✗ copy.csv: upstream now defines maplex key ${key}`); failures++;
    }
  }
  if (add.length) fs.writeFileSync(csvPath, csv.replace(/\n*$/, "\n") + add.join("\n") + "\n");
  for (const locale of ["zh", "zh-TW"]) {
    const p = path.join(root, `dashboard/src/content/i18n/${locale}/core.json`);
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    const extra = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), "utf8"));
    for (const [k, v] of Object.entries(extra)) {
      if (k in json && json[k] !== v) { console.error(`✗ ${locale}/core.json: upstream now defines ${k}`); failures++; }
      json[k] = v;
    }
    fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
  }
  console.log(`✓ maplex copy: ${add.length} row(s) added`);
}

// ── 3. Safety net ──
const shipped = ["src", "bin", "dashboard/src", "TokenTrackerBar/TokenTrackerBar", "TokenTrackerWin",
  "TokenTrackerLinux/src", "TokenTrackerLinux/src-tauri/src"];
const skipDirs = ["node_modules", "__tests__", "tests", "test", "dist", "bin", "obj", "target", "publish"];
// Upstream release URLs: an updater reading them would replace this build
// with the official one (e.g. a new updater file upstream adds).
const offenders = [OFFICIAL_API.replace("https://", ""), OFFICIAL_FN.replace("https://", ""), OFFICIAL_ANON_TAIL,
  "xiufengsun/TokenTracker/releases", "repos/xiufengsun/TokenTracker"];
// Intentional references: legacy-host list, official functions origin, the
// user-selectable "official" backend preset, and the read-only official board.
const allowed = ["src/lib/runtime-config.js", "src/lib/function-url.js", "dashboard/src/lib/function-url.ts",
  "src/lib/maplex-backend.js", "dashboard/src/lib/insforge-config.ts", "dashboard/src/lib/maplex-board.js"];
const leaks = [];
function walk(dir) {
  const p = path.join(root, dir);
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const rel = path.posix.join(dir.split(path.sep).join("/"), e.name);
    if (e.isDirectory()) {
      if (skipDirs.includes(e.name) && rel !== "bin") continue;
      walk(rel);
    } else if (/\.(c?js|mjs|ts|tsx|jsx|swift|cs|rs|json)$/.test(e.name) && !/\.test\./.test(e.name)) {
      const s = fs.readFileSync(path.join(root, rel), "utf8");
      for (const o of offenders) if (s.includes(o) && !allowed.includes(rel)) leaks.push(`${rel}: ${o}`);
    }
  }
}
shipped.forEach(walk);
if (leaks.length) {
  console.error("✗ official backend still referenced in shipped sources:\n  " + leaks.join("\n  "));
  failures++;
}

if (failures) { console.error(`\n${failures} problem(s); maplex build NOT ready.`); process.exit(1); }
console.log("✓ maplex finalize done");
