/**
 * A running system, assembled per scenario.
 *
 * One rule governs everything here. Honest validators, the client and the
 * prover are started from the STUDENT's manifest. Byzantine validators are
 * started from the lecture team's own fleet.
 *
 * That split is not an implementation convenience. Asking students to implement
 * their own attackers would mean grading each solution against a different
 * attack, and a student who writes a weak attacker would score better than one
 * who writes a strong one. The attack has to be identical for everyone, so it
 * has to be ours.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createPublicClient, createWalletClient, encodeAbiParameters, formatEther, getAddress, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  GAS_PER_TX,
  WITHDRAW_PRECOMPILE,
  chainIdForL2,
  courseTokenAbi,
  decodeCertData,
  decodeOrder,
  gatewayAbi,
  type PostedBatch,
  rpcCall,
  type Certificate,
} from "@atbt/common";
// Relative, since a workspace link would need an install this repo cannot run.
import type { Variant } from "../../packages/malicious/src/index.js";
import { ANVIL_KEYS, DEPLOYER_KEY, L1_CHAIN_ID, makeChain, committeeOnceBonded, type Chain } from "./chain.js";
import { start, until, type Started } from "./proc.js";
import {
  GraderError,
  buildImage,
  createNetwork,
  imageExists,
  loopbackUrl,
  removeNetwork,
  requireDocker,
} from "./docker.js";
import { shown, trace } from "./trace.js";
import type { ImageSpec, Manifest } from "./manifest.js";

export const L2_ID = 7;
export const CHAIN_ID = chainIdForL2(L2_ID);
export const GAS_PRICE = 1_000_000_000n;
export const FEE = GAS_PRICE * GAS_PER_TX;

/** Validator identities. Distinct from the anvil keys that hold L1 funds, so a
 *  slash never accidentally drains a scenario's payer. */
export const VALIDATOR_KEYS: Hex[] = Array.from(
  { length: 7 },
  (_, i) => ("0x" + (0x81 + i).toString(16).padStart(64, "0")) as Hex,
);

/**
 * The genesis account, and the users.
 *
 * ALICE is the genesis account from the Task 1 hand-out (task1.pdf), and its key is
 * published there. Task 1's contract is a fixed supply of 1,000,000 CRS held by
 * exactly this address, so the grader has to fund exactly this address and
 * nothing else, or `cast balance` on a student's validator would not match what
 * the task told them to produce.
 *
 * Everybody else starts at zero and is funded by a transfer, which is also the
 * honest shape: there is no way to create value on L2.
 */
export const GENESIS_KEY: Hex = "0x6e5e515000000000000000000000000000000000000000000000000000000000";
export const USER_KEYS: Hex[] = [
  GENESIS_KEY,
  ...Array.from({ length: 4 }, (_, i) => ("0x" + (i + 1).toString(16).padStart(64, "0")) as Hex),
];
export const USERS: PrivateKeyAccount[] = USER_KEYS.map((k) => privateKeyToAccount(k));
export const [ALICE, BOB, CAROL, DAVE, EVE] = USERS;

/** 1 CRS, in base units. The chain's native unit relates to CRS exactly as wei
 *  relates to ETH. */
export const CRS = 10n ** 18n;
/** Task 1's fixed supply, all of it held by ALICE at genesis. */
export const GENESIS_SUPPLY = 1_000_000n * CRS;
/** Seat 0 bonds this much, each seat below it one CRS less, so committee order
 *  is predictable and the last seat is the one a newcomer takes. */
export const STAKE_BASE = 10n * CRS;

/**
 * Write a config file and return its path.
 *
 * One directory per scenario, which is also what a container bind-mounts, so
 * the same layout serves both ways of running.
 */
/**
 * Ports INSIDE a container, which are fixed.
 *
 * Every process listens on the same port in its own network namespace, and the
 * per-scenario host ports exist only so the grader can reach them from outside.
 * Nothing in a config file ever mentions a host port.
 */
const VALIDATOR_PORT = 9600;
const VAPI_PORT = 9700;
const CLIENT_PORT = 9545;
const PROVER_PORT = 9900;

