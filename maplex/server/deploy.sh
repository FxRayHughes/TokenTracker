#!/usr/bin/env bash
# maplex server-side deploy: SQL shims, maplex edge functions, function secrets.
# Run ON the InsForge host from a checkout of this branch:
#   INSFORGE_DIR=/opt/1panel/apps/custom/insforge bash maplex/server/deploy.sh [sql|functions|secrets|all]
# Reads ACCESS_API_KEY from $INSFORGE_DIR/.env; no secret lives in this repo.
# Upstream TokenTracker functions (ingest, leaderboard, …) are built from the
# upstream tag with scripts/self-host (see README) and are not handled here.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INSFORGE_DIR="${INSFORGE_DIR:-/opt/1panel/apps/custom/insforge}"
API="${INSFORGE_API:-http://127.0.0.1:7130}"
WHAT="${1:-all}"
IK="$(grep '^ACCESS_API_KEY=' "$INSFORGE_DIR/.env" | cut -d= -f2-)"
[ -n "$IK" ] || { echo "ACCESS_API_KEY missing in $INSFORGE_DIR/.env" >&2; exit 1; }

psql_run() { (cd "$INSFORGE_DIR" && docker compose exec -T postgres psql -U postgres -d insforge -v ON_ERROR_STOP=1 "$@"); }
secret_exists() {
  curl -fsS -H "x-api-key: $IK" "$API/api/secrets" |
    python3 -c "import json,sys; sys.exit(0 if any(s['key']==sys.argv[1] for s in json.load(sys.stdin)['secrets']) else 1)" "$1"
}
put_secret() { # key value — created once, never overwritten (rotation is manual)
  if secret_exists "$1"; then echo "secret $1: exists"; return; fi
  python3 -c "import json,sys; print(json.dumps({'key':sys.argv[1],'value':sys.argv[2]}))" "$1" "$2" |
    curl -fsS -o /dev/null -w "secret $1: %{http_code}\n" -X POST -H "x-api-key: $IK" -H "Content-Type: application/json" --data-binary @- "$API/api/secrets"
}
refresh_secret() { # function secrets can be read back through the admin API
  curl -fsS -H "x-api-key: $IK" "$API/api/secrets/LEADERBOARD_REFRESH_SECRET" | python3 -c "import json,sys; print(json.load(sys.stdin)['value'])"
}

if [ "$WHAT" = secrets ] || [ "$WHAT" = all ]; then
  put_secret LEADERBOARD_REFRESH_SECRET "$(openssl rand -hex 24)"
  put_secret MAPLEX_BRIDGE_KEY "$(openssl rand -hex 32)"
fi

if [ "$WHAT" = sql ] || [ "$WHAT" = all ]; then
  psql_run -f - < "$HERE/leaderboard.sql" >/dev/null && echo "sql leaderboard.sql: ok"
  RS="$(refresh_secret | tr -d '\r\n')"
  [ -n "$RS" ] || { echo "cannot read LEADERBOARD_REFRESH_SECRET" >&2; exit 1; }
  psql_run -v refresh_secret="$RS" -f - < "$HERE/official-bridge.sql" >/dev/null && echo "sql official-bridge.sql: ok"
fi

if [ "$WHAT" = functions ] || [ "$WHAT" = all ]; then
  existing="$(curl -fsS -H "x-api-key: $IK" "$API/api/functions")"
  for f in "$HERE"/functions/*.js; do
    slug="$(basename "$f" .js)"
    body="$(python3 -c "import json,sys; c=open(sys.argv[1]).read(); print(json.dumps({'name':sys.argv[2],'slug':sys.argv[2],'code':c,'description':'maplex','status':'active'}))" "$f" "$slug")"
    if printf '%s' "$existing" | python3 -c "import json,sys; sys.exit(0 if any(x['slug']==sys.argv[1] for x in json.load(sys.stdin)['functions']) else 1)" "$slug"; then
      printf '%s' "$body" | curl -sS -o /dev/null -w "update $slug: %{http_code}\n" -X PUT -H "x-api-key: $IK" -H "Content-Type: application/json" --data-binary @- "$API/api/functions/$slug"
    else
      printf '%s' "$body" | curl -sS -o /dev/null -w "create $slug: %{http_code}\n" -X POST -H "x-api-key: $IK" -H "Content-Type: application/json" --data-binary @- "$API/api/functions"
    fi
  done
fi
