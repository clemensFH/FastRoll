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
import type { Hex } from "viem";
import { all, eq, ok, rejects } from "../assert.js";
import { ALICE, BOB, CAROL, CHAIN_ID, CRS, FEE, rpc, type Node, type World } from "../world.js";
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

// ------------------------------------------------------------ our scenarios

const SILENT2 = ["honest", "honest", "honest", "honest", "honest", "silent", "silent"] as const;
const SILENT3 = ["honest", "honest", "honest", "honest", "silent", "silent", "silent"] as const;
const EQUIV2 = ["honest", "honest", "honest", "honest", "honest", "equivocate", "equivocate"] as const;

/** Call a node directly and return either the result or the error code and data. */
async function call(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; code?: number; data?: unknown }> {
  try {
    return { result: await rpc(url, method, params) };
  } catch (e) {
    const f = e as { code?: number; data?: unknown };
    return { code: f.code, data: f.data };
  }
}

/** Collect votes from the given nodes, failing if any refuses. */
async function votesFrom(w: World, nodes: Node[], raw: Hex): Promise<Hex[]> {
  const out: Hex[] = [];
  for (const n of nodes) {
    const r = await w.ask(n, raw);
    ok("signature" in r, `${n.name} must vote for the order, and answered ${JSON.stringify(r)}`);
    out.push((r as { signature: Hex }).signature);
  }
  return out;
}

const cert = (raw: Hex, signatures: Hex[]) => ({ epoch: 0n, order: raw, signatures });

const FIVE_HONEST: Scenario = {
  id: 3,
  task: 1,
  title: "five honest validators and two silent ones, a transfer completes",
  checks: "the client gathers a quorum without waiting for crashed validators",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...SILENT2], genesis: [{ address: ALICE.address, balance: START }] });
    await w.send(await w.order(ALICE, 0n, BOB.address, TEN));
    eq(await w.balanceOf(BOB.address), TEN, "bob receives the amount");
    await agreeOn(w, ALICE.address, START - TEN - FEE, 1n);
  },
};

const FOUR_HONEST: Scenario = {
  id: 4,
  task: 1,
  title: "four honest validators and three silent ones, no transfer succeeds",
  checks: "no certificate without five votes, and the client answers -32003",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...SILENT3], genesis: [{ address: ALICE.address, balance: START }] });
    const why = await rejects(async () => w.send(await w.order(ALICE, 0n, BOB.address, TEN)), "the send must fail without a quorum");
    ctx.note(why);
    await agreeOn(w, ALICE.address, START, 0n);
    await agreeOn(w, BOB.address, 0n, 0n);
  },
};

const EQUIVOCATING_VALIDATORS: Scenario = {
  id: 5,
  task: 1,
  title: "five honest and two equivocating validators: payments work, the two cannot certify alone",
  checks: "certificate verification at honest validators, and that byzantine votes do not lower the quorum",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...EQUIV2], genesis: [{ address: ALICE.address, balance: START }] });
    await w.send(await w.order(ALICE, 0n, BOB.address, TEN));
    await agreeOn(w, ALICE.address, START - TEN - FEE, 1n);

    // Alice equivocates at nonce 1. The honest five see only toBob.
    const toBob = await w.order(ALICE, 1n, BOB.address, TEN);
    const toCarol = await w.order(ALICE, 1n, CAROL.address, TEN);
    await votesFrom(w, w.honest(), toBob);
    const byz = await votesFrom(w, w.byzantine(), toCarol);
    const accepted = await w.certify(toCarol, byz, 0n);
    eq(accepted <= 2, true, "a two-signature certificate is accepted by no honest validator");
    await agreeOn(w, CAROL.address, 0n, 0n);

    // The honest order still goes through.
    await w.send(toBob);
    await agreeOn(w, ALICE.address, START - 2n * (TEN + FEE), 2n);
    await agreeOn(w, BOB.address, 2n * TEN, 0n);
  },
};

const EQUIVOCATING_SENDER: Scenario = {
  id: 6,
  task: 1,
  title: "an equivocating sender splits seven honest validators, and neither order certifies",
  checks: "CONFLICTING_PENDING: one order per (sender, nonce)",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...HONEST], genesis: [{ address: ALICE.address, balance: START }] });
    const toBob = await w.order(ALICE, 0n, BOB.address, TEN);
    const toCarol = await w.order(ALICE, 0n, CAROL.address, TEN);
    await votesFrom(w, w.nodes.slice(0, 4), toBob);
    await votesFrom(w, w.nodes.slice(4), toCarol);
    await rejects(() => w.send(toBob), "the order to bob has only four votes");
    await rejects(() => w.send(toCarol), "the order to carol has only three votes");
    // The funds are locked at nonce 0, and a third order is refused too.
    const third = await w.ask(w.nodes[0], await w.order(ALICE, 0n, ALICE.address, TEN));
    ok("reason" in third && third.reason === "CONFLICTING_PENDING", `a third order must be CONFLICTING_PENDING, got ${JSON.stringify(third)}`);
    await agreeOn(w, ALICE.address, START, 0n);
  },
};

