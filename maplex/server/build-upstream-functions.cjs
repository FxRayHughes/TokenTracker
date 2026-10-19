#!/usr/bin/env node
// Build upstream TokenTracker edge functions for this self-hosted InsForge.
//   node maplex/server/build-upstream-functions.cjs <upstream checkout> <out dir>
// Uses upstream's own scripts/self-host builder and adds the leaderboard /
// public-profile functions that upstream reserves for its hosted cloud.
// Upload with:  node maplex/server/deploy-upstream-functions.mjs <out dir> [slug…]
"use strict";
const path = require("path");
const [checkout, out] = process.argv.slice(2);
if (!checkout || !out) { console.error("usage: build-upstream-functions.cjs <upstream checkout> <out dir>"); process.exit(2); }
const root = path.resolve(checkout);
const manifest = require(path.join(root, "scripts/self-host/manifest.cjs"));
const extra = ["tokentracker-leaderboard", "tokentracker-leaderboard-profile", "tokentracker-leaderboard-refresh",
  "tokentracker-public-visibility", "tokentracker-community-models", "tokentracker-profile-likes"];
for (const slug of extra) if (!manifest.privateFunctions.includes(slug)) manifest.privateFunctions.push(slug);
require(path.join(root, "scripts/self-host/build-functions.cjs")).buildFunctions(path.resolve(out))
  .then((result) => console.log(`built ${result.functions.length} functions into ${out}`));
