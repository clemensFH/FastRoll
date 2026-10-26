#!/usr/bin/env bash
# Bring up a whole local stack: chain, committee, client, prover, frontend.
#
#   scripts/up.sh                seven honest validators, Task 3 (with a prover)
#   scripts/up.sh --task 2       the same without the prover
#   scripts/up.sh --task 1       no chain, Task 1 semantics
#   scripts/up.sh --track rust   your Rust validator, client and prover instead
#                                of the TypeScript ones, built with cargo first;
#                                combines with --task
#   scripts/up.sh --evil 2       five honest, two byzantine (--variant names one)
#
# --evil needs bodies in packages/malicious, which ship empty: writing them is
# yours, and this flag is how you run them. Byzantine seats always run
# packages/malicious, whatever --track says.
#
# Everything runs from the host with anvil and tsx (and cargo for --track
# rust). No images, no install.
# scripts/down.sh stops it. Logs land in .stack/logs.
#
# This is the development loop, NOT the grading path. The grader builds an
# image and runs every process in a container, so a stack that only works here
# is a stack that does not pass. Use `docker compose up` in docker/ for
# something closer, and grader/run.sh for the real thing.
set -euo pipefail
cd "$(dirname "$0")/.."

L1_PORT=${L1_PORT:-8545}
V_PORT=${V_PORT:-9600}      # validators listen on V_PORT + i
VAPI_PORT=${VAPI_PORT:-9700}
CLIENT_PORT=${CLIENT_PORT:-9545}
PROVER_PORT=${PROVER_PORT:-9900}
WEB_PORT=${WEB_PORT:-8080}
# How often the prover scans on its own. A demo sets this very high so that the
# prover only acts when asked and the story stays in order.
PROVER_SCAN_MS=${PROVER_SCAN_MS:-2000}
L2_ID=${L2_ID:-7}
L2_CHAIN_ID=$((90000 + L2_ID))
L1_CHAIN_ID=31337
CHALLENGE_WINDOW=${CHALLENGE_WINDOW:-0}

EVIL=0
EVIL_VARIANT=${EVIL_VARIANT:-equivocate}
TASK=3
TRACK=ts

while [[ $# -gt 0 ]]; do
  case "$1" in
    --evil) EVIL="$2"; shift 2 ;;
    --variant) EVIL_VARIANT="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    --track)
      case "$2" in ts|rust) TRACK="$2" ;; *) echo "--track is ts or rust"; exit 2 ;; esac
      shift 2 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done

# Task 1 has no chain, so it needs node and python only; the chain tasks also
# need foundry for anvil, the deploy and the funding.
needs="npx python3"
[[ "$TASK" == "1" ]] || needs="$needs anvil cast forge"
for tool in $needs; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH"; exit 2; }
done

# The Rust track runs the release binaries, built here so a stale build is never
# what runs.
if [[ "$TRACK" == "rust" ]]; then
  command -v cargo >/dev/null || { echo "missing cargo on PATH, which --track rust needs"; exit 2; }
  echo "Building the Rust track:"
  (cd rust && cargo build --release --quiet -p atbt-validator -p atbt-client -p atbt-prover)
fi
# How one of our own processes starts: `run validator <config>`.
run_cmd() { # role
  if [[ "$TRACK" == "rust" ]]; then echo "rust/target/release/atbt-$1"; else echo "npx tsx packages/$1/src/index.ts"; fi
}

# An address from a key without foundry, for the Task 1 path.
addr_of() { npx tsx -e "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount('$1').address)"; }

DIR=.stack
mkdir -p "$DIR/logs" "$DIR/config"
: > "$DIR/pids"

# Every process is configured by one JSON file and nothing else. Writing them
# here rather than exporting a wall of variables is the whole point: it is the
# same contract a student implements from, so this script exercises it too.
cfg() { # cfg <name> <json>
  printf '%s\n' "$2" > "$DIR/config/$1.json"
  echo "$DIR/config/$1.json"
}

# Each process gets its own process group, so down.sh can stop the whole group:
# killing the shell alone leaves the npx tsx grandchild holding the port.
# setsid does that on Linux. macOS has no setsid, so there perl, which macOS
# ships, starts the group and execs the command in its place, keeping the pid.
# A command prefix and not a function: a backgrounded function runs in a
# subshell, and $! would then name the subshell rather than the group leader.
if command -v setsid >/dev/null 2>&1; then
  NEW_GROUP=(setsid)
