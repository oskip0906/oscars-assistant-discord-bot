#!/bin/bash
# Bring Panda's private SearXNG up as a local Python process next to the bot, no
# Docker. Called from run.sh right before every bot start; run.sh stops it again
# when the bot stops (searxng/searxng.pid).
#
# The first run fetches SearXNG at the pinned commit into searxng/src and
# installs it into searxng/.venv with uv (Python 3.12, which uv downloads if it
# is missing). Later runs reuse both, so a start costs a few seconds.
#
# Never fatal: every failure path exits 0. Search degrading to "unreachable" is
# bad; the bot failing to boot because search could not start is worse.
cd "$(dirname "$0")/.." || exit 0

url="${SEARXNG_URL:-$(grep -E '^SEARXNG_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)}"
url="${url:-http://127.0.0.1:8888}"
url="${url%/}"

# Only ever manage a loopback instance. docker-compose.deploy.yml runs SearXNG
# as its own service and points the bot at http://searxng:8080; nothing to start.
case "$url" in
  http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*) ;;
  *) exit 0 ;;
esac
port="${url##*:}"
case "$port" in ''|*[!0-9]*) port=8888 ;; esac

# Probed with node rather than curl: node is definitionally present (the bot
# runs on it) and curl is not guaranteed on Windows.
healthy() {
  node -e "fetch('$url/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

# Already up (left running, or started by hand): use it, and leave it alone.
healthy && exit 0

# The secret is per-machine and gitignored, so a fresh checkout has only the
# example. Generated here rather than documented in the README, because a README
# step nobody runs is how search ends up silently broken on a new machine.
if [ ! -f searxng/config/settings.yml ]; then
  secret=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' 2>/dev/null)
  if [ -n "$secret" ] && [ -f searxng/config/settings.example.yml ]; then
    sed "s|REPLACE_ME_run_openssl_rand_hex_32|$secret|" searxng/config/settings.example.yml > searxng/config/settings.yml \
      && echo "[searxng] generated searxng/config/settings.yml with a fresh secret_key"
  fi
fi

# SearXNG has no releases, only a rolling main branch, so pin a commit that has
# had time to settle. Bump it to update; the next start reinstalls.
ref=12f8b6515ca77c3c3bc1498584950ef5daca1433 # 2026-09-25
uv="${UV_BIN:-uv}"
git="${GIT_BIN:-git}"
python=searxng/.venv/bin/python
if [ "$(cat searxng/.venv/.panda-ref 2>/dev/null)" != "$ref" ]; then
  if ! command -v "$uv" >/dev/null 2>&1; then
    echo "[searxng] not reachable at $url and uv is not installed (brew install uv) — web and image search will fail" >&2
    exit 0
  fi
  echo "[searxng] installing SearXNG ${ref:0:7} (first start only)…"
  # The stamp is written last, so a half-finished install is retried next start.
  if ! { { [ -d searxng/src/.git ] || "$git" init -q searxng/src; } &&
    "$git" -C searxng/src fetch -q --depth 1 https://github.com/searxng/searxng.git "$ref" &&
    "$git" -C searxng/src checkout -q FETCH_HEAD &&
    "$uv" venv -q --clear -p 3.12 searxng/.venv &&
    "$uv" pip install -q --python "$python" -r searxng/src/requirements.txt &&
    echo "$ref" > searxng/.venv/.panda-ref; } >&2; then
    echo "[searxng] install failed — web and image search will fail until it is up" >&2
    exit 0
  fi
fi

# Loopback only, whatever settings.yml says: its bind_address of 0.0.0.0 is for
# the deploy container, and here it would put search on the local network.
echo "[searxng] starting local SearXNG…"
PYTHONPATH=searxng/src \
  SEARXNG_SETTINGS_PATH="$PWD/searxng/config/settings.yml" \
  SEARXNG_BIND_ADDRESS=127.0.0.1 \
  SEARXNG_PORT="$port" \
  SEARXNG_BASE_URL="$url/" \
  "$python" -m searx.webapp > searxng/searxng.log 2>&1 &
echo $! > searxng/searxng.pid

# Wait for it, so the bot's first search doesn't race its boot.
# SEARXNG_WAIT=0 skips the wait (tests); raise it on a slow machine.
for _ in $(seq 1 "${SEARXNG_WAIT:-30}"); do
  if healthy; then
    echo "[searxng] ready at $url"
    exit 0
  fi
  sleep 1
done
echo "[searxng] started but not answering yet — the first few searches may fail (see searxng/searxng.log)" >&2
exit 0
