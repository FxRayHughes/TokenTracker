# TokenTracker — maplex self-hosted builds

This branch (`maplex`, the default branch of this fork) contains **no TokenTracker source**.
It is a small overlay that every release applies on top of an upstream tag.

| Item | Value |
| --- | --- |
| Backend (InsForge) | https://insforge.maplex.top |
| Dashboard / login callback | https://tokentracker.maplex.top |
| Client auto-update source | GitHub Releases of `FxRayHughes/TokenTracker` |
| Upstream | `xiufengsun/TokenTracker` (only read from, never auto-installed) |

## What the overlay changes (`maplex/apply.cjs`)

- CLI and embedded server:
  - The default backend, anon key and dashboard URL point to maplex.
  - Edge functions go through `<backend>/functions/<slug>`.
  - Configs pinned to the official backend fall back to maplex.
- Dashboard (web and the copy embedded in every desktop app):
  - The same defaults apply.
  - PostHog analytics is disabled.
  - Official-only paid and public-profile features are disabled.
  - Download, release and star links point to this fork.
- Auto-updaters:
  - macOS `UpdateChecker.swift` and Windows `UpdateReleaseClient.cs` read this fork's releases.
  - Linux has no auto-updater upstream.
- Leaderboard extras, each switchable in Settings → 官方排行榜:
  - An official (tokentracker.cc) leaderboard tab, read-only.
  - Your own Maplex totals inserted into it as a local preview.
  - "Preview as": me, a guest or any user id, without switching the app account.
  - The server-side relay that uploads your summed Maplex usage to an official account (`maplex/server`).
- Safety net: the script fails if any shipped source still references the official backend, or if an anchor moved upstream.

Values live in `maplex/config.json`.

## How releases happen

1. `follow-upstream.yml` runs every 6 hours and can also be started manually:
   - It reads upstream `releases/latest`.
   - If this fork has no published release with the same tag, it dry-runs the overlay against that tag.
   - It then dispatches `release.yml` with the **same version number**.
2. `release.yml`:
   - Checks out the upstream tag and applies the overlay.
   - Builds the macOS DMG (universal, ad-hoc signed), the Windows Setup.exe and zip, and the Linux AppImage, deb and rpm.
   - Uploads `SHA256SUMS` and publishes the release.
   - The git tag `vX.Y.Z` in this repo points to the overlay commit that was used. The upstream commit is recorded in the release notes.

Manual build of one version: Actions → *follow upstream releases* → Run workflow → `version=1.4.3`.

### maplex sub-releases (client-only fixes between upstream versions)

When the overlay changes but upstream has not released, publish **`vX.Y.Z.N`** on top of upstream `vX.Y.Z`:

```sh
gh workflow run release.yml --repo FxRayHughes/TokenTracker --ref maplex -f version=1.4.5.1
```

- Only the versions the updaters compare get the 4th part: macOS `MARKETING_VERSION`, Windows `<Version>`, and the dashboard's displayed version. npm and Linux keep `X.Y.Z` because those only accept semver.
- `1.4.5` < `1.4.5.1` < `1.4.6`. Installed apps update to the sub-release, and upstream's next version still updates everyone normally.
- *follow upstream* only watches upstream tags (`vX.Y.Z`), so sub-releases never block it.
- Never rebuild an already published version: clients never re-download the same version number.
- `maplex/verify-versions.cjs` enforces this split.

If the overlay fails after an upstream change, fix the anchor in `maplex/apply.cjs`, push, and re-run.

## Server side

See [`maplex/server/README.md`](maplex/server/README.md): SQL shims, the official-leaderboard bridge, the deploy script and the InsForge override.

## Server dashboard

```bash
git clone --depth 1 -b v1.4.3 https://github.com/xiufengsun/TokenTracker && cd TokenTracker
node /path/to/maplex/apply.cjs . && npm ci --prefix dashboard
VITE_INSFORGE_BASE_URL=https://insforge.maplex.top VITE_INSFORGE_ANON_KEY=anon_ccd53a08643fee52b46be47046ce44c69d0cd34b npm run dashboard:build
# upload dashboard/dist/* to /opt/1panel/www/sites/tokentracker.maplex.top/index/
```
