#!/usr/bin/env node
// Verify every managed version file after the maplex overlay.
//
//   node maplex/verify-versions.cjs <checkout> <upstreamVersion> <releaseVersion>
//
// A maplex sub-release (e.g. 1.4.5.1 on top of upstream 1.4.5) only bumps the
// versions the updaters compare (macOS MARKETING_VERSION, Windows <Version>);
// everything else (npm package, Linux Cargo/tauri — semver only) stays on the
// upstream version.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const [rootArg, base, release] = process.argv.slice(2);
const root = path.resolve(rootArg || ".");
if (!/^\d+\.\d+\.\d+$/.test(base || "")) throw new Error(`Invalid upstream version: ${base}`);
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(release || "") || !(release === base || release.startsWith(`${base}.`))) {
  throw new Error(`Invalid release version ${release} for upstream ${base}`);
}

const NATIVE = /project\.yml|MARKETING_VERSION|csproj/;
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const project = fs.readFileSync(path.join(root, "TokenTrackerBar/project.yml"), "utf8");
const csproj = fs.readFileSync(path.join(root, "TokenTrackerWin/TokenTrackerWin.csproj"), "utf8");
const marketing = [...project.matchAll(/MARKETING_VERSION:\s*"([^"]+)"/g)].map((m) => m[1]);
if (marketing.length === 0) throw new Error("No MARKETING_VERSION entries in TokenTrackerBar/project.yml");

// version-files.cjs requires x.y.z for every entry; read the semver-only files
// through it but skip its native readers (they may now carry a 4th part).
const { collectVersionEntries } = require(path.join(root, "scripts/version-files.cjs"));
let entries = [];
try { entries = collectVersionEntries(root); } catch (error) {
  if (release === base) throw error;
}
const checks = [
  ["package.json", pkg.version],
  ["package-lock.json", lock.version],
  ["package-lock.json root package", lock.packages?.[""]?.version],
  ...marketing.map((v, i) => [`MARKETING_VERSION #${i + 1}`, v]),
  ["TokenTrackerWin.csproj", csproj.match(/<Version>([^<]+)<\/Version>/)?.[1]],
  ...entries.map(({ label, version }) => [label, version]),
];
let bad = 0;
for (const [label, actual] of checks) {
  const expected = NATIVE.test(label) ? release : base;
  if (actual !== expected) { console.error(`✗ ${label}: ${actual ?? "missing"} (expected ${expected})`); bad++; }
}
if (bad) process.exit(1);
console.log(`Versions OK: upstream ${base}, release ${release} (${checks.length} entries).`);
