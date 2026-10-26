/**
 * The local chain: anvil, deployment, staking, epochs.
 *
 * Everything here is the grader's own, not the student's, with one exception
 * that matters: the contracts are deployed by the command in the manifest. A
 * student's Gateway is the thing under test in Task 3, so the grader must run
 * their deployment rather than its own.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { trace } from "./trace.js";
import { createPublicClient, createWalletClient, getAddress, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EPOCH_BLOCKS, L1, epochOf, registryAbi } from "@atbt/common";
import { start, until, type Started } from "./proc.js";
import * as dk from "./docker.js";
import type { Manifest } from "./manifest.js";

/** Anvil's default mnemonic accounts, so nothing has to be funded. */
export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

export const L1_CHAIN_ID = 31337;
export const DEPLOYER_KEY = ANVIL_KEYS[0];

export interface Chain {
  /** Loopback, for the grader. `internalRpcUrl` is what a container config
   *  must say instead. */
  rpcUrl: string;
  internalRpcUrl: string;
  anvil: Started;
  token: Address;
  registry: Address;
  escrow: Address;
  gateway: Address;
  l1(key: Hex): L1;
  mine(blocks: number): Promise<void>;
  blockNumber(): Promise<bigint>;
  epoch(): Promise<bigint>;
  /** Blocks a batch stays challengeable, as deployed. */
  challengeWindow(): Promise<bigint>;
  /** Mine into the next epoch. Its committee needs nothing done to exist. */
  advanceEpoch(): Promise<bigint>;
  stop(): Promise<void>;
}

/** The image anvil, cast and forge come from. Pinned by tag rather than by
 *  digest deliberately: this is a teaching repo, and a digest here would need
 *  updating before anyone could run the grader at all. */
export const FOUNDRY_IMAGE = "ghcr.io/foundry-rs/foundry:latest";

export async function startChain(
  network: string,
  prefix: string,
  port: number,
  verbose = false,
): Promise<Started> {
  return start({
    name: "anvil",
    container: `${prefix}-anvil`,
    network,
    image: FOUNDRY_IMAGE,
    // The image's entrypoint is `forge`, so anvil has to be named. Binding
    // 0.0.0.0 is required for the other containers to reach it and is safe:
    // only the published port is reachable, and that is on loopback.
    //
    // Deterministic and quiet. A block time would make every wait a race, so
    // blocks are mined on demand and by transactions only.
    entrypoint: "anvil",
    argv: ["--host", "0.0.0.0", "--port", "8545", "--chain-id", String(L1_CHAIN_ID), "--silent"],
    hostPort: port,
    containerPort: 8545,
    readyMethod: "eth_chainId",
    verbose,
  });
}

/** Deploy through the manifest's command and read back the four addresses. */
/**
 * Deploy through the manifest's command, in a container.
 *
 * The foundry image rather than the solution's own: the contracts are the
 * student's, bind-mounted from their repo, but `forge` is a build tool and
 * requiring every submitted image to carry one would be a tax on the wrong
 * thing.
 *
 * It runs as the HOST user, not root. forge writes `broadcast/`, `cache/` and
 * `out/` into the mount, and running as root left twenty-four root-owned files
 * in the repo that took sudo to delete. HOME is redirected for the same reason:
 * the host uid has no home inside the image.
 */
/** Where forge keeps the compilers it has downloaded, shared by every deploy.
 *  Inside the grader's own working directory, which is the repository. */
export function compilerCache(): string {
  const dir = join(process.cwd(), ".grader", "svm");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The deploy in progress, if any. See `deploy`. */
let deploying: Promise<unknown> = Promise.resolve();

export async function deploy(
  m: Manifest & { rootDir: string },
  network: string,
  prefix: string,
  l2Id: number,
  challengeWindow = 0,
): Promise<{ token: Address; registry: Address; escrow: Address; gateway: Address }> {
  // One deploy at a time, even under --jobs. Every deploy runs in the same
  // bind-mounted repo, and forge writes `out/`, `cache/` and `broadcast/`
  // there, so two at once can tear each other's build artifacts. Each scenario
  // has its own anvil, so only the build directory is shared, and a deploy is
  // a few seconds once the contracts are compiled.
  const mine = deploying.then(() => deployNow(m, network, prefix, l2Id, challengeWindow));
  deploying = mine.catch(() => undefined);
  return mine;
}

async function deployNow(
  m: Manifest & { rootDir: string },
  network: string,
  prefix: string,
  l2Id: number,
  challengeWindow: number,
): Promise<{ token: Address; registry: Address; escrow: Address; gateway: Address }> {
  const { code, out } = await dk.runToCompletion({
    name: `${prefix}-deploy`,
    network,
    image: FOUNDRY_IMAGE,
    entrypoint: "bash",
    // Not a login shell, and not pre-quoted: the argv is quoted where every
    // other docker argument is. Doing it twice made bash treat the whole
    // command as one filename and exit 127.
    argv: ["-c", m.deploy.command],
    publish: [],
    mounts: [
      { from: m.rootDir, to: "/repo", ro: false },
      // forge downloads the Solidity compiler into ~/.svm on first use, and an
      // offline run cannot. One cache for every deploy, filled by the first
      // online one, so offline deploys find the compiler already there.
      { from: compilerCache(), to: "/tmp/.svm", ro: false },
    ],
    workdir: "/repo",
    // Rootless inverts this: there the host uid already maps to container 0,
    // and passing an explicit uid gives forge a subuid that cannot write the
    // mount at all.
    user: (await dk.isRootless()) ? undefined : `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    env: {
      HOME: "/tmp",
      // Inside the network, so the container name and not a host port.
      L1_RPC: `http://anvil:8545`,
      L1_CHAIN_ID: String(L1_CHAIN_ID),
      DEPLOYER_KEY,
      PRIVATE_KEY: DEPLOYER_KEY,
      // L2_ID is not cosmetic. The Gateway derives its L2 chain id from it and
      // rejects any order signed for a different one, so a default here means
      // every proof that decodes an order reverts while posting and withdrawing
      // carry on working. That is a very quiet way to break half the system.
      L2_ID: String(l2Id),
      CHALLENGE_WINDOW: String(challengeWindow),
      ...(m.deploy.env ?? {}),
    },
  });

  const pick = (key: string): Address => {
    const match = out.match(new RegExp(`ATBT_${key}\\s*=?\\s*(0x[0-9a-fA-F]{40})`));
    if (!match) {
      throw new Error(
        `deployment did not print ATBT_${key}=0x...\n` +
          `  command: ${m.deploy.command}\n  exit: ${code}\n` +
          out.split("\n").slice(-30).map((l) => `    ${l}`).join("\n"),
      );
    }
    return getAddress(match[1] as Address);
  };

  return { token: pick("TOKEN"), registry: pick("REGISTRY"), escrow: pick("ESCROW"), gateway: pick("GATEWAY") };
}

