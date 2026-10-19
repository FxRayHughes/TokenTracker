# maplex server side (insforge.maplex.top)

Everything the self-hosted TokenTracker cloud needs on top of a stock InsForge
install. **No secret is stored here.** Keys live in the server's `.env` and in
InsForge function secrets.

| Path | What |
| --- | --- |
| `insforge/docker-compose.override.local.yml` | Pins InsForge `v2.3.3` and binds 7130/7131 to 127.0.0.1 only (1Panel reverse-proxies `insforge.maplex.top`). |
| `leaderboard.sql` | Leaderboard schema shims for upstream's hosted-only functions: snapshot tables, user settings, profile likes, community stats and `leaderboard_*` RPCs. Badges are stubs. |
| `official-bridge.sql` | `maplex_official_links`, plus the `maplex_official_relay_rows` RPC (sums over a user's devices) and the cron job `maplex-official-bridge` (minutes :17 and :47). |
| `functions/maplex-official-bridge.js` | Edge function that links a Maplex account to an official tokentracker.cc account and relays its usage. |
| `deploy.sh` | Run on the server. It creates the missing function secrets, applies both SQL files (`sql`) and uploads `functions/*.js` (`functions`). |
| `build-upstream-functions.cjs`, `deploy-upstream-functions.mjs` | Build upstream TokenTracker functions (ingest, leaderboard, …) for self-hosting from an upstream tag, then upload them. |

## Install / update

```sh
# InsForge itself: upstream setup (INSFORGE_REF=v2.3.3) in /opt/1panel/apps/custom/insforge,
# then copy insforge/docker-compose.override.local.yml next to its docker-compose.yml.

# Upstream TokenTracker schema + functions (from the upstream tag that is being released):
git clone --depth 1 -b v1.4.5 https://github.com/xiufengsun/TokenTracker ~/tt && (cd ~/tt && npm ci)
node ~/tt/scripts/self-host/install.cjs --sql ~/tt-install.sql   # then psql -f it (upstream docs/self-hosting.md)
node maplex/server/build-upstream-functions.cjs ~/tt ~/tt-fns
INSFORGE_ADMIN_KEY_FILE=/root/ik.txt node maplex/server/deploy-upstream-functions.mjs ~/tt-fns

# maplex additions (on the server, from a checkout of this branch):
INSFORGE_DIR=/opt/1panel/apps/custom/insforge bash maplex/server/deploy.sh all
```

The pg_cron jobs installed by these scripts:

- `maplex-leaderboard-week`: every 10 minutes, refreshes week and month.
- `maplex-leaderboard-total`: hourly at :05, refreshes total and community stats.
- `maplex-official-bridge`: at :17 and :47, relays linked accounts.

These jobs call the functions through `http://insforge:7130` with the `LEADERBOARD_REFRESH_SECRET` function secret.

## Official leaderboard bridge

```
Maplex devices ──ingest──▶ insforge.maplex.top ──(sum over devices, every 30 min)──▶ official tokentracker-ingest
                                    ▲                                                   (one "Maplex relay" device)
                     Settings → 官方排行榜 → 关联官方账号 (official device flow, approve on tokentracker.cc)
```

- **Linking:** the user approves a device code on `https://www.tokentracker.cc/device` with their official account. The official device token is stored AES-GCM encrypted (`MAPLEX_BRIDGE_KEY`) and never leaves the server.
- **Relay:** rows are relayed per (hour, source, model) as the sum over all the user's active Maplex devices. Official ingest replaces rows with the same key, so re-sending is idempotent. A watermark (`updated_at`, row key) sends only changed rows.
- **Throttling:** the official cloud throttles free accounts (HTTP 429 plus `next_allowed_at`). The bridge stores that time and waits.
- **User switches:** the user can pause the relay (`set_enabled`), trigger it (`relay_now`) or unlink at any time.
- **Testing:** set the function secrets `MAPLEX_BRIDGE_TARGET_FUNCTIONS`, `MAPLEX_BRIDGE_TARGET_ANON` and `MAPLEX_BRIDGE_TARGET_DASHBOARD` to point the bridge at another TokenTracker instance (for example this one). Delete them afterwards: `DELETE FROM system.secrets WHERE key LIKE 'MAPLEX_BRIDGE_TARGET%'`.

## Dashboard (tokentracker.maplex.top)

Use the `TokenTracker-maplex-web-*.tar.gz` asset from a release. If there is none, build the dashboard as described in the top-level README. Then unpack it into `/opt/1panel/www/sites/tokentracker.maplex.top/index/`.
