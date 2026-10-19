#!/usr/bin/env node
// Upload functions built by build-upstream-functions.cjs.
//   INSFORGE_URL=https://insforge.maplex.top INSFORGE_ADMIN_KEY_FILE=~/ik.txt \
//     node maplex/server/deploy-upstream-functions.mjs <dir> [slug…]
// The admin (ik_) key is read from a file outside the repo. The admin API is
// rate limited (~15 writes per window); re-run with the missing slugs on 429.
import fs from "node:fs";
const [dir, ...only] = process.argv.slice(2);
const base = `${(process.env.INSFORGE_URL || "https://insforge.maplex.top").replace(/\/$/, "")}/api/functions`;
const key = fs.readFileSync(process.env.INSFORGE_ADMIN_KEY_FILE || "", "utf8").trim();
const headers = { "x-api-key": key, "Content-Type": "application/json" };
const existing = new Set((await (await fetch(base, { headers })).json()).functions.map((f) => f.slug));
const manifest = JSON.parse(fs.readFileSync(`${dir}/functions.json`, "utf8"));
for (const f of manifest.functions) {
  if (only.length && !only.includes(f.slug)) continue;
  const code = fs.readFileSync(`${dir}/${f.file}`, "utf8");
  const body = JSON.stringify({ name: f.slug, slug: f.slug, code, description: "TokenTracker self-host", status: "active" });
  const res = existing.has(f.slug)
    ? await fetch(`${base}/${f.slug}`, { method: "PUT", headers, body })
    : await fetch(base, { method: "POST", headers, body });
  console.log(existing.has(f.slug) ? "update" : "create", f.slug, res.status, res.ok ? "" : (await res.text()).slice(0, 200));
}
