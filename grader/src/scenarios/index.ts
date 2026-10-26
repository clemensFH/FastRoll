/**
 * Your scenarios.
 *
 * The harness around this file is the same one the lecture team grades with:
 * `ctx.world()` starts a committee, a chain, a client and a prover, points the
 * client and the prover at the committee, and tears the whole thing down
 * afterwards. What it does NOT ship is the graded scenario list.
 *
 * Two public scenarios come with it, so `pnpm grade -- --task 1` has something
 * to run from the start. They are the simplest cases, not the graded set:
 * write more of your own below and add them to `ALL_SCENARIOS`. The examples in
 * the task sheet's "Grading" section are a good place to start, and the graded
 * set is larger, so a solution that passes exactly those has tested the shape
 * rather than the space.
 *
 * Give each scenario a unique `id`; `--task` and `--scenario` filter on `id`
 * and `task`, and `checks` is printed next to the result, so write it for
 * whoever has to fix the failure.
 */
import { all, eq, ok } from "../assert.js";
import { ALICE, BOB, CRS, FEE, type World } from "../world.js";
import type { Scenario } from "./types.js";

const START = 100n * CRS;
const TEN = 10n * CRS;
const HONEST = ["honest", "honest", "honest", "honest", "honest", "honest", "honest"] as const;

/** Every honest validator must hold the same view of an account. */
async function agreeOn(w: World, who: `0x${string}`, balance: bigint, sequence: bigint): Promise<void> {
  const views = await Promise.all(w.honest().map(async (n) => ({ n, a: await w.account(n, who) })));
  all(
    views,
    `every honest validator must see ${who} at balance ${balance} sequence ${sequence}`,
    (v) => v.a.balance === balance && v.a.nextSequence === sequence,
    (v) => `${v.n.name} saw balance ${v.a.balance} sequence ${v.a.nextSequence}`,
  );
}

/** Seven honest validators move money through the client. */
const TRANSFER: Scenario = {
  id: 1,
  task: 1,
  title: "seven honest validators, a transfer completes",
  checks: "the signing rule, certificate assembly, and applying a confirmed certificate",
  async run(ctx) {
    const w = await ctx.world({
      // Task 1 has no chain; Tasks 2 and 3 are "anchored".
      mode: "standalone",
      // One entry per committee seat. "silent" and "equivocate" are the
      // lecture team's byzantine validators (see the task sheet).
      variants: [...HONEST],
      genesis: [{ address: ALICE.address, balance: START }],
    });
    // `order` signs a transfer, which IS a legacy Ethereum transaction, and
    // `send` submits it through the client the way cast would.
    await w.send(await w.order(ALICE, 0n, BOB.address, TEN));
    eq(await w.balanceOf(BOB.address), TEN, "bob receives the amount");
    // Alice pays the fee as well as the amount, which is why this is not 90.
    eq(await w.balanceOf(ALICE.address), START - TEN - FEE, "alice pays the amount and the fee");
    eq(await w.sequenceOf(ALICE.address), 1n, "alice's sequence advances by one");
    eq(await w.sequenceOf(BOB.address), 0n, "receiving leaves bob's sequence unchanged");
    await agreeOn(w, ALICE.address, START - TEN - FEE, 1n);
  },
};

/** One validator, asked directly, refuses an order its sender cannot pay. */
const REFUSAL: Scenario = {
  id: 2,
  task: 1,
  title: "a validator refuses an order the sender cannot pay",
  checks: "the balance check of the signing rule and its refusal reason",
  async run(ctx) {
    const w = await ctx.world({
      mode: "standalone",
      variants: [...HONEST],
      genesis: [{ address: ALICE.address, balance: START }],
    });
    // Bob starts with nothing. `ask` goes to one validator and bypasses the
    // client, which is how a scenario checks a single validator's answer.
    const r = await w.ask(w.nodes[0], await w.order(BOB, 0n, ALICE.address, TEN));
    ok("reason" in r && r.reason === "INSUFFICIENT_BALANCE", `the validator must refuse with INSUFFICIENT_BALANCE, and answered ${JSON.stringify(r)}`);
  },
};

export const ALL_SCENARIOS: Scenario[] = [TRANSFER, REFUSAL];
export type { Scenario, Ctx } from "./types.js";