const CHAINED: Scenario = {
  id: 7,
  task: 1,
  title: "chained payments: received funds are spendable at once",
  checks: "credits apply on confirm and leave the recipient's nonce alone",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...HONEST], genesis: [{ address: ALICE.address, balance: START }] });
    const FIVE = 5n * CRS;
    await w.send(await w.order(ALICE, 0n, BOB.address, TEN));
    await w.send(await w.order(BOB, 0n, CAROL.address, FIVE));
    await w.send(await w.order(BOB, 1n, CAROL.address, CRS));
    await w.send(await w.order(CAROL, 0n, ALICE.address, CRS));
    await agreeOn(w, BOB.address, TEN - FIVE - CRS - 2n * FEE, 2n);
    await agreeOn(w, CAROL.address, FIVE + CRS - CRS - FEE, 1n);
    await agreeOn(w, ALICE.address, START - TEN - FEE + CRS, 1n);
    eq(await w.balanceOf(CAROL.address), FIVE - FEE, "the client reports carol's balance");
  },
};

const REFUSAL_REASONS: Scenario = {
  id: 8,
  task: 1,
  title: "a validator refuses each kind of invalid order with the right reason",
  checks: "the signing rule, in the order of 'Which refusal reason applies first'",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...HONEST], genesis: [{ address: ALICE.address, balance: START }] });
    const v = w.nodes[0];
    const expect = async (what: string, raw: Hex, reason: string, epoch?: bigint) => {
      const r = await w.ask(v, raw, epoch);
      ok("reason" in r && r.reason === reason, `${what}: expected ${reason}, got ${JSON.stringify(r)}`);
    };
    await expect("garbage bytes", "0xdeadbeef", "INVALID_FORMAT");
    await expect("a wrong epoch", await w.order(ALICE, 0n, BOB.address, TEN), "WRONG_EPOCH", 1n);
    await expect("a zero transfer", await w.order(ALICE, 0n, BOB.address, 0n), "ZERO_AMOUNT");
    await expect("a future nonce", await w.order(ALICE, 3n, BOB.address, TEN), "INVALID_NONCE");
    await expect("more than the balance", await w.order(ALICE, 0n, BOB.address, START), "INSUFFICIENT_BALANCE");
    const first = await w.order(ALICE, 0n, BOB.address, TEN);
    const r1 = await w.ask(v, first);
    ok("signature" in r1, `a valid order is signed, got ${JSON.stringify(r1)}`);
    const r2 = await w.ask(v, first);
    ok("signature" in r2 && r2.signature === (r1 as { signature: Hex }).signature, "a byte-identical re-send gets the same vote");
    await expect("a second order at the same nonce", await w.order(ALICE, 0n, CAROL.address, TEN), "CONFLICTING_PENDING");
    // An omitted epoch means the validator's own; a wrong-format param is -32602.
    const bad = await call(v.url, "fastpay_handleOrder", ["0xzz"]);
    eq(bad.code, -32602, "a raw that is not bytes is -32602");
    const unknown = await call(v.url, "fastpay_nope", []);
    eq(unknown.code, -32601, "an unknown method is -32601");
  },
};