/**
 * Build a solution's image once per grader run, not once per scenario.
 *
 * Eighteen scenarios means eighteen builds otherwise. Docker would serve them
 * from cache, but the memoised promise also serialises the first one, so two
 * scenarios starting together do not build the same tag twice.
 */
const images = new Map<string, Promise<string>>();

/**
 * The lecture team's own image, for the byzantine validators.
 *
 * The tag is deliberately not derivable from a manifest name. Keying the memo
 * on the name alone meant a manifest called "reference" collapsed both entries
 * onto one image, and the byzantine validators were then started from the
 * SOLUTION's `packages/malicious`. A submission shipping an honest one would
 * pass every equivocation scenario. "Byzantine nodes are ours, always" has to
 * be true of the code and not only of the comment.
 */
const REFERENCE_TAG = "atbt-grade-builtin-reference";

/**
 * Where the byzantine validators come from.
 *
 *   a tag    an image already loaded into docker: the prebuilt byzantine image
 *            the course hands out, loaded once with `docker load`.
 *   "ts"     the TypeScript variants in packages/malicious, in an image built
 *            from this tree's docker/Dockerfile: byzantine nodes you wrote.
 *   "build"  built from rust/byzantine, which only the lecture team has: the
 *            source does not ship, and asking for it without the source
 *            fails with a message saying so.
 *
 * Chosen by --byzantine on the command line or ATBT_BYZANTINE, falling back to
 * BYZANTINE_DEFAULT. Resolved only when a scenario actually has a byzantine
 * seat, so an all-honest scenario runs without the image loaded.
 */
const BYZANTINE_DEFAULT = "atbt-byzantine:course";
const BYZANTINE_BUILT_TAG = "atbt-grade-builtin-byzantine";
let byzantineSource = process.env.ATBT_BYZANTINE || BYZANTINE_DEFAULT;

export function setByzantineSource(source: string): void {
  byzantineSource = source;
}

/** The image and argv a byzantine seat starts from. */
async function byzantineImage(): Promise<{ image: string; argv: string[] }> {
  if (byzantineSource === "ts") {
    return {
      image: await imageFor(REFERENCE_TAG, process.cwd()),
      // node and tsx directly rather than through npx, which spends most of a
      // second per container resolving a binary it already has.
      argv: ["node", "node_modules/tsx/dist/cli.mjs", "packages/malicious/src/index.ts"],
    };
  }
  if (byzantineSource === "build") {
    if (!existsSync(join(process.cwd(), "rust/byzantine/Dockerfile"))) {
      throw new GraderError(
        "--byzantine build builds the byzantine validators from their source in rust/byzantine, " +
          "which does not ship. Load the prebuilt image with `docker load -i atbt-byzantine.tar`, " +
          "or run your own variants with --byzantine ts.",
      );
    }
    return {
      image: await imageFor(BYZANTINE_BUILT_TAG, process.cwd(), { dockerfile: "rust/byzantine/Dockerfile" }),
      argv: ["atbt-byzantine"],
    };
  }
  let p = images.get(byzantineSource);
  if (!p) {
    p = (async () => {
      if (!(await imageExists(byzantineSource))) {
        throw new GraderError(
          `the byzantine validators' image ${byzantineSource} is not loaded. ` +
            `Load it once with: docker load -i atbt-byzantine.tar`,
        );
      }
      return byzantineSource;
    })();
    images.set(byzantineSource, p);
  }
  return { image: await p, argv: ["atbt-byzantine"] };
}

function imageFor(key: string, rootDir: string, spec?: ImageSpec): Promise<string> {
  let p = images.get(key);
  if (!p) {
    p = buildImage(spec ?? { dockerfile: "docker/Dockerfile" }, rootDir, key);
    images.set(key, p);
  }
  return p;
}

function solutionTag(name: string): string {
  const slug = name.replace(/[^a-z0-9_.-]/gi, "-").toLowerCase();
  // Cannot be REFERENCE_TAG: that has a "builtin-" segment a manifest name
  // could produce, so the guard is a prefix no sanitised name reaches.
  return `atbt-grade-solution-${slug}`;
}

function writeConfig(dir: string, cfg: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${cfg.name as string}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return path;
}

/** Who answers at each URL, for the transcript. Keyed by URL, which embeds a
 *  per-scenario port, so scenarios running side by side never collide. */
