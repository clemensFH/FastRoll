/**
 * The ingest cursor.
 *
 * `replayFromL1` can advance from its own previous result instead of rebuilding
 * from genesis. That is worth having and it is also the kind of optimisation
 * that is quietly wrong, so these tests pin the three cases that matter: a warm
 * advance must agree with a cold rebuild, a rollback must NOT advance, and a
 * replay that stopped early must not be resumed.
 *
 * No chain here. Only `readBatches` and `readDeposits` are exercised, so a stub
 * stands in for L1 and each case is a fixed history.
 */
import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { replayFromL1, type DepositRecord, type L1, type PostedBatch, type ReplayResult } from "../src/l1.js";
import { applyCertifiedOrder, applyDeposit, newStateTree } from "../src/state.js";
import { encodeCertData } from "../src/certificate.js";
import { decodeOrder } from "../src/order.js";
import { GAS_PER_TX, chainIdForL2 } from "../src/constants.js";

const CHAIN_ID = chainIdForL2(7);
const GAS_PRICE = 10n ** 9n;
const alice = privateKeyToAccount("0x6e5e515000000000000000000000000000000000000000000000000000000000");
const ALICE = getAddress(alice.address);
const BOB = getAddress("0x2b5AD5c4795c026514f8317c7a215E218DcCD6cF");
const CRS = 10n ** 18n;

/** A real signed order. The replay does not verify signatures, so a
 *  certificate with none still exercises the certificate path. */
function order(sequence: bigint, to: Address, amount: bigint): Promise<Hex> {
  return alice.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce: Number(sequence),
    gasPrice: GAS_PRICE,
    gas: GAS_PER_TX,
    to,
    value: amount,
  });
}

/** Deposit-only history: batch i credits deposit i and claims the root that
 *  produces. Certificates are covered by the conformance vectors; what is
 *  under test here is the cursor, not the transition. */
function history(n: number): { batches: PostedBatch[]; deposits: DepositRecord[] } {
  const deposits: DepositRecord[] = [];
  for (let i = 0; i < n; i++) {
    deposits.push({ index: BigInt(i), recipient: i % 2 === 0 ? ALICE : BOB, amount: BigInt(i + 1) * CRS });
  }
  const tree = newStateTree();
  const batches: PostedBatch[] = [];
  let pre = tree.root();
  for (let i = 0; i < n; i++) {
    applyDeposit(tree, deposits[i].recipient, deposits[i].amount);
    const post = tree.root();
    batches.push({
      id: BigInt(i),
      preStateRoot: pre,
      postStateRoot: post,
      certDataHash: "0x" as Hex,
      stepRootsHash: "0x" as Hex,
      epoch: 0n,
      certCount: 0n,
      depositCount: 1n,
      depositsFrom: BigInt(i),
      poster: ALICE,
      postedAt: BigInt(i + 1),
      invalidated: false,
      certData: "0x" as Hex,
      stepRoots: [post],
      depositsThrough: BigInt(i + 1),
    });
    pre = post;
  }
  return { batches, deposits };
}

/**
 * A history that actually populates `orders` and `rejected`.
 *
 * Batch 0 credits Alice. Each later batch carries one certificate: `good`
 * batches carry a payment that applies, the `bad` batch carries one at a
 * sequence the account has not reached, which the transition rejects. Without
 * this, every test ran on `certData: "0x"` and the two accumulators the cursor
 * has to carry forward were empty by construction, so dropping either one
 * passed the whole suite.
 */
async function certHistory(
  kinds: ("good" | "bad")[],
): Promise<{ batches: PostedBatch[]; deposits: DepositRecord[] }> {
  const deposits: DepositRecord[] = [{ index: 0n, recipient: ALICE, amount: 1000n * CRS }];
  const tree = newStateTree();
  const batches: PostedBatch[] = [];

  applyDeposit(tree, ALICE, deposits[0].amount);
  batches.push({
    ...blank(0n, tree.root(), tree.root()),
    depositCount: 1n,
    depositsFrom: 0n,
    depositsThrough: 1n,
  });

  let seq = 0n;
  for (let i = 0; i < kinds.length; i++) {
    const pre = tree.root();
    // A bad certificate names a sequence two ahead, so the transition refuses
    // it and the sender's state does not move.
    const raw = await order(kinds[i] === "good" ? seq : seq + 2n, BOB, CRS);
    const decoded = await decodeOrder(raw, CHAIN_ID);
    const applied = applyCertifiedOrder(tree, decoded).applied;
    if (applied) seq++;
    const id = BigInt(i + 1);
    batches.push({
      ...blank(id, pre, tree.root()),
      certCount: 1n,
      depositsFrom: 1n,
      depositsThrough: 1n,
      certData: encodeCertData([{ epoch: 0n, order: raw, signatures: [] }]),
    });
  }
  return { batches, deposits };
}