const CERTIFICATES: Scenario = {
  id: 9,
  task: 1,
  title: "handleCertificate: repeats, missing predecessors and invalid certificates",
  checks: "certificate validity (-32002), repeats answered ok without effect, and -32008 for a gap",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...HONEST], genesis: [{ address: ALICE.address, balance: START }] });
    const five = w.nodes.slice(0, 5);
    const lagging = w.nodes[5];
    const a0 = await w.order(ALICE, 0n, BOB.address, TEN);
    const s0 = await votesFrom(w, five, a0);

    // Too few signatures, and one signer counted five times.
    eq((await call(lagging.url, "fastpay_handleCertificate", [cert(a0, s0.slice(0, 4))])).code, -32002, "four signatures are -32002");
    eq((await call(lagging.url, "fastpay_handleCertificate", [cert(a0, [s0[0], s0[0], s0[0], s0[0], s0[0]])])).code, -32002, "a repeated signer is -32002");
    eq((await call(lagging.url, "fastpay_handleCertificate", [{ ...cert(a0, s0), epoch: 1n }])).code, -32002, "a wrong epoch is -32002");

    // Apply nonce 0 at the first five only.
    for (const n of five) {
      const r = await call(n.url, "fastpay_handleCertificate", [cert(a0, s0)]);
      eq((r.result as { ok?: boolean } | undefined)?.ok, true, `${n.name} accepts the certificate`);
    }
    // A repeat is ok and changes nothing.
    const again = await call(five[0].url, "fastpay_handleCertificate", [cert(a0, s0)]);
    eq((again.result as { ok?: boolean } | undefined)?.ok, true, "a repeated certificate is answered ok");
    const after = await w.account(five[0], ALICE.address);
    eq(after.balance, START - TEN - FEE, "a repeat does not debit twice");
    eq(after.nextSequence, 1n, "a repeat does not advance the nonce");

    // Nonce 1 reaches the lagging validator before nonce 0 did.
    const a1 = await w.order(ALICE, 1n, BOB.address, TEN);
    const s1 = await votesFrom(w, five, a1);
    const gap = await call(lagging.url, "fastpay_handleCertificate", [cert(a1, s1)]);
    eq(gap.code, -32008, "a certificate past the validator's next nonce is -32008");
    eq((gap.data as { nextSequence?: string } | undefined)?.nextSequence, "0x0", "and it reports nextSequence");

    // Once the missing one arrives, the refused one is accepted.
    await call(lagging.url, "fastpay_handleCertificate", [cert(a0, s0)]);
    const fixed = await call(lagging.url, "fastpay_handleCertificate", [cert(a1, s1)]);
    eq((fixed.result as { ok?: boolean } | undefined)?.ok, true, "after catching up, the certificate is accepted");
    const lag = await w.account(lagging, ALICE.address);
    eq(lag.nextSequence, 2n, "the lagging validator applied both, in order");
  },
};

const WITHDRAWAL: Scenario = {
  id: 10,
  task: 1,
  title: "a withdrawal burns its amount and fee",
  checks: "withdrawals to the precompile credit nobody in standalone mode",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...HONEST], genesis: [{ address: ALICE.address, balance: START }] });
    await w.send(await w.withdrawalOrder(ALICE, 0n, BOB.address, TEN));
    await agreeOn(w, ALICE.address, START - TEN - FEE, 1n);
    await agreeOn(w, BOB.address, 0n, 0n);
  },
};

const CLIENT_SURFACE: Scenario = {
  id: 11,
  task: 1,
  title: "the client's cast-compatible surface",
  checks: "chainId, receipts, synthetic blocks, idempotent resend, and the --legacy refusal",
  async run(ctx) {
    const w = await ctx.world({ mode: "standalone", variants: [...HONEST], genesis: [{ address: ALICE.address, balance: START }] });
    const url = w.client.url;
    eq(BigInt((await rpc<Hex>(url, "eth_chainId", [])) as string), BigInt(CHAIN_ID), "eth_chainId is the L2 chain id");
    eq(await rpc(url, "eth_blockNumber", []), "0x0", "no block before the first settlement");
    eq((await call(url, "eth_feeHistory", [1, "latest", []])).code, -32004, "eth_feeHistory fails with -32004");
    eq((await call(url, "eth_bogus", [])).code, -32601, "an unknown method is -32601");

    const raw = await w.order(ALICE, 0n, BOB.address, TEN);
    const hash = await w.send(raw);
    const receipt = await rpc<{ status: string; blockNumber: string; from: string; to: string } | null>(url, "eth_getTransactionReceipt", [hash]);
    ok(receipt !== null, "a settled order has a receipt");
    eq(receipt!.status, "0x1", "receipt status");
    eq(receipt!.blockNumber, "0x1", "the first settlement is block 1");
    eq(receipt!.to.toLowerCase(), BOB.address.toLowerCase(), "receipt to");
    eq(await rpc(url, "eth_blockNumber", []), "0x1", "one block after one settlement");
    const block = await rpc<{ number: string; sha3Uncles: string } | null>(url, "eth_getBlockByNumber", ["latest", false]);
    eq(block?.number, "0x1", "latest block is block 1");
    ok(typeof block?.sha3Uncles === "string", "the block has sha3Uncles");
    eq(await rpc(url, "eth_getBlockByNumber", ["0x5", false]), null, "a block past the latest is null");

    eq(await w.send(raw), hash, "a resend returns the same hash");
    eq(await w.balanceOf(ALICE.address), START - TEN - FEE, "a resend does not pay twice");
    eq(await rpc(url, "eth_getTransactionCount", [ALICE.address, "latest"]), "0x1", "eth_getTransactionCount is the next nonce");
  },
};

export const ALL_SCENARIOS: Scenario[] = [
  TRANSFER,
  REFUSAL,
  FIVE_HONEST,
  FOUR_HONEST,
  EQUIVOCATING_VALIDATORS,
  EQUIVOCATING_SENDER,
  CHAINED,
  REFUSAL_REASONS,
  CERTIFICATES,
  WITHDRAWAL,
  CLIENT_SURFACE,
];
export type { Scenario, Ctx } from "./types.js";