const LABELS = new Map<string, string>();

/**
 * Every request the grader makes to a submission, recorded both ways.
 *
 * The transcript is the student's feedback, so what was sent and what came
 * back is the most useful thing in it: "the client refused with
 * CONFLICTING_PENDING" points straight at the bug.
 */
export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const who = LABELS.get(url) ?? url;
  trace("send", `${who} ${method} ${shown(params)}`);
  const started = performance.now();
  try {
    const r = await rpcCall<T>(url, method, params);
    trace("recv", `${who} ${method} (${Math.round(performance.now() - started)}ms) ${shown(r)}`);
    return r;
  } catch (e) {
    const data = e && typeof e === "object" && "data" in e ? ` ${shown((e as { data?: unknown }).data)}` : "";
    trace("error", `${who} ${method} (${Math.round(performance.now() - started)}ms) ${e instanceof Error ? e.message : String(e)}${data}`);
    throw e;
  }
}

/** The name prefix of everything one scenario starts, and the name of its
 *  network. Teardown under `--jobs` depends on the two being the same. */
export function scenarioPrefix(basePort: number): string {
  return `atbt-s${basePort}`;
}

export interface Node {
  index: number;
  name: string;
  variant: Variant;
  address: Address;
  key: Hex;
  /** fastpay_, as the GRADER reaches it: a published loopback port. */
  url: string;
  /** fastpay_, as the client and prover reach it: the alias inside the
   *  scenario network. A peers list built from `url` would point every
   *  container at itself. */
  internalUrl: string;
  /** vapi_, published on loopback only. Not reachable from off the machine,
   *  which is the property that matters: the grader is part of the deployment
   *  and everything else is not. */
  vapiUrl: string;
  proc: Started;
}

export interface WorldOptions {
  manifest: Manifest & { rootDir: string };
  mode: "standalone" | "anchored";
  /** Variant per committee seat. Length must be 7. */
  variants: Variant[];
  /** Base port. Every scenario gets its own block of 40. */
  basePort: number;
  /** Standalone only: starting balances. */
  genesis?: { address: Address; balance: bigint }[];
  withProver?: boolean;
  /** L1 blocks a batch stays challengeable. Zero means Task 2 semantics: the
   *  committee is trusted and there are no fraud proofs at all, so any task
   *  that submits a proof needs a real window. */
  challengeWindow?: number;
  verbose?: boolean;
}

export interface World {
  chain: Chain | null;
  nodes: Node[];
  client: Started;
  prover: Started | null;
  committee: Address[];
  honest(): Node[];
  byzantine(): Node[];
  /** Sign a legacy transfer. This IS the transfer order. */
  order(from: PrivateKeyAccount, sequence: bigint, to: Address, amount: bigint): Promise<Hex>;
  /** A withdrawal order: an ordinary transaction to the withdraw precompile,
   *  carrying the L1 recipient in its calldata. */
  withdrawalOrder(from: PrivateKeyAccount, sequence: bigint, to: Address, amount: bigint): Promise<Hex>;
  /** Send through the client, the way cast would. */
  send(raw: Hex): Promise<Hex>;
  /** Ask one validator directly, bypassing the client. Needed whenever a
   *  scenario has to do something no honest client would do. */
  /** The typed refusal reason matters: a client that has to parse English to
   *  know whether to retry will get it wrong, so scenarios assert on it. */
  ask(
    node: Node,
    raw: Hex,
    epoch?: bigint,
  ): Promise<{ signature: Hex } | { refusal: string; reason: string | null }>;
  /** Deliver a certificate to the whole committee, the way a client would. */
  certify(raw: Hex, signatures: Hex[], epoch: bigint): Promise<number>;
  balanceOf(who: Address): Promise<bigint>;
  sequenceOf(who: Address): Promise<bigint>;
  vapi<T>(node: Node, method: string, params?: unknown[]): Promise<T>;
  account(node: Node, who: Address): Promise<{ balance: bigint; nextSequence: bigint }>;
  /** Drive one validator's posting. Every scenario that cares about who posts
   *  uses this rather than waiting for a timer. */
  post(node: Node): Promise<void>;
  syncAll(): Promise<void>;
  postAll(): Promise<void>;
  /** Hand the prover a vote, the way a client that gathered it would. */
  tellProver(epoch: bigint, raw: Hex, signature: Hex): Promise<void>;
  proverScan(): Promise<{ kind: string; subject: Address; txHash?: string; error?: string }[]>;
  /** Scan repeatedly until nothing new turns up. */
  proverDrain(maxPasses?: number): Promise<{ kind: string; subject: Address; txHash?: string; error?: string }[]>;
  proverDetections(): Promise<{ kind: string; subject: Address; txHash?: string }[]>;
  fund(who: Address, amount: bigint): Promise<void>;
  slashed(who: Address): Promise<boolean>;
  stateRoot(): Promise<Hex>;
  /** Every live batch, as posted. */
  batches(): Promise<PostedBatch[]>;
  /** Claim a withdrawal on L1. The recipient and amount come from the order, so
   *  they are not parameters. */
  claimWithdrawal(sender: Address, sequence: bigint): Promise<void>;
  stop(): Promise<void>;
  /** A process's container output, for a scenario that needs to explain a
   *  failure rather than only report it. */
  logsOf(name: string): Promise<string[]>;
  /** The output of every process the submission supplied, for a failure
   *  report. The byzantine validators are the lecture team's, so not these. */
  ownLogs(): Promise<{ name: string; lines: string[] }[]>;
}

