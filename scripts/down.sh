#!/usr/bin/env bash
# Stop everything scripts/up.sh started.
set -uo pipefail
cd "$(dirname "$0")/.."

DIR=.stack
[[ -f "$DIR/pids" ]] || { echo "nothing recorded in $DIR/pids"; }

if [[ -f "$DIR/pids" ]]; then
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    # Negative pid signals the whole group. up.sh starts each process in its own
    # group (setsid on Linux, perl's setpgrp on macOS) for exactly this:
    # killing the shell alone leaves the npx tsx grandchild holding the port,
    # and the next start then fails on a port nothing appears to be using.
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done < "$DIR/pids"
  sleep 1
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  done < "$DIR/pids"
  rm -f "$DIR/pids"
fi

# Anything that escaped, named rather than guessed at.
for pat in "packages/validator/src/index.ts" "packages/malicious/src/index.ts" \
           "packages/client/src/index.ts" "packages/prover/src/index.ts"; do
  pkill -9 -f "$pat" 2>/dev/null
done
echo "stopped."