else
  NEW_GROUP=(perl -e 'setpgrp(0, 0); exec @ARGV or die "exec $ARGV[0]: $!\n"')
fi

start() { # name command...
  local name="$1"; shift
  "${NEW_GROUP[@]}" "$@" >"$DIR/logs/$name.log" 2>&1 &
  echo "$!" >> "$DIR/pids"
  echo "  $name (pid $!, log $DIR/logs/$name.log)"
}

wait_for() { # url method label
  for _ in $(seq 1 150); do
    if curl -s -m 2 -X POST -H 'content-type: application/json' \
       --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "$1" \
       | grep -q '"result"'; then return 0; fi
    sleep 0.2
  done
  echo "  $3 never answered $2 on $1. See $DIR/logs." >&2
  exit 1
}

# Validator identities. Fixed, so a restart keeps the same committee and the
# frontend does not need reconfiguring.
VKEYS=(
  0x8100000000000000000000000000000000000000000000000000000000000000
  0x8200000000000000000000000000000000000000000000000000000000000000
  0x8300000000000000000000000000000000000000000000000000000000000000
  0x8400000000000000000000000000000000000000000000000000000000000000
  0x8500000000000000000000000000000000000000000000000000000000000000
  0x8600000000000000000000000000000000000000000000000000000000000000
  0x8700000000000000000000000000000000000000000000000000000000000000
)
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# The published Task 1 genesis account, from the Task 1 hand-out (task1.pdf).
GENESIS_KEY=0x6e5e515000000000000000000000000000000000000000000000000000000000
PROVER_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6

PEERS=""
for i in $(seq 0 6); do
  PEERS="${PEERS}${PEERS:+,}http://127.0.0.1:$((V_PORT + i))"
done

echo "Bringing up L2 ${L2_ID} (chain id ${L2_CHAIN_ID}), task ${TASK}"

if [[ "$TASK" == "1" ]]; then
  # Task 1 has no chain. Balances come from a genesis allocation instead.
  # The Task 1 contract: one published address holding the whole supply, so
  # `cast balance` prints exactly what the Task 1 hand-out says it will.
  GENESIS_ADDR=$(addr_of "$GENESIS_KEY")
  GENESIS_JSON="[{\"address\":\"$GENESIS_ADDR\",\"balance\":\"1000000000000000000000000\"}]"
  COMMITTEE=""
  for key in "${VKEYS[@]}"; do
    COMMITTEE="${COMMITTEE}${COMMITTEE:+,}$(addr_of "$key")"
  done
  MODE=standalone