export async function makeWorld(opts: WorldOptions): Promise<World> {
  const { manifest: m, mode, variants, basePort } = opts;
  if (variants.length !== 7) throw new Error(`need 7 variants, got ${variants.length}`);
  await requireDocker();

  // One network and one name prefix per scenario, so a container left over
  // from an earlier scenario cannot be reached by name and cannot answer a
  // readiness probe in place of the solution under test.
  const network = scenarioPrefix(basePort);
  const prefix = scenarioPrefix(basePort);
  await createNetwork(network, basePort);

  // One config directory per scenario, bind-mounted at /config in every
  // container. This is the whole of config injection: no templating, no
  // environment, one file per process.
  const configDir = join(process.cwd(), ".grader", `s${basePort}`);
  mkdirSync(configDir, { recursive: true });

  // The solution's image for the honest nodes, the client and the prover. Ours
  // for the byzantine ones, always: a student's committee has to be attacked by
  // the lecture team's validators and not by their own.
  // The byzantine image only if a seat needs it: an all-honest scenario must
  // run without it loaded.
  const [solutionImage, byzantine] = await Promise.all([
    imageFor(solutionTag(m.name), m.rootDir, m.image),
    variants.some((v) => v !== "honest") ? byzantineImage() : Promise.resolve(null),
  ]);

  const chain =
    mode === "anchored"
      ? await makeChain(m, network, prefix, basePort, L2_ID, opts.challengeWindow ?? 0, opts.verbose)
      : null;
  const identities = VALIDATOR_KEYS.map((k) => privateKeyToAccount(k).address);
  let committee: Address[] = identities;

  if (chain) {
    // Gas only. Bonding is the validator's own transaction, so the committee is
    // not known until they have all bonded and the next epoch has begun, which
    // happens after they start.
    await fundNative(chain, VALIDATOR_KEYS, parseEther("100"));
  }

  const genesis = opts.genesis ?? [];

  const nodes: Node[] = [];
  for (let i = 0; i < 7; i++) {
    const variant = variants[i];
    const key = VALIDATOR_KEYS[i];
    const port = basePort + 10 + i;
    const vapiPort = basePort + 20 + i;
    const address = privateKeyToAccount(key).address;

    // Honest nodes are the student's. Byzantine nodes are ours, always.
    const spec =
      variant === "honest"
        ? {
            argv: m.validator.command.trim().split(/\s+/),
            image: solutionImage,
            env: { ...(m.validator.env ?? {}) } as Record<string, string>,
          }
        : {
            argv: byzantine!.argv,
            image: byzantine!.image,
            env: { VARIANT: variant } as Record<string, string>,
          };

    const configPath = writeConfig(configDir, {
      name: `v${i}`,
      role: "validator",
      mode,
      identity: { privateKey: key },
      // Fixed inside the container, published on a per-scenario host port.
      // vapiHost is 0.0.0.0 because the operator interface must be reachable
      // from the grader, which is inside the deployment; it is never published
      // anywhere but loopback.
      listen: { port: VALIDATOR_PORT, vapiPort: VAPI_PORT, vapiHost: "0.0.0.0" },
      l2: { chainId: CHAIN_ID },
      // Standalone only. An anchored validator reads its committee from L1,
      // which is the whole point of staking for it.
      ...(chain ? {} : { committee }),
      genesis: genesis.map((g) => ({ address: g.address, balance: String(g.balance) })),
      ...(chain
        ? {
            l1: {
              // The internal URL. A config that says 127.0.0.1 points the
              // container at itself, and the only symptom is that nothing ever
              // bonds.
              rpcUrl: chain.internalRpcUrl,
              chainId: L1_CHAIN_ID,
              gateway: chain.gateway,
              registry: chain.registry,
            },
            // Each validator bonds its own stake at startup. The grader funds
            // the address, which is the one thing a validator cannot do for
            // itself, and nothing else.
            stake: String(STAKE_BASE - BigInt(i) * CRS),
          }
        : {}),
      // Driven through vapi_ rather than by timers, so no scenario depends on
      // which timer fired first.
      intervals: { syncMs: 3600000, postMs: 3600000 },
    });

    const proc = await start({
      name: `v${i}`,
      container: `${prefix}-v${i}`,
      network,
      image: spec.image,
      // argv[0] becomes the entrypoint, because the image's own entrypoint is
      // the compose shim that renders a config from environment. Here the
      // config already exists and is mounted, so the command runs directly.
      entrypoint: spec.argv[0],
      argv: [...spec.argv.slice(1), `/config/${basename(configPath)}`],
      mounts: [{ from: configDir, to: "/config" }],
      hostPort: vapiPort,
      containerPort: VAPI_PORT,
      extraPorts: [{ host: port, container: VALIDATOR_PORT }],
      // Probed on vapi_, addressed by the client and the prover on fastpay_.
      protocolPort: VALIDATOR_PORT,
      readyMethod: "vapi_info",
      timeoutMs: m.readyTimeoutMs ?? 45000,
      verbose: opts.verbose,
      // The only environment anything still takes: which byzantine variant to
      // be. That is lecture-team-only and deliberately not part of the config
      // schema students implement.
      env: { ...(spec.env ?? {}) },
    });

    // A byzantine seat is labelled as such, because a student reading the
    // transcript needs to know which answers came from the lecture team's
    // misbehaving nodes rather than from their own code.
    const label = variant === "honest" ? `v${i}` : `v${i}(${variant})`;
    const url = loopbackUrl(network, `${prefix}-v${i}`, VALIDATOR_PORT, port);
    const vapiUrl = loopbackUrl(network, `${prefix}-v${i}`, VAPI_PORT, vapiPort);
    LABELS.set(url, label);
    LABELS.set(vapiUrl, `${label}.vapi`);
    trace("proc", `started ${label}: ${variant === "honest" ? "your validator" : "a byzantine validator"} ${address}`);
    nodes.push({
      index: i,
      name: `v${i}`,
      variant,
      address,
      key,
      url,
      internalUrl: `http://v${i}:${VALIDATOR_PORT}`,
      vapiUrl,
      proc,
    });
  }

  // They have bonded themselves by now, so crossing into the next epoch seats
  // them, and the committee can be read back. Then everyone syncs to adopt it.
  if (chain) {
    committee = await committeeOnceBonded(chain, identities);
    for (const n of nodes) {
      await rpc(n.vapiUrl, "vapi_syncNow", []).catch(() => null);
    }
  }
  const proverPort = basePort + 31;

  const prover =
    opts.withProver && m.prover && chain
      ? await start({
          name: "prover",
          container: `${prefix}-prover`,
          network,
          image: solutionImage,
          entrypoint: m.prover.command.trim().split(/\s+/)[0],
          env: { ...(m.prover.env ?? {}) },
          argv: [
            ...m.prover.command.trim().split(/\s+/).slice(1),
            `/config/${basename(
              writeConfig(configDir, {
                name: "prover",
                role: "prover",
                mode: "anchored",
                identity: { privateKey: ANVIL_KEYS[9] },
                listen: { port: PROVER_PORT },
                peers: nodes.map((n) => n.internalUrl),
                l2: { chainId: CHAIN_ID },
                l1: {
                  rpcUrl: chain.internalRpcUrl,
                  chainId: L1_CHAIN_ID,
                  gateway: chain.gateway,
                  registry: chain.registry,
                },
                intervals: { scanMs: 3600000 },
              }),
            )}`,
          ],
          mounts: [{ from: configDir, to: "/config" }],
          hostPort: proverPort,
          containerPort: PROVER_PORT,
          readyMethod: "prover_status",
          timeoutMs: m.readyTimeoutMs ?? 45000,
          verbose: opts.verbose,
        })
      : null;

  const clientPort = basePort + 30;
  const client = await start({
    name: "client",
    container: `${prefix}-client`,
    network,
    image: solutionImage,
    entrypoint: m.client.command.trim().split(/\s+/)[0],
    env: { ...(m.client.env ?? {}) },
    argv: [
      ...m.client.command.trim().split(/\s+/).slice(1),
      `/config/${basename(
        writeConfig(configDir, {
          name: "client",
          role: "client",
          mode,
          // No identity. A client signs nothing: orders arrive already signed.
          listen: { port: CLIENT_PORT },
          peers: nodes.map((n) => n.internalUrl),
          l2: { chainId: CHAIN_ID },
          minGasPrice: String(GAS_PRICE),
          ...(chain
            ? {
                l1: {
                  rpcUrl: chain.internalRpcUrl,
                  chainId: L1_CHAIN_ID,
                  gateway: chain.gateway,
                  registry: chain.registry,
                },
              }
            : {}),
          ...(prover ? { proverUrl: prover.internalUrl } : {}),
        }),
      )}`,
    ],
    mounts: [{ from: configDir, to: "/config" }],
    hostPort: clientPort,
    containerPort: CLIENT_PORT,
    readyMethod: "eth_chainId",
    timeoutMs: m.readyTimeoutMs ?? 45000,
    verbose: opts.verbose,
  });

  const all = [...nodes.map((n) => n.proc), client, ...(prover ? [prover] : [])];

  LABELS.set(client.url, "client");
  trace("proc", "started your client");
  if (prover) {
    LABELS.set(prover.url, "prover");
    trace("proc", "started your prover");
  }

  const w: World = {
    chain,
    nodes,
    client,
    prover,
    committee,
    honest: () => nodes.filter((n) => n.variant === "honest"),
    byzantine: () => nodes.filter((n) => n.variant !== "honest"),

    async order(from, sequence, to, amount) {
      return (await from.signTransaction({
        type: "legacy",
        chainId: CHAIN_ID,
        nonce: Number(sequence),
        gasPrice: GAS_PRICE,
        gas: GAS_PER_TX,
        to,
        value: amount,
      })) as Hex;
    },

    async withdrawalOrder(from, sequence, to, amount) {
      return (await from.signTransaction({
        type: "legacy",
        chainId: CHAIN_ID,
        nonce: Number(sequence),
        gasPrice: GAS_PRICE,
        gas: GAS_PER_TX,
        to: WITHDRAW_PRECOMPILE,
        value: amount,
        data: encodeAbiParameters([{ type: "address" }], [to]) as Hex,
      })) as Hex;
    },

    send: (raw) => rpc<Hex>(client.url, "eth_sendRawTransaction", [raw]),

    async certify(raw, signatures, epoch) {
      const acks = await Promise.allSettled(
        nodes.map((n) =>
          rpc(n.url, "fastpay_handleCertificate", [{ epoch, order: raw, signatures }]),
        ),
      );
      return acks.filter((a) => a.status === "fulfilled").length;
    },

    async ask(node, raw, epoch) {
      try {
        return await rpc<{ signature: Hex }>(node.url, "fastpay_handleOrder", [
          raw,
          ...(epoch === undefined ? [] : [epoch]),
        ]);
      } catch (e) {
        const data = (e as { data?: { reason?: string } }).data;
        return {
          refusal: e instanceof Error ? e.message : String(e),
          reason: data?.reason ?? null,
        };
      }
    },

    async balanceOf(who) {
      return BigInt(await rpc<Hex>(client.url, "eth_getBalance", [who, "latest"]));
    },
    async sequenceOf(who) {
      return BigInt(await rpc<Hex>(client.url, "eth_getTransactionCount", [who, "latest"]));
    },

    vapi: <T,>(node: Node, method: string, params: unknown[] = []) =>
      rpc<T>(node.vapiUrl, method, params),

    async account(node, who) {
      const a = await rpc<{ balance: string; nextSequence: string }>(
        node.vapiUrl,
        "vapi_account",
        [who],
      );
      // A standalone balance may be negative, and the wire writes that as
      // "0x-5", which BigInt() refuses: read the sign first.
      const wireInt = (v: string): bigint =>
        v.startsWith("0x-") ? -BigInt("0x" + v.slice(3)) : BigInt(v);
      return {
        balance: wireInt(a.balance),
        nextSequence: wireInt(a.nextSequence),
      };
    },

    async post(node) {
      await rpc(node.vapiUrl, "vapi_postNow", []);
      await w.syncAll();
    },

    /**
     * Sync every validator, one at a time, and report what fails.
     *
     * Sequential because seven validators replaying the whole chain at once
     * against one anvil is a load spike, not a test. Errors are reported rather
     * than swallowed: a swallowed sync failure shows up later as a validator
     * mysteriously stuck on the wrong epoch, which is a much harder thing to
     * read than the error itself.
     */
    async syncAll() {
      const failures: string[] = [];
      for (const n of nodes) {
        try {
          await rpc(n.vapiUrl, "vapi_syncNow", []);
        } catch (e) {
          failures.push(`${n.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`validators failed to sync from L1\n      ${failures.join("\n      ")}`);
      }
    },
    async postAll() {
      // Sequentially, because two validators posting the same certificates in
      // the same block is a race the grader should not be creating.
      for (const n of nodes) {
        await rpc(n.vapiUrl, "vapi_postNow", []).catch(() => null);
      }
      await w.syncAll();
    },

    /**
     * Scan until the prover stops finding new things.
     *
     * One pass is not enough by design: a prover that submits a proof changes
     * the chain, and the next defect may only be visible afterwards. Draining
     * also means a scenario never depends on how many defects a prover happens
     * to report per call.
     */
    async tellProver(epoch, raw, signature) {
      if (!prover) return;
      await rpc(prover.url, "prover_observeVote", [epoch, raw, signature]).catch(() => null);
    },

    async proverDrain(maxPasses = 6) {
      const found: { kind: string; subject: Address; txHash?: string; error?: string }[] = [];
      for (let i = 0; i < maxPasses; i++) {
        const batch = await w.proverScan();
        if (batch.length === 0) break;
        found.push(...batch);
      }
      return found;
    },

    async proverScan() {
      if (!prover) return [];
      const r = await rpc<{ found: { kind: string; subject: Address; txHash?: string; error?: string }[] }>(
        prover.url,
        "prover_scanNow",
        [],
      );
      return r.found;
    },
    async proverDetections() {
      if (!prover) return [];
      const r = await rpc<{ detections: { kind: string; subject: Address; txHash?: string }[] }>(
        prover.url,
        "prover_status",
        [],
      );
      return r.detections;
    },

    async fund(who, amount) {
      if (!chain) throw new Error("no chain in standalone mode");
      trace("chain", `deposit ${amount} base units for ${who} into the escrow`);
      await fundL2(chain, who, amount);
    },

    async slashed(who) {
      if (!chain) return false;
      const s = await chain.l1(DEPLOYER_KEY).gateway<boolean>("slashed", [who]);
      trace("chain", `slashed(${who}) = ${s}`);
      return s;
    },
    async batches() {
      if (!chain) return [];
      return (await chain.l1(DEPLOYER_KEY).readBatches()).filter((b) => !b.invalidated);
    },

    async stateRoot() {
      if (!chain) return "0x" as Hex;
      return chain.l1(DEPLOYER_KEY).gateway<Hex>("currentStateRoot");
    },

    /**
     * Claim a withdrawal on L1.
     *
     * The recipient and the amount are NOT ours to choose: withdraw reads both
     * out of the order in the certificate blob. All that has to be supplied is
     * which batch and which certificate within it.
     */
    async claimWithdrawal(sender, sequence) {
      if (!chain) throw new Error("no chain in standalone mode");
      const l1 = chain.l1(DEPLOYER_KEY);
      const batches = (await l1.readBatches()).filter((b) => !b.invalidated);

      for (const b of batches) {
        let certs;
        try {
          certs = decodeCertData(b.certData);
        } catch {
          continue;
        }
        for (let i = 0; i < certs.length; i++) {
          const order = await decodeOrder(certs[i].order, CHAIN_ID).catch(() => null);
          if (!order) continue;
          if (order.sender.toLowerCase() !== sender.toLowerCase()) continue;
          if (order.sequence !== sequence) continue;
          await l1.sendAndWait("gateway", "withdraw", [b.id, i, b.certData, b.stepRoots]);
          return;
        }
      }
      throw new Error(`no posted order from ${sender} at sequence ${sequence}`);
    },

    async logsOf(name) {
      const p = all.find((x) => x.name.startsWith(name));
      return p ? p.logs() : [];
    },

    async ownLogs() {
      const own = [
        ...nodes.filter((n) => n.variant === "honest").map((n) => n.proc),
        client,
        ...(prover ? [prover] : []),
      ];
      return Promise.all(own.map(async (p) => ({ name: p.name, lines: await p.logs().catch(() => []) })));
    },

    async stop() {
      await Promise.all(all.map((p) => p.stop()));
      if (chain) await chain.stop();
      // The network last: removing it while a container is still attached
      // fails, and a leaked network per scenario adds up over eighteen of them.
      await removeNetwork(network);
    },
  };

  return w;
}

// ------------------------------------------------------------------ funding

async function fundNative(chain: Chain, keys: Hex[], amount: bigint): Promise<void> {
  const acct = privateKeyToAccount(DEPLOYER_KEY);
  const pub = createPublicClient({ transport: http(chain.rpcUrl), cacheTime: 0 });
  const wallet = createWalletClient({ account: acct, transport: http(chain.rpcUrl) });
  for (const k of keys) {
    const hash = await wallet.sendTransaction({
      to: privateKeyToAccount(k).address,
      value: amount,
      chain: null,
    });
    await pub.waitForTransactionReceipt({ hash });
  }
}

/**
 * Bridge CRS in for an L2 account.
 *
 * Deposits are ERC20, not native, so this mints, approves and deposits. The
 * deposit only reaches the L2 balance once a validator posts a batch that
 * credits it, which every scenario using this has to account for.
 */
export async function fundL2(chain: Chain, to: Address, amount: bigint): Promise<void> {
  const acct = privateKeyToAccount(DEPLOYER_KEY);
  const pub = createPublicClient({ transport: http(chain.rpcUrl), cacheTime: 0 });
  const wallet = createWalletClient({ account: acct, transport: http(chain.rpcUrl) });

  const mint = await wallet.writeContract({
    address: chain.token,
    abi: courseTokenAbi,
    functionName: "mint",
    args: [acct.address, amount],
    chain: null,
  });
  await pub.waitForTransactionReceipt({ hash: mint });

  const approve = await wallet.writeContract({
    address: chain.token,
    abi: courseTokenAbi,
    functionName: "approve",
    args: [chain.escrow, amount],
    chain: null,
  });
  await pub.waitForTransactionReceipt({ hash: approve });

  const dep = await wallet.writeContract({
    address: chain.gateway,
    abi: gatewayAbi,
    functionName: "deposit",
    args: [to, amount],
    chain: null,
  });
  await pub.waitForTransactionReceipt({ hash: dep });
}

export { until, formatEther, getAddress, parseEther };
export type { Certificate };

/** CRS held on L1. Used to check that bridging out actually paid out. */
export async function courseTokenBalance(chain: Chain, who: Address): Promise<bigint> {
  const pub = createPublicClient({ transport: http(chain.rpcUrl), cacheTime: 0 });
  return (await pub.readContract({
    address: chain.token,
    abi: courseTokenAbi,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}
