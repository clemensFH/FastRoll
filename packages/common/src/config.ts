/**
 * The startup contract. FROZEN.
 *
 * Every process in this system is configured by exactly one JSON file and
 * nothing else. No environment variables, no flags beyond the path itself.
 *
 * That is not tidiness. The grader starts a solution written in a language
 * nobody here has seen, inside a container nobody here built, so the only thing
 * it can rely on is a file it wrote and a path it passed. A contract made of
 * thirty environment variables read across four runners, which is what this
 * replaced, cannot be implemented from a specification because the
 * specification never listed them.
 *
 * Read it with `loadConfig(path)`. Every process takes the path as its first
 * argument, or in `$ATBT_CONFIG`.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { COMMITTEE_SIZE } from "./constants.js";

export type Role = "validator" | "client" | "prover";
export type Mode = "standalone" | "anchored";

export interface ConfigL1 {
  rpcUrl: string;
  chainId: number;
  gateway: Address;
  registry: Address;
}

export interface NodeConfig {
  /** A label. Appears in logs and in `vapi_info`, and nothing depends on it. */
  name: string;
  role: Role;
  /** standalone is Task 1 and has no L1. anchored is Tasks 2 and 3. */
  mode: Mode;
  /** The secp256k1 key this process signs with. For a validator this is its
   *  committee identity; for a prover it is who collects the bounty. Absent for
   *  a client, which signs nothing: orders arrive already signed by whoever
   *  owns the account, and reading L1 needs no key. */
  identity?: { privateKey: Hex };

  listen: {
    /** The public protocol port. `fastpay_` for a validator, the
     *  cast-compatible surface for a client, `prover_` for a prover. */
    port: number;
    /** A validator's control port, serving `vapi_`. */
    vapiPort?: number;
    /**
     * Interface to bind `vapi_` to. Defaults to 127.0.0.1.
     *
     * `vapi_` can make a validator sync or post now, so it must not be
     * reachable from outside the operator's own trust boundary. On a shared host
     * that means loopback. Inside a container it means the container's own
     * namespace with the port left unpublished, which is why this is a setting
     * and not a constant: binding loopback in a container would put it out of
     * reach of the operator too.
     */
    vapiHost?: string;
  };

  /** Committee endpoints, for a client to collect votes from and a prover to
   *  poll. L1 stores keys, not URLs, so somebody has to say where they are. A
   *  validator has none, because it never talks to another validator. */
  peers: string[];

  /**
   * Where this process may persist state between restarts.
   *
   * Optional, and optional in a load-bearing way: if the directory does not
   * exist, the process MUST start from an empty state and rebuild from L1.
   * Persisting is a choice. Being able to start without it is not, because it is
   * the only thing that keeps the cold path exercised, and the cold path is what
   * a new validator joining the committee actually runs.
   */
  dataDir?: string;

  l2: { chainId: number };
  /** Required when mode is anchored. */
  l1?: ConfigL1;

  /**
   * Base units to bond at startup, as a decimal string.
   *
   * A validator bonds itself. Nobody bonds it for it, which is why this is here
   * rather than being somebody else's transaction.
   */
  stake?: string;

  /** Standalone only: the starting allocation, since there is no L1 to bridge
   *  from. Balances are decimal strings of base units. */
  genesis?: { address: Address; balance: string }[];

  /** Standalone only: the committee, since there is no Registry to read it
   *  from. */
  committee?: Address[];

  /** How often to act unprompted. The grader sets these very high and drives
   *  `vapi_syncNow`, `vapi_postNow` and `prover_scanNow` itself, because a
   *  scenario that depends on which timer fired first fails on a slow machine. */
  intervals?: { syncMs?: number; postMs?: number; scanMs?: number; pollMs?: number };

  /** Client only. The minimum gas price this client will accept, in base units. */
  minGasPrice?: string;
  /** Client only, and optional. Where to report gathered votes. */
  proverUrl?: string;
}

export class ConfigError extends Error {}

function fail(field: string, why: string): never {
  throw new ConfigError(`config field "${field}": ${why}`);
}

function req<T>(v: T | undefined | null, field: string): T {
  if (v === undefined || v === null) fail(field, "is required and was missing");
  return v;
}

