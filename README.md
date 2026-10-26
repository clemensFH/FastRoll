# Advanced Topics in Blockchain Technologies: the project

You need Node.js 22 or later with pnpm, docker, and [Foundry](https://getfoundry.sh) (`forge`, `cast`, `anvil`); for the Rust track, a Rust toolchain as well.

```bash
pnpm install
forge build
forge test        # the public pass bar for the contracts
pnpm test         # conformance vectors
```

This skeleton covers task 1.

The task descriptions and the protocol description are the course hand-out (`FastRoll-Task-1.pdf` to `FastRoll-Task-3.pdf` and `FastRoll-Protocol-Description.pdf`, with the course materials). Start with Task 1.
The protocol description is the reference for everything, in three sections, one per task.
Read its introduction and then only the section you are on. `spec/SPEC.md` and `tasks/` here only point to the hand-out.

Search for `TODO(task-N)` to find the work for a milestone.

## What you are building

FastPay ([arXiv 2003.11506](https://arxiv.org/abs/2003.11506)), then a rollup around it.
Seven validators, one round of messages, safety without liveness.

| Task | What is added |
| --- | --- |
| 1 | FastPay, no chain |
| 2 | anchor it to L1: staked committee, batches, bridging |
| 3 | fraud proofs, and a prover that finds the fraud |

## What is given, and must not be modified

- `spec/` including the conformance vectors. If your code disagrees with a vector, your code is wrong.
- `contracts/src/IGateway.sol`. Editing it removes the compiler check that your Gateway is interoperable.
- `packages/common/`: the sparse Merkle tree, order decoding, certificate encoding and verification, the state transition, L1 access, ABIs. One change is expected: `src/abi.ts` is generated from the skeleton's contracts, so after adding your fraud proofs in Task 3, run `forge build` and `pnpm abis` to regenerate it.
- `rust/common/`: the same library in Rust, checked against the same vectors.
- `contracts/src/lib/`: `MerkleLib.sol`, `Protocol.sol`, `RLPTx.sol`.
- `contracts/src/CourseToken.sol`, `Escrow.sol`, `Registry.sol`.
- `contracts/script/`, `foundry.toml`, and the given constructor of `Gateway.sol`: the grader deploys your Gateway with `Deploy.s.sol` and builds with `foundry.toml`.
- `frontend/`, `scripts/`, `docker/`, `grader/` apart from your own scenarios: tools, not exercises.

What `IGateway.sol` declares is frozen even though the bodies are yours: the batch accessor's field order, `deposit`, `postBatch`, `withdraw`, `slashed`, the events and those errors.
The FRAUD PROOFS are not. `IGateway` does not declare them, and you choose their shape; see the Task 3 description in the hand-out.
The JSON-RPC surfaces in the protocol description are frozen, and so are the five `kind` strings a prover reports.

## What you write

Pick TypeScript or Rust for the three off-chain processes. Both tracks have the same `TODO(task-N)` regions in the same places, and the grader cannot tell them apart.

**The skeleton is a help, not a constraint.** Use it as you like: start from it, implement from scratch, carry on from your own earlier work, or switch languages between tasks. What counts is that your processes and your Gateway implement the frozen interfaces exactly, because the automated grading talks to nothing else.

TypeScript:

- `packages/validator/src/state.ts`, `rpc.ts`, `index.ts`
- `packages/client/src/driver.ts`, `index.ts`
- `packages/prover/src/index.ts`

Rust:

- `rust/validator/src/state.rs`, `rpc.rs`, `node.rs`, `main.rs`
- `rust/client/src/driver.rs`, `lib.rs`
- `rust/prover/src/prover.rs`, `main.rs`

Either way:

- `contracts/src/Gateway.sol`

Optional, and the best way to test the above:

- `grader/src/scenarios/index.ts`, your own scenarios
- `packages/malicious/src/index.ts`, byzantine committee members to run them against

The language is not actually limited to those two.
The grader starts your processes and talks to them over the frozen interfaces, so a validator written in anything that speaks HTTP will be graded identically.
The given library exists only in TypeScript and Rust, though, and rewriting it in a third language is a larger job than the project.

## Running a local stack

```bash
scripts/up.sh            seven validators, a chain, a client, a prover, the frontend
scripts/up.sh --task 1   no chain
scripts/down.sh
```

Then:

```bash
source .stack/env                 # L2_RPC is the client's URL
cast send --legacy --rpc-url $L2_RPC --private-key <a funded key> <to> --value 1ether
cast balance --rpc-url $L2_RPC <address>
```

In Task 1 the funded key is the genesis key in the Task 1 description; from Task 2 on, an account is funded by depositing on L1.
`scripts/up.sh` runs the TypeScript processes; `scripts/up.sh --track rust` builds and runs the Rust ones instead, for any `--task`.

`--legacy` is not optional.
There is no EIP-1559 fee market here, because the fee has to be a pure function of the signed order or a fraud proof cannot reproduce it.

See `docker/README.md` for the compose path, which needs only docker.
It runs the anchored setup of Tasks 2 and 3, with the TypeScript processes only.
For Task 1, or for the Rust track, use `scripts/up.sh` with `--task 1` or `--track rust`.

## Grading yourself

```bash
pnpm grade                       every scenario in grader/src/scenarios/index.ts
pnpm grade -- --task 1           one task
pnpm grade -- --scenario 3 -v    one scenario, with process output
pnpm grade -- --manifest grader/solution-rust.json    the Rust track
pnpm grade -- --check-setup --task 2                   does it start at all?
```

`--check-setup` runs no scenario and needs none written.
For each task it starts the processes that task's scenarios start, all honest, and checks only that the image builds, every process reads its config and answers, and from Task 2 on that your Gateway deploys and the validators bond and are seated.
It asserts nothing about the protocol, so passing it means a failing scenario failed on behaviour, not on setup.
Run it before you submit.
The lecture team runs the same check on every submission.

The manifest is what tells the grader which track you took: `grader/solution.json` builds `docker/Dockerfile` and runs the TypeScript processes, `grader/solution-rust.json` builds `rust/Dockerfile` and runs the Rust ones.

The harness runs on node from this repository, so it needs `pnpm install` first, and docker.
It builds an image from your manifest's Dockerfile and runs every graded process in a container, without internet, and anvil, forge and cast come from a container too.
Your solution is graded the same way, which is worth knowing early: if it only runs on your machine, it does not run.
`pnpm grade -- --offline true` cuts every container off from the internet, as real grading does.
It needs one online run first: forge downloads the Solidity compiler on first use, into `.grader/svm`, and an offline run cannot.
`--report <dir>` writes a transcript of everything a run sent and received, the same report you get back after grading.

The harness is the one the lecture team grades with: it starts a chain, seven
validators, a client and a prover, wires them together and tears them down.
The graded scenario list stays with the lecture team. `grader/src/scenarios/index.ts`
ships two public scenarios to start from, and you add your own next to them.
Each task description gives examples of what will be graded. They are examples,
not the list, and the real matrix is larger, so a solution that passes exactly
the named ones has tested the shape rather than the space.

Scenarios with byzantine committee members need the lecture team's byzantine validators, which ship as a prebuilt docker image:

```bash
docker load -i atbt-byzantine.tar      # once; the file comes with the course materials
```

That provides the image `atbt-byzantine:course`, which the grader uses for every byzantine seat, on both tracks, without being told.
Loading a newer `atbt-byzantine.tar` replaces it. If it is missing, scenarios with only honest seats still run, and each scenario with a byzantine seat stops with an error saying how to load it.

`packages/malicious` holds their names and descriptions; writing your own variants there is optional, and `pnpm grade -- --byzantine ts` runs the byzantine seats from it instead of the image.
A prover you have never shown fraud is a prover you have not tested.

## Tests

`forge test` and `pnpm test` are the public pass bar and they are not the whole grade.
On the Rust track, `cargo test` in `rust/` runs the same conformance vectors against `rust/common`.
Grading runs automated integration and end-to-end tests against your running processes and your deployed contracts, and never imports your code: the processes are graded over the wire, and from Task 2 on the Gateway is deployed with its frozen constructor and driven only through `IGateway`.
