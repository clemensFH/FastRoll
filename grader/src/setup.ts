/**
 * `--check-setup`: does the submission start at all?
 *
 * One check per task: the world that task's scenarios run in, every seat
 * honest, then one call to each process on the methods it must answer. Nothing
 * about the protocol is asserted. A pass means the image builds, the configs
 * are read, the contracts deploy and the processes answer, so a scenario that
 * fails afterwards failed on behaviour and not on plumbing.
 *
 * Not part of ALL_SCENARIOS, so it runs while a skeleton's scenario list is
 * still empty, and it is worth no points.
 */
import type { Address } from "viem";
import { Failed } from "./assert.js";
import type { Ctx, Scenario, WorldOpts } from "./scenarios/types.js";
import { ALICE, GENESIS_SUPPLY, rpc, type World } from "./world.js";

const HONEST = Array(7).fill("honest");

/** Ids 1160 to 1162, the top of the range, reserved for these. */
const BASE_ID = 1159;

async function answers<T>(url: string, method: string, who: string): Promise<T> {
  try {
    return await rpc<T>(url, method, []);
  } catch (e) {
    throw new Failed(`${who} did not answer ${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const same = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

async function start(ctx: Ctx, opts: WorldOpts): Promise<World> {
  let w: World;
  try {
    w = await ctx.world(opts);
  } catch (e) {
    throw new Failed(`starting up failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.note(
    opts.mode === "anchored"
      ? `image built, Gateway deployed, validators bonded, committee of ${w.committee.length} seated`
      : "image built, 7 validators and the client started",
  );
  return w;
}

/** Every process answers, and says who it is. */
async function probe(ctx: Ctx, w: World, mode: "standalone" | "anchored"): Promise<void> {
  for (const n of w.nodes) {
    const info = await answers<{ address?: unknown; mode?: unknown }>(n.url, "fastpay_info", n.name);
    if (!same(info.address, n.address)) {
      throw new Failed(`${n.name}'s fastpay_info gives address ${String(info.address)}, but its config's identity is ${n.address}`);
    }
    if (info.mode !== mode) {
      throw new Failed(`${n.name}'s fastpay_info gives mode ${String(info.mode)}, but its config says ${mode}`);
    }
    await answers(n.vapiUrl, "vapi_info", `${n.name}'s vapi_`);
  }
  ctx.note("7 validators answer fastpay_info and vapi_info, each with its configured identity");

  await answers(w.client.url, "eth_chainId", "the client");
  const status = await answers<{ peers?: { address: Address | null }[] }>(w.client.url, "fpc_status", "the client");
  const peers = Array.isArray(status.peers) ? status.peers : [];
  const known = peers.filter((p) => p && p.address !== null && p.address !== undefined).length;
  if (peers.length !== 7 || known !== 7) {
    throw new Failed(`the client's fpc_status lists ${peers.length} peers, ${known} of them identified; expected 7 and 7`);
  }
  ctx.note("the client answers eth_chainId, and fpc_status lists 7 identified peers");

  if (mode === "standalone") {
    // The read every Task 1 scenario starts with, so a config whose genesis is
    // not read shows up here rather than as six unrelated failures.
    let b: bigint;
    try {
      b = await w.balanceOf(ALICE.address);
    } catch (e) {
      throw new Failed(`eth_getBalance through the client failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (b !== GENESIS_SUPPLY) {
      throw new Failed(`the genesis account holds ${b} through the client, expected ${GENESIS_SUPPLY}: is genesis read from the config?`);
    }
    ctx.note("the genesis balance reads back through the client");
  }

  if (w.prover) {
    await answers(w.prover.url, "prover_status", "the prover");
    ctx.note("the prover answers prover_status");
  }
}

export const SETUP_CHECKS: Scenario[] = [
  {
    id: BASE_ID + 1,
    task: 1,
    title: "setup: standalone validators and client start and answer",
    checks: "the image builds, every process reads its config and answers on its interface",
    points: 0,
    async run(ctx) {
      const w = await start(ctx, {
        mode: "standalone",
        variants: HONEST,
        genesis: [{ address: ALICE.address, balance: GENESIS_SUPPLY }],
      });
      await probe(ctx, w, "standalone");
    },
  },
  {
    id: BASE_ID + 2,
    task: 2,
    title: "setup: the Gateway deploys, validators bond, everything answers",
    checks: "Deploy.s.sol prints the ATBT_ addresses, every validator bonds and is seated, every process answers",
    points: 0,
    async run(ctx) {
      const w = await start(ctx, { mode: "anchored", variants: HONEST });
      await probe(ctx, w, "anchored");
    },
  },
  {
    id: BASE_ID + 3,
    task: 3,
    title: "setup: as Task 2, plus the prover",
    checks: "as Task 2, and the prover starts and answers prover_status",
    points: 0,
    async run(ctx) {
      const w = await start(ctx, { mode: "anchored", variants: HONEST, withProver: true });
      await probe(ctx, w, "anchored");
    },
  },
];
