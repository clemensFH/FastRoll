# Running a local stack

Two ways, and they do the same thing, with two limits on the compose path: it runs the TypeScript processes only, and only the anchored mode of Tasks 2 and 3.
`scripts/up.sh` runs either track, for any task.
Neither is how you are graded: `grader/run.sh` builds its own image and runs each scenario in its own network, with a different committee each time.
These two are for developing against, where a stack you can poke at beats one that tears itself down.

## From the host

```
scripts/up.sh                seven honest validators and a prover, Task 3
scripts/up.sh --task 2       the same without the prover
scripts/up.sh --task 1       no chain, Task 1 semantics
scripts/up.sh --track rust   your Rust binaries instead of the TypeScript ones, with any --task
scripts/up.sh --evil 2       five honest, two equivocating (needs packages/malicious bodies)
scripts/down.sh
```

Needs `anvil`, `cast`, `forge`, `npx` and `python3` on your PATH, and `cargo` for `--track rust`.
The frontend link it prints carries the Gateway address; under compose, type in the `gateway` line of `docker compose logs setup`.
Starts in a few seconds, logs land in `.stack/logs`, and `source .stack/env` gives you the addresses.

## With docker compose

```
cd docker && docker compose up --build
docker compose down -v
```

Needs only docker.
Slower to start, and it is what to use on a machine where the host toolchain is not working.

Each service reads one config file, which the entrypoint renders from the addresses the `setup` service deploys.
`setup` funds the committee, but does not bond anyone: each validator bonds its own stake at startup, and `setup` waits for all seven, then mines to the next epoch boundary, because a bond takes effect from the epoch after the one it was made in.

| What | From the host | With compose |
| --- | --- | --- |
| L2 RPC, cast-compatible | `http://127.0.0.1:9545` | `http://127.0.0.1:9545` |
| L1 RPC | `http://127.0.0.1:8545` | `http://127.0.0.1:8545` |
| Frontend | `http://127.0.0.1:8080` | `http://127.0.0.1:8080` |
| Prover | `http://127.0.0.1:9900` | `http://127.0.0.1:9900` |
| Validators, `fastpay_` | `9600` to `9606` | `v0:9600` to `v6:9600`, inside the network |
| Validators, `vapi_` | `9700` to `9706`, loopback | not published |

The compose validators are deliberately not published.
The client and the prover reach them by name inside the network, and nothing outside needs to.

## Talking to it

```
source .stack/env
cast send --legacy --rpc-url $L2_RPC --private-key <a funded key> <to> --value 1ether
cast balance --rpc-url $L2_RPC <address>
```

`--legacy` is not optional.
There is no EIP-1559 fee market here, because a transfer order has to be a pure function of what was signed or a fraud proof cannot reproduce the fee.
The client rejects `eth_feeHistory` with a message saying so.

Nothing posts on a timer in the grader, but both of these stacks do.

From the host path you can force one immediately, because `vapi_` is published
on loopback there:

```
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"vapi_postNow","params":[]}' \
  http://127.0.0.1:9700
```

Under compose `vapi_` is not published, so the same call has to go through the
container:

```
docker compose exec v0 curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"vapi_postNow","params":[]}' \
  http://127.0.0.1:9700
```

## Two things worth knowing about the compose file

`env_file` cannot carry addresses from the setup service to the others.
Compose reads `env_file` when it plans the run, before anything has started, so a file written during that same `up` is always read empty no matter what `depends_on` says.
The addresses travel through a shared volume and `docker/entrypoint.sh` loads them at container start.

The setup service runs as root.
The foundry image runs as a non-root user, which cannot write to a fresh named volume, and only that one-shot container needs the privilege.