function addr(v: unknown, field: string): Address {
  if (typeof v !== "string" || !isAddress(v)) fail(field, `is not an address: ${String(v)}`);
  return getAddress(v);
}

function uint(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    fail(field, `is not a non-negative integer: ${String(v)}`);
  }
  return v;
}

function decimal(v: unknown, field: string): bigint {
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    fail(field, `is not a decimal string of base units: ${String(v)}`);
  }
  return BigInt(v);
}

/**
 * Parse and validate. Every failure names the field, because a config error at
 * startup inside a container is otherwise a process that exits with nothing
 * useful on stderr.
 */
/** The signing key, for the roles that have one. Parsing already guarantees a
 *  validator and a prover carry one, so this throwing means the caller asked on
 *  behalf of a client. */
export function signingKey(cfg: NodeConfig): Hex {
  if (!cfg.identity) throw new ConfigError(`${cfg.role} has no identity, and only a client may lack one`);
  return cfg.identity.privateKey;
}

export function parseConfig(raw: unknown, source = "<config>"): NodeConfig {
  if (typeof raw !== "object" || raw === null) throw new ConfigError(`${source}: not an object`);
  const c = raw as Record<string, unknown>;

  const role = req(c.role, "role") as Role;
  if (!["validator", "client", "prover"].includes(role)) {
    fail("role", `must be validator, client or prover, got ${String(role)}`);
  }
  const mode = (c.mode ?? "anchored") as Mode;
  if (!["standalone", "anchored"].includes(mode)) {
    fail("mode", `must be standalone or anchored, got ${String(mode)}`);
  }

  // A client has no identity, because it signs nothing. Requiring one for
  // every role meant every launcher had to invent a key for the client and
  // hand it the prover's, which is exactly the kind of thing that gets copied
  // into a student's config and then into a bug report.
  let privateKey: string | undefined;
  if (role === "client") {
    if (c.identity !== undefined) fail("identity", "must not be set for a client, which signs nothing");
  } else {
    const identity = req(c.identity, "identity") as { privateKey?: unknown };
    const k = req(identity.privateKey, "identity.privateKey");
    if (typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k)) {
      fail("identity.privateKey", "is not a 0x-prefixed 32 byte hex string");
    }
    privateKey = k as string;
  }

  const listen = req(c.listen, "listen") as Record<string, unknown>;
  const port = uint(req(listen.port, "listen.port"), "listen.port");
  const vapiPort = listen.vapiPort === undefined ? undefined : uint(listen.vapiPort, "listen.vapiPort");
  if (role === "validator" && vapiPort === undefined) {
    fail("listen.vapiPort", "is required for a validator, which must serve vapi_");
  }

  if (c.peers !== undefined && role === "validator") {
    fail("peers", "must not be set for a validator, which never talks to another validator");
  }
  const peers = (c.peers ?? []) as unknown;
  if (!Array.isArray(peers) || peers.some((p) => typeof p !== "string")) {
    fail("peers", "must be an array of URLs");
  }

  const l2 = req(c.l2, "l2") as { chainId?: unknown };
  const chainId = uint(req(l2.chainId, "l2.chainId"), "l2.chainId");

  let l1: ConfigL1 | undefined;
  if (mode === "anchored") {
    const raw1 = req(c.l1, "l1") as Record<string, unknown>;
    l1 = {
      rpcUrl: String(req(raw1.rpcUrl, "l1.rpcUrl")),
      chainId: uint(req(raw1.chainId, "l1.chainId"), "l1.chainId"),
      gateway: addr(req(raw1.gateway, "l1.gateway"), "l1.gateway"),
      registry: addr(req(raw1.registry, "l1.registry"), "l1.registry"),
    };
  } else if (c.l1 !== undefined) {
    fail("l1", "must not be set in standalone mode, which has no chain");
  }

  // Role-scoped, so a field in the wrong file is caught at startup rather than
  // ignored silently. A stake on a prover, or a gas floor on a validator, means
  // the author believed something about the process that is not true.
  if (c.stake !== undefined) {
    if (role !== "validator") fail("stake", "only a validator bonds stake");
    if (mode !== "anchored") fail("stake", "there is nothing to bond in standalone mode");
    decimal(c.stake, "stake");
  }
  if (c.minGasPrice !== undefined) {
    if (role !== "client") fail("minGasPrice", "only a client refuses orders below the fee floor");
    decimal(c.minGasPrice, "minGasPrice");
  }
  if (c.proverUrl !== undefined && role !== "client") {
    fail("proverUrl", "only a client reports votes to a prover");
  }

  const genesis = (c.genesis ?? []) as { address: unknown; balance: unknown }[];
  if (!Array.isArray(genesis)) fail("genesis", "must be an array");
  const parsedGenesis = genesis.map((g, i) => ({
    address: addr(g.address, `genesis[${i}].address`),
    balance: String(decimal(g.balance, `genesis[${i}].balance`)),
  }));
  if (mode === "anchored" && parsedGenesis.length > 0) {
    fail("genesis", "must be empty in anchored mode, where balances come from deposits");
  }

  const committee = ((c.committee ?? []) as unknown[]).map((a, i) =>
    addr(a, `committee[${i}]`),
  );
  // Anchored processes read the committee from L1, so one in the file means
  // the author thinks it is used. A standalone validator has no L1 and checks
  // every certificate against this list, so a short or missing one makes it
  // reject every certificate without saying why.
  if (mode === "anchored" && committee.length > 0) {
    fail("committee", "must not be set in anchored mode, where the committee comes from L1");
  }
  if (mode === "standalone" && role === "validator" && committee.length !== COMMITTEE_SIZE) {
    fail("committee", `a standalone validator needs all ${COMMITTEE_SIZE} members, got ${committee.length}`);
  }

  const intervals = (c.intervals ?? {}) as Record<string, unknown>;

  return {
    name: String(c.name ?? role),
    role,
    mode,
    identity: privateKey === undefined ? undefined : { privateKey: privateKey as Hex },
    listen: {
      port,
      vapiPort,
      vapiHost: listen.vapiHost === undefined ? "127.0.0.1" : String(listen.vapiHost),
    },
    peers: peers as string[],
    dataDir: c.dataDir === undefined ? undefined : String(c.dataDir),
    l2: { chainId },
    l1,
    stake: c.stake === undefined ? undefined : String(c.stake),
    genesis: parsedGenesis,
    committee,
    intervals: {
      syncMs: intervals.syncMs === undefined ? 1000 : uint(intervals.syncMs, "intervals.syncMs"),
      postMs: intervals.postMs === undefined ? 3000 : uint(intervals.postMs, "intervals.postMs"),
      scanMs: intervals.scanMs === undefined ? 2000 : uint(intervals.scanMs, "intervals.scanMs"),
      // How long a client waits for votes before reporting
      // no quorum. A timeout and a genuine failure to reach a quorum are the
      // same answer to a caller, which is why this is a budget and not a retry.
      pollMs: intervals.pollMs === undefined ? 8000 : uint(intervals.pollMs, "intervals.pollMs"),
    },
    minGasPrice: c.minGasPrice === undefined ? "1000000000" : String(c.minGasPrice),
    proverUrl: c.proverUrl === undefined ? undefined : String(c.proverUrl),
  };
}

/** Read the config named by argv[1] or $ATBT_CONFIG. */
export function loadConfig(path?: string): NodeConfig {
  const p = path ?? process.argv[2] ?? process.env.ATBT_CONFIG;
  if (!p) {
    throw new ConfigError(
      "no config file given. Pass its path as the first argument, or set ATBT_CONFIG.",
    );
  }
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read config at ${p}: ${e instanceof Error ? e.message : e}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${p} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  return parseConfig(parsed, p);
}

/**
 * Whether persisted state may be used.
 *
 * A missing directory is the documented signal to start from scratch, and it is
 * the only thing that keeps the from-genesis rebuild exercised.
 *
 * The reference implementation never calls this, because it never persists: it
 * rebuilds from L1 on every start and then advances from a cursor, which is
 * fast enough that saving the tree buys nothing here. That is a deliberate
 * choice and not an oversight. The helper is given because persisting IS
 * allowed, and a solution that does it has to honour this rule exactly, or it
 * resumes onto a state the chain has since rolled back.
 */
export function mayResume(cfg: NodeConfig): boolean {
  return cfg.dataDir !== undefined && existsSync(cfg.dataDir);
}
