#!/bin/bash
# Supervisor loop for panda-bot.
#   exit 0  -> clean stop (SIGINT/SIGTERM), loop ends
#   exit 42 -> self_fix requested a restart to load new code
#   other   -> crash; restart after 3s
cd "$(dirname "$0")" || exit 1

while :; do
  node src/index.js
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[run.sh] clean exit — stopping"
    break
  elif [ "$code" -eq 42 ]; then
    echo "[run.sh] self-fix restart — reloading new code"
    continue
  else
    echo "[run.sh] crashed (exit $code) — restarting in 3s"
    sleep 3
  fi
done
