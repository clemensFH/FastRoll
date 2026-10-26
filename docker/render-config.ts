#!/usr/bin/env tsx
/**
 * Build this container's config file from its environment.
 *
 * Every process is configured by one JSON file and nothing else, which is the
 * startup contract in spec/SPEC.md. A container has to produce that file from
 * something, and the something is the addresses the setup service deployed plus
 * a handful of compose-level variables. So this is a shim, not a second
 * configuration mechanism: the process still reads a file and nothing else.
 *
 * It used to be bash. Bash cannot build JSON without either jq, which is not in
 * this image, or string concatenation, which is what it was: a hand-rolled
 * array join for the peer list, three near-identical heredocs sharing a spliced
 * blob of common fields, and one conditional comma that had to be a plain `if`
 * because `${VAR:+...}` eats the double quotes inside its own word and renders
 * an unquoted JSON key. Every one of those is a way to emit invalid JSON that
 * nothing notices until the service refuses to start.
 *
 * Here the config is an object, JSON.stringify writes it, and `parseConfig`
 * checks it against the real schema before the service ever sees it, so a wrong
 * compose value fails here naming the field rather than three seconds later
 * inside the process.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseConfig, type NodeConfig } from "@atbt/common";

const ROLES = ["validator", "client", "prover"] as const;
type Role = (typeof ROLES)[number];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function need(name: string): string {
  const v = env(name);
  if (v === undefined) throw new Error(`${name} is required and was not set`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = env(name);
  return v === undefined ? fallback : Number(v);
}

/** `KEY=value` lines, which is what the setup service writes. */
function parseEnvFile(raw: string): Record<string, string> {
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)] as const;
    });
  return Object.fromEntries(entries);
}

/** The file's contents, or undefined while it does not exist yet. */
function readIfReady(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return raw.trim() ? raw : undefined;
}

/** Poll until something is there, or give up saying what was missing. */
async function waitFor<T>(what: string, get: () => T | undefined, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`gave up waiting for ${what} after ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function build(role: Role, name: string, addr: Record<string, string>): Record<string, unknown> {
  const shared = {
    name,
    role,
    mode: "anchored",
    l2: { chainId: num("L2_CHAIN_ID", 90007) },
    l1: {
      rpcUrl: need("L1_RPC"),
      chainId: num("L1_CHAIN_ID", 31337),
      gateway: addr.GATEWAY,
      registry: addr.REGISTRY,
    },
  };
  // Where the committee is, for the roles that talk to it. A validator talks
  // to nobody, and the config refuses `peers` on one.
  const peers = { peers: (env("PEERS") ?? "").split(",").filter(Boolean) };

  switch (role) {
    case "validator":
      return {
        ...shared,
        identity: { privateKey: need("VALIDATOR_KEY") },
        // vapiHost stays on loopback. Nothing outside this container needs the
        // operator interface: the setup service moves the chain to the first
        // epoch with a committee. The grader is the case where that reasoning
        // flips, and the grader does not use this file.
        listen: { port: num("PORT", 9600), vapiPort: num("VAPI_PORT", 9700), vapiHost: "127.0.0.1" },
        stake: need("STAKE"),
        dataDir: `/data/${name}`,
        intervals: { syncMs: num("SYNC_INTERVAL_MS", 1000), postMs: num("POST_INTERVAL_MS", 3000) },
      };

    case "client":
      return {
        ...shared,
        ...peers,
        // No identity. A client signs nothing: orders arrive already signed by
        // whoever owns the account, and reading L1 needs no key.
        listen: { port: num("PORT", 9545) },
        minGasPrice: env("MIN_GAS_PRICE") ?? "1000000000",
        ...(env("PROVER_URL") ? { proverUrl: env("PROVER_URL") } : {}),
      };

    case "prover":
      return {
        ...shared,
        ...peers,
        identity: { privateKey: need("PROVER_KEY") },
        listen: { port: num("PORT", 9900) },
        intervals: { scanMs: num("SCAN_INTERVAL_MS", 3000) },
      };
  }
}

async function main(): Promise<void> {
  const role = need("ROLE") as Role;
  if (!ROLES.includes(role)) throw new Error(`ROLE must be one of ${ROLES.join(", ")}, got "${role}"`);
  const name = need("NAME");

  // Waiting is not paranoia. Compose reads `env_file` when it PLANS the run,
  // before any service has started, so a file written by setup during the same
  // `up` is always read empty no matter what `depends_on` says. The values have
  // to be picked up at container start instead.
  const path = env("ADDRESSES") ?? "/shared/addresses";
  const raw = await waitFor(`${path} (written by the setup service)`, () => readIfReady(path));
  const addr = parseEnvFile(raw);
  for (const k of ["GATEWAY", "REGISTRY"] as const) {
    if (!addr[k]) throw new Error(`the addresses file has no ${k}`);
  }

  const cfg = build(role, name, addr);
  // Validated here, against the same parser the service uses, so a bad compose
  // value names its own field instead of surfacing as a startup crash.
  const checked: NodeConfig = parseConfig(cfg, "the rendered config");

  const out = `/tmp/${name}.json`;
  writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
  console.error(`${checked.name}: rendered ${out} for role ${checked.role}`);
  // stdout is the path alone, so the entrypoint can consume it.
  console.log(out);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