export async function makeChain(
  m: Manifest & { rootDir: string },
  network: string,
  prefix: string,
  port: number,
  l2Id: number,
  challengeWindow = 0,
  verbose = false,
): Promise<Chain> {
  const anvil = await startChain(network, prefix, port, verbose);
  // The grader talks to anvil over the published loopback port; the containers
  // talk to it by name inside the network. Both are the same chain.
  const rpcUrl = anvil.url;
  const addrs = await deploy(m, network, prefix, l2Id, challengeWindow);

  // cacheTime 0 is load-bearing. viem caches getBlockNumber for the polling
  // interval by default, so mining a thousand blocks and reading the height
  // back immediately returns the old height and every epoch test silently
  // asserts against a chain that never moved.
  const pub = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const mine = async (blocks: number) => {
    trace("chain", `mine ${blocks} blocks`);
    await pub.request({
      method: "anvil_mine" as never,
      params: [`0x${blocks.toString(16)}`] as never,
    });
  };

  const chain: Chain = {
    rpcUrl,
    internalRpcUrl: anvil.internalUrl,
    anvil,
    ...addrs,
    l1: (key: Hex) =>
      new L1({
        rpcUrl,
        gateway: addrs.gateway,
        registry: addrs.registry,
        chainId: L1_CHAIN_ID,
        privateKey: key,
      }),
    mine,
    blockNumber: () => pub.getBlockNumber(),
    epoch: async () => epochOf(await pub.getBlockNumber()),
    challengeWindow: () => chain.l1(DEPLOYER_KEY).gateway<bigint>("challengeWindow"),
    async advanceEpoch() {
      const here = epochOf(await pub.getBlockNumber());
      const target = (here + 1n) * EPOCH_BLOCKS;
      const now = await pub.getBlockNumber();
      // Nothing to send: the new epoch's committee is the stakes as they
      // stood at its boundary, and the Registry answers for it already.
      await mine(Number(target - now) + 1);
      return epochOf(await pub.getBlockNumber());
    },
    async stop() {
      await anvil.stop();
    },
  };
  return chain;
}

/**
/**
 * Wait for the validators to bond themselves, then move to the next epoch,
 * which is the first one they sit on.
 *
 * The grader used to call `register()` on every validator's behalf, with each
 * validator's own key, before any validator process existed. That made the
 * whole bonding path dead code: a student whose validator never bonds still
 * passed, because the grader had already staked for them.
 *
 * Funding is the one thing a validator genuinely cannot do for itself, so that
 * stays here. Bonding moved into the validator, which means the order matters
 * now: fund, start, let them bond, and then cross a boundary, because a bond
 * takes effect from the epoch after the one it was made in.
 *
 * Stakes still descend by index, because the validators are handed descending
 * amounts in their configs, so the committee order stays predictable and a
 * scenario can say "the third-largest staker leaves" and mean something.
 */
export async function committeeOnceBonded(
  chain: Chain,
  expected: Address[],
  timeoutMs = 30000,
): Promise<Address[]> {
  const pub = createPublicClient({ transport: http(chain.rpcUrl), cacheTime: 0 });

  await until(
    `all ${expected.length} validators to bond themselves`,
    async () => {
      for (const who of expected) {
        const v = (await pub.readContract({
          address: chain.registry,
          abi: registryAbi,
          functionName: "validators",
          args: [who],
        })) as [bigint, bigint, boolean, boolean];
        if (!v[2]) return null;
      }
      return true;
    },
    timeoutMs,
  );

  await chain.advanceEpoch();
  const committee = (await pub.readContract({
    address: chain.registry,
    abi: registryAbi,
    functionName: "committeeOf",
    args: [await chain.epoch()],
  })) as Address[];

  if (committee.length === 0) {
    throw new Error("the validators bonded, but the next epoch's committee is empty, so nothing can be posted");
  }
  return committee.map((a) => getAddress(a));
}


