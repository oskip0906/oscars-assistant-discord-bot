#!/bin/bash
# Bring the private SearXNG instance up, if this machine is the one meant to run
# it. Called from run.sh on every boot.
#
# Idempotent and never fatal: `docker compose up -d` on a running stack is a
# no-op, and every failure path here exits 0. Search degrading to "unreachable"
# is bad; the bot failing to boot because Docker is missing is worse.
cd "$(dirname "$0")/.." || exit 0

url="${SEARXNG_URL:-$(grep -E '^SEARXNG_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)}"
url="${url:-http://127.0.0.1:8888}"
url="${url%/}"

# Only ever manage a loopback instance. docker-compose.deploy.yml runs SearXNG
# as its own service and points the bot at http://searxng:8080 — that container
# has no docker socket and nothing here to start.
case "$url" in
  http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*) ;;
  *) exit 0 ;;
esac

# Probed with node rather than curl: node is definitionally present (the bot
# runs on it) and curl is not guaranteed on Windows.
healthy() {
  node -e "fetch('$url/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

healthy && exit 0

# Overridable so a podman-compose machine (and the tests) can point elsewhere.
docker="${DOCKER_BIN:-docker}"
if ! command -v "$docker" >/dev/null 2>&1; then
  echo "[searxng] not reachable at $url and docker is unavailable — web and image search will fail until it is up" >&2
  exit 0
fi

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

echo "[searxng] starting panda-searxng…"
if ! "$docker" compose -f searxng/docker-compose.yml up -d >/dev/null 2>&1; then
  echo "[searxng] could not start the container — web and image search will fail until it is up" >&2
  exit 0
fi

# Wait for it, so the bot's first search doesn't race the container's boot.
# SEARXNG_WAIT=0 skips the wait (tests); raise it on a slow machine.
for _ in $(seq 1 "${SEARXNG_WAIT:-30}"); do
  if healthy; then
    echo "[searxng] ready at $url"
    exit 0
  fi
  sleep 1
done
echo "[searxng] started but not answering yet — the first few searches may fail" >&2
exit 0