function blank(id: bigint, pre: Hex, post: Hex): PostedBatch {
  return {
    id,
    preStateRoot: pre,
    postStateRoot: post,
    certDataHash: "0x" as Hex,
    stepRootsHash: "0x" as Hex,
    epoch: 0n,
    certCount: 0n,
    depositCount: 0n,
    depositsFrom: 0n,
    poster: ALICE,
    postedAt: id + 1n,
    invalidated: false,
    certData: "0x" as Hex,
    stepRoots: [post],
    depositsThrough: 0n,
  };
}

function stubL1(batches: PostedBatch[], deposits: DepositRecord[]): { l1: L1; scans: () => number } {
  let scans = 0;
  const l1 = {
    async readBatches() {
      scans++;
      return batches;
    },
    async readDeposits() {
      return deposits;
    },
  };
  return { l1: l1 as unknown as L1, scans: () => scans };
}

describe("the ingest cursor", () => {
  it("advances to the same state a cold rebuild reaches", async () => {
    const { batches, deposits } = history(4);
    const cold = await replayFromL1(stubL1(batches, deposits).l1, 1, undefined);

    const two = await replayFromL1(stubL1(batches.slice(0, 2), deposits).l1, 1, undefined);
    const warm = await replayFromL1(stubL1(batches, deposits).l1, 1, two);

    expect(warm.root).toBe(cold.root);
    expect(warm.applied.map((b) => b.id)).toEqual(cold.applied.map((b) => b.id));
    expect(warm.rejected).toEqual(cold.rejected);
    expect(warm.mismatch).toBeUndefined();
    // The tree is mutated rather than replaced, which is what lets the anchored
    // validator keep holding the same object across ticks.
    expect(warm.tree).toBe(two.tree);
  });

  it("does nothing when there is nothing new", async () => {
    const { batches, deposits } = history(3);
    const first = await replayFromL1(stubL1(batches, deposits).l1, 1, undefined);
    const again = await replayFromL1(stubL1(batches, deposits).l1, 1, first);
    expect(again.root).toBe(first.root);
    expect(again.applied).toHaveLength(3);
    // Identity, not just equality. A cold rebuild reaches the same root from
    // the same history, so asserting the root alone cannot tell reuse from a
    // rebuild, and the predicate could reject an equal-length history without
    // any test noticing.
    expect(again.tree).toBe(first.tree);
  });

  it("rebuilds rather than advances when a rollback shortens the history", async () => {
    const { batches, deposits } = history(3);
    const before = await replayFromL1(stubL1(batches, deposits).l1, 1, undefined);

    // A challenge invalidated batch 1, so 1 and 2 are gone and the live history
    // is one batch long. Advancing here would keep the discarded deposits.
    const live = batches.slice(0, 1);
    const after = await replayFromL1(stubL1(live, deposits).l1, 1, before);
    const cold = await replayFromL1(stubL1(live, deposits).l1, 1, undefined);

    expect(after.root).toBe(cold.root);
    expect(after.root).not.toBe(before.root);
    expect(after.applied.map((b) => b.id)).toEqual([0n]);
    expect(after.tree).not.toBe(before.tree);
  });

  it("rebuilds rather than advances when a batch's claimed root changed", async () => {
    const { batches, deposits } = history(2);
    const before = await replayFromL1(stubL1(batches, deposits).l1, 1, undefined);

    // Same ids, different content: a reorg on L1, or a stale cache. The prefix
    // check is on the root as well as the id precisely so this is not reused.
    const forked = batches.map((b, i) => (i === 0 ? { ...b, postStateRoot: ("0x" + "11".repeat(32)) as Hex } : b));
    const after = await replayFromL1(stubL1(forked, deposits).l1, 1, before);
    expect(after.tree).not.toBe(before.tree);
    expect(after.mismatch?.batchId).toBe(0n);
  });

  it("survives overlapping advances of the same result", async () => {
    // The regression this exists for: the cursor mutates ONE tree in place, so
    // two overlapping replays both advanced it and applied the same deposits
    // twice. It surfaced as a posted state root no other replayer could
    // reproduce, which reads as a consensus bug rather than a race.
    // Certificates, not deposits. The batch loop awaits `decodeOrder` per
    // certificate, and that await is the only real interleaving point: on a
    // deposit-only history each advance runs straight through and two of them
    // cannot tear each other, so this test passed with the single-use claim
    // removed entirely.
    const { batches, deposits } = await certHistory(["good", "good", "good"]);
    const two = await replayFromL1(stubL1(batches.slice(0, 2), deposits).l1, CHAIN_ID, undefined);
    const cold = await replayFromL1(stubL1(batches, deposits).l1, CHAIN_ID, undefined);

    const { l1 } = stubL1(batches, deposits);
    const [a, b] = await Promise.all([replayFromL1(l1, CHAIN_ID, two), replayFromL1(l1, CHAIN_ID, two)]);

    // One advances, the other rebuilds. Both must be right; neither may
    // re-apply what the other already did.
    expect(a.root).toBe(cold.root);
    expect(b.root).toBe(cold.root);
    expect(a.applied.map((x) => x.id)).toEqual(cold.applied.map((x) => x.id));
    expect(b.applied.map((x) => x.id)).toEqual(cold.applied.map((x) => x.id));
    // No order may be applied twice, which is what a torn advance produces.
    expect(a.orders.length).toBe(cold.orders.length);
    expect(b.orders.length).toBe(cold.orders.length);
  });

  it("carries the whole applied history forward, not just the state", async () => {
    // Six mutations to l1.ts used to pass this file. Three were the carry-over
    // of `orders`, `rejected` and `mismatch`, and dropping `orders` is a real
    // user-visible break: the client reads it to answer
    // eth_getBlockByNumber, so every batch older than the last advance would
    // report an empty transaction list.
    // One applied order AND one rejected certificate must fall BEFORE the
    // split, or the advance rediscovers instead of carrying and a dropped
    // carry-over is invisible. That is exactly how this passed on the first
    // two attempts: with the rejection after the split, and then with nothing
    // applied before it.
    const { batches, deposits } = await certHistory(["good", "bad", "good"]);
    const cold = await replayFromL1(stubL1(batches, deposits).l1, CHAIN_ID, undefined);
    expect(cold.orders.length).toBe(2);
    expect(cold.rejected.length).toBe(1);
    expect(cold.rejected[0].batchId).toBe(2n);

    const three = await replayFromL1(stubL1(batches.slice(0, 3), deposits).l1, CHAIN_ID, undefined);
    expect(three.orders).toHaveLength(1);
    expect(three.rejected).toHaveLength(1);
    const warm = await replayFromL1(stubL1(batches, deposits).l1, CHAIN_ID, three);

    expect(warm.root).toBe(cold.root);
    expect(warm.orders.map((o) => `${o.batchId}:${o.order.hash}`)).toEqual(
      cold.orders.map((o) => `${o.batchId}:${o.order.hash}`),
    );
    expect(warm.rejected).toEqual(cold.rejected);
    // Each batch's transactions must still be attributable to it, which is the
    // property eth_getBlockByNumber actually needs.
    expect(warm.orders.filter((o) => o.batchId === 1n)).toHaveLength(1);
    expect(warm.orders.filter((o) => o.batchId === 3n)).toHaveLength(1);
  });

  it("keeps reporting a root mismatch it found before it advanced", async () => {
    const { batches, deposits } = await certHistory(["good", "good"]);
    // Batch 1 lies about the root it reaches.
    const lying = batches.map((b, i) => (i === 1 ? { ...b, postStateRoot: ("0x" + "22".repeat(32)) as Hex } : b));

    const first = await replayFromL1(stubL1(lying.slice(0, 2), deposits).l1, CHAIN_ID, undefined);
    expect(first.mismatch?.batchId).toBe(1n);

    // Advancing past it must not forget it: a validator that stops reporting
    // the mismatch stops being a witness to it.
    const warm = await replayFromL1(stubL1(lying, deposits).l1, CHAIN_ID, first);
    expect(warm.mismatch?.batchId).toBe(1n);
  });

  it("rebuilds when a batch it applied is no longer live, even if the list grew", async () => {
    // The predicate cannot key on length. Invalidate a middle batch and post
    // two more, and the live list is LONGER than the applied prefix while
    // sharing none of its tail.
    const { batches, deposits } = await certHistory(["good", "good"]);
    const before = await replayFromL1(stubL1(batches, deposits).l1, CHAIN_ID, undefined);
    expect(before.applied).toHaveLength(3);

    // Batch 2 was invalidated; ids are never reused, so what follows is 3 and 4.
    const live = [batches[0], batches[1], { ...batches[2], id: 3n }, { ...batches[2], id: 4n }];
    const after = await replayFromL1(stubL1(live, deposits).l1, CHAIN_ID, before);
    expect(after.tree).not.toBe(before.tree);
    expect(after.applied.map((b) => b.id)).toEqual([0n, 1n, 3n, 4n]);
  });

  it("unapplies a batch whose root does not follow, and says what it should have claimed", async () => {
    const { batches, deposits } = await certHistory(["good", "good"]);
    const honest = await replayFromL1(stubL1(batches, deposits).l1, CHAIN_ID, undefined);
    const lying = batches.map((b, i) => (i === 2 ? { ...b, postStateRoot: ("0x" + "44".repeat(32)) as Hex } : b));

    const r = await replayFromL1(stubL1(lying, deposits).l1, CHAIN_ID, undefined);

    // Stopped at the liar, and holding the state as of the batch before it.
    expect(r.stoppedAt).toBe(2n);
    expect(r.applied.map((b) => b.id)).toEqual([0n, 1n]);
    expect(r.root).toBe(batches[1].postStateRoot);
    // `computed` is what batch 2 SHOULD have claimed, not its pre-state root.
    // Reading it after the rollback gave the pre-state root, which is a
    // different number and no use to a challenger.
    expect(r.mismatch?.computed).toBe(honest.root);
    expect(r.mismatch?.computed).not.toBe(batches[2].preStateRoot);
  });

  it("unapplies a batch whose blob does not decode, deposits included", async () => {
    // The rollback used to happen on the bad-root path only, so this path left
    // the batch's deposits credited and the validator adopted a tree matching
    // neither the honest replay nor the chain.
    const { batches, deposits } = await certHistory(["good"]);
    const extra: DepositRecord = { index: 1n, recipient: BOB, amount: 7n * CRS };
    const broken = [
      batches[0],
      { ...batches[1], certData: "0xdeadbeef" as Hex, depositsThrough: 2n, depositCount: 1n },
    ];

    const r = await replayFromL1(stubL1(broken, [...deposits, extra]).l1, CHAIN_ID, undefined);

    expect(r.stoppedAt).toBe(1n);
    expect(r.applied.map((b) => b.id)).toEqual([0n]);
    // The invariant: the root reached IS the last applied batch's claim.
    expect(r.root).toBe(batches[0].postStateRoot);
    // And the rolled-back deposit is not in the tree.
    expect(r.tree.get(BOB).balance).toBe(0n);
    expect(r.rejected.map((x) => x.batchId)).toEqual([1n]);
  });

  it("does not resume a replay that stopped on an undecodable blob", async () => {
    const { batches, deposits } = history(2);
    // A header claiming an order longer than the blob. Nothing after this batch
    // can be replayed, because the state it starts from is unknown.
    batches[1] = { ...batches[1], certData: ("0x" + "00".repeat(8) + "ffff" + "00".repeat(4)) as Hex };

    const first = await replayFromL1(stubL1(batches, deposits).l1, 1, undefined);
    expect(first.stoppedAt).toBe(1n);
    expect(first.rejected).toHaveLength(1);

    // Resuming would re-reject batch 1 on every tick and grow `rejected`
    // without bound. It rebuilds instead, so the count stays put.
    const second = await replayFromL1(stubL1(batches, deposits).l1, 1, first);
    expect(second.stoppedAt).toBe(1n);
    expect(second.rejected).toHaveLength(1);
    expect(second.tree).not.toBe(first.tree);
  });
});