else
  MODE=anchored
  echo "L1:"
  start anvil anvil --port "$L1_PORT" --chain-id "$L1_CHAIN_ID" --silent
  L1_RPC="http://127.0.0.1:${L1_PORT}"
  wait_for "$L1_RPC" eth_chainId anvil

  echo "Deploying:"
  DEPLOY_OUT=$(L1_RPC="$L1_RPC" DEPLOYER_KEY="$DEPLOYER_KEY" L2_ID="$L2_ID" \
    CHALLENGE_WINDOW="$CHALLENGE_WINDOW" bash grader/support/deploy.sh)
  pick() { echo "$DEPLOY_OUT" | grep -oE "ATBT_$1\s*=?\s*0x[0-9a-fA-F]{40}" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
  TOKEN=$(pick TOKEN); REGISTRY=$(pick REGISTRY); ESCROW=$(pick ESCROW); GATEWAY=$(pick GATEWAY)
  [[ -n "$GATEWAY" ]] || { echo "$DEPLOY_OUT" | tail -20; echo "deployment failed"; exit 1; }
  echo "  token    $TOKEN"
  echo "  registry $REGISTRY"
  echo "  escrow   $ESCROW"
  echo "  gateway  $GATEWAY"

  echo "Funding the committee:"
  # Funding only. Each validator bonds its own stake at startup, so registering
  # here would make that path dead code in the loop people actually develop
  # in: a validator that never bonds would work perfectly here and then be
  # absent from every committee under the grader.
  #
  # Moving to the first epoch with a committee therefore has to wait until the
  # validators are up, and it happens after they start, further down.
  COMMITTEE=""
  for i in $(seq 0 6); do
    addr=$(cast wallet address --private-key "${VKEYS[$i]}")
    cast send "$addr" --value 100ether --private-key "$DEPLOYER_KEY" --rpc-url "$L1_RPC" >/dev/null
    COMMITTEE="${COMMITTEE}${COMMITTEE:+,}${addr}"
    echo "  seat $i  $addr"
  done
  GENESIS_JSON="[]"
fi

echo "Validators:"
for i in $(seq 0 6); do
  honest=$(( i < 7 - EVIL ? 1 : 0 ))
  if [[ "$honest" == "1" ]]; then
    entry=packages/validator/src/index.ts
    name="v$i"
    # Expanded below as ${extra[@]+"${extra[@]}"}: macOS ships bash 3.2, where
    # "${extra[@]}" on an empty array is an unbound variable under set -u.
    extra=()
  else
    entry=packages/malicious/src/index.ts
    name="v$i-$EVIL_VARIANT"
    extra=(VARIANT="$EVIL_VARIANT")
  fi
  committee_json=$(printf '"%s",' ${COMMITTEE//,/ } | sed 's/,$//')
  # Standalone only. An anchored validator reads its committee from L1, which
  # is the entire point of staking for it.
  if [[ "$MODE" == "anchored" ]]; then
    committee_field=""
  else
    committee_field="
    \"committee\": [$committee_json],"
  fi
  if [[ "$MODE" == "anchored" ]]; then
    l1_json=",\"l1\":{\"rpcUrl\":\"$L1_RPC\",\"chainId\":$L1_CHAIN_ID,\"gateway\":\"$GATEWAY\",\"registry\":\"$REGISTRY\"},\"stake\":\"$(( (10 - i) ))000000000000000000\""
  else
    l1_json=""
  fi
  path=$(cfg "$name" "{
    \"name\": \"$name\", \"role\": \"validator\", \"mode\": \"$MODE\",
    \"identity\": { \"privateKey\": \"${VKEYS[$i]}\" },
    \"listen\": { \"port\": $((V_PORT + i)), \"vapiPort\": $((VAPI_PORT + i)) },
    \"l2\": { \"chainId\": $L2_CHAIN_ID },$committee_field
    \"genesis\": $GENESIS_JSON,
    \"dataDir\": \"$PWD/$DIR/data/$name\"$l1_json
  }")
  if [[ "$honest" == "1" ]]; then
    # shellcheck disable=SC2046
    start "$name" env ${extra[@]+"${extra[@]}"} $(run_cmd validator) "$path"
  else
    start "$name" env ${extra[@]+"${extra[@]}"} npx tsx "$entry" "$path"
  fi
done
for i in $(seq 0 6); do
  wait_for "http://127.0.0.1:$((VAPI_PORT + i))" vapi_info "validator $i"
done

if [[ "$MODE" == "anchored" ]]; then
  # Now that they are up, they bond themselves. A bond takes effect from the
  # epoch after the one it was made in, so once all seven have bonded, mine to
  # the next boundary: that epoch is the first one they sit on, and the
  # Registry answers for every epoch that has begun.
  echo "Seating the committee:"
  for _ in $(seq 1 60); do
    n=$(cast call "$REGISTRY" "registeredCount()(uint256)" --rpc-url "$L1_RPC" 2>/dev/null | awk '{print $1}')
    [[ "$n" == "7" ]] && break
    sleep 0.5
  done
  echo "  bonded ${n:-0}/7"
  now=$(cast block-number --rpc-url "$L1_RPC")
  cast rpc anvil_mine "$(( (now / 1000 + 1) * 1000 - now ))" --rpc-url "$L1_RPC" >/dev/null
  echo "  epoch $(( $(cast block-number --rpc-url "$L1_RPC") / 1000 )) begun, with all seven seated"
  for i in $(seq 0 6); do
    curl -s -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"vapi_syncNow","params":[]}' \
      "http://127.0.0.1:$((VAPI_PORT + i))" >/dev/null
  done
fi

if [[ "$TASK" == "3" ]]; then
  echo "Prover:"
  peers_json=$(printf '"%s",' ${PEERS//,/ } | sed 's/,$//')
  path=$(cfg prover "{
    \"name\": \"prover\", \"role\": \"prover\", \"mode\": \"anchored\",
    \"identity\": { \"privateKey\": \"$PROVER_KEY\" },
    \"listen\": { \"port\": $PROVER_PORT },
    \"peers\": [$peers_json],
    \"l2\": { \"chainId\": $L2_CHAIN_ID },
    \"l1\": { \"rpcUrl\": \"$L1_RPC\", \"chainId\": $L1_CHAIN_ID, \"gateway\": \"$GATEWAY\", \"registry\": \"$REGISTRY\" },
    \"intervals\": { \"scanMs\": ${PROVER_SCAN_MS:-2000} }
  }")
  # shellcheck disable=SC2046
  start prover $(run_cmd prover) "$path"
  wait_for "http://127.0.0.1:${PROVER_PORT}" prover_status prover
  PROVER_URL="http://127.0.0.1:${PROVER_PORT}"
else
  PROVER_URL=""
fi

echo "Client:"
peers_json=$(printf '"%s",' ${PEERS//,/ } | sed 's/,$//')
if [[ "$MODE" == "anchored" ]]; then
  l1_json=",\"l1\":{\"rpcUrl\":\"$L1_RPC\",\"chainId\":$L1_CHAIN_ID,\"gateway\":\"$GATEWAY\",\"registry\":\"$REGISTRY\"}"
else
  l1_json=""
fi
if [[ -n "$PROVER_URL" ]]; then prover_json=",\"proverUrl\":\"$PROVER_URL\""; else prover_json=""; fi
path=$(cfg client "{
  \"name\": \"client\", \"role\": \"client\", \"mode\": \"$MODE\",
  \"listen\": { \"port\": $CLIENT_PORT },
  \"peers\": [$peers_json],
  \"l2\": { \"chainId\": $L2_CHAIN_ID },
  \"minGasPrice\": \"1000000000\"$l1_json$prover_json
}")
# shellcheck disable=SC2046
start client $(run_cmd client) "$path"
wait_for "http://127.0.0.1:${CLIENT_PORT}" eth_chainId client

echo "Frontend:"
start web python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 --directory frontend

# The key that actually holds funds to try a transfer with: the genesis key in
# Task 1, and a deposit has to come first on the chain tasks.
if [[ "$TASK" == "1" ]]; then SEND_KEY_HINT="$GENESIS_KEY"; else SEND_KEY_HINT="<a key you deposited CRS for>"; fi

cat > "$DIR/env" <<ENVEOF
export L1_RPC="${L1_RPC:-}"
export L2_RPC="http://127.0.0.1:${CLIENT_PORT}"
export CLIENT_RPC="http://127.0.0.1:${CLIENT_PORT}"
export L2_CHAIN_ID=${L2_CHAIN_ID}
export L1_CHAIN_ID=${L1_CHAIN_ID}
export TOKEN="${TOKEN:-}"
export REGISTRY="${REGISTRY:-}"
export ESCROW="${ESCROW:-}"
export GATEWAY="${GATEWAY:-}"
export PEERS="${PEERS}"
export PROVER_URL="${PROVER_URL}"
ENVEOF

cat <<DONEEOF

Up. Source the addresses with:  source .stack/env

  L2 RPC        http://127.0.0.1:${CLIENT_PORT}
  frontend      http://127.0.0.1:${WEB_PORT}$( [[ -n "${GATEWAY:-}" ]] && echo "/?gateway=${GATEWAY}" )
  validators    ${V_PORT}..$((V_PORT + 6)), vapi on ${VAPI_PORT}..$((VAPI_PORT + 6))
$( [[ "$TASK" == "3" ]] && echo "  prover        http://127.0.0.1:${PROVER_PORT}" )
$( [[ "$MODE" == "anchored" ]] && echo "  L1 RPC        http://127.0.0.1:${L1_PORT}" )

Remember --legacy. This L2 has no EIP-1559 fee market, and a transfer order
has to be a pure function of what was signed or a fraud proof cannot
reproduce the fee.

  cast send --legacy --rpc-url \$L2_RPC --private-key ${SEND_KEY_HINT} <to> --value 1ether
  cast balance --rpc-url \$L2_RPC <address>

Stop everything with scripts/down.sh
DONEEOF
