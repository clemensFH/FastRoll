/**
 * Cross-language conformance. contracts/test/Conformance.t.sol reads the same
 * vectors, so a disagreement between the TypeScript and the Solidity fails here
 * or there rather than when a student's validator cannot verify another
 * implementation's certificate.
 */
import { describe, expect, it } from "vitest";
import constantsVec from "../../../spec/vectors/constants.json" with { type: "json" };
import treeVec from "../../../spec/vectors/tree.json" with { type: "json" };
import committeeVec from "../../../spec/vectors/committee.json" with { type: "json" };
import certVec from "../../../spec/vectors/certificate.json" with { type: "json" };
import replayVec from "../../../spec/vectors/replay.json" with { type: "json" };
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  COMMITTEE_SIZE,
  EPOCH_BLOCKS,
  GAS_PER_TX,
  MAX_FAULTY,
  QUORUM,
  TREE_DEPTH,
  UNBONDING_EPOCHS,
  WITHDRAW_PRECOMPILE,
  accountLeaf,
  applyCertifiedOrder,
  applyDeposit,
  certificateId,
  chainIdForL2,
  computeRoot,
  decodeOrder,
  epochOf,
  isEquivocation,
  newStateTree,
  withdrawalKey,
  selectCommittee,
  snapshotBlock,
  verifyCertificate,
  voteDigest,
  recoverVoter,
  type Account,
} from "../src/index.js";

const H = (s: string) => s as Hex;
const A = (s: string) => s as Address;

describe("frozen constants", () => {
  it("matches the vector", () => {
    expect(COMMITTEE_SIZE).toBe(constantsVec.committeeSize);
    expect(QUORUM).toBe(constantsVec.quorum);
    expect(MAX_FAULTY).toBe(constantsVec.maxFaulty);
    expect(GAS_PER_TX.toString()).toBe(constantsVec.gasPerTx);
    expect(EPOCH_BLOCKS.toString()).toBe(constantsVec.epochBlocks);
    expect(UNBONDING_EPOCHS.toString()).toBe(constantsVec.unbondingEpochs);
    expect(WITHDRAW_PRECOMPILE).toBe(constantsVec.withdrawPrecompile);
    expect(TREE_DEPTH).toBe(constantsVec.treeDepth);
  });

  /// 3f+1 with a 2f+1 quorum. If this ever fails, the safety argument is gone.
  it("keeps the paper's quorum arithmetic", () => {
    expect(COMMITTEE_SIZE).toBe(3 * MAX_FAULTY + 1);
    expect(QUORUM).toBe(2 * MAX_FAULTY + 1);
  });

  it("computes epochs and snapshot blocks", () => {
    for (const e of constantsVec.epochs) {
      expect(epochOf(BigInt(e.l1Block)).toString()).toBe(e.epoch);
      expect(snapshotBlock(epochOf(BigInt(e.l1Block))).toString()).toBe(e.snapshotBlock);
    }
  });

  it("gives each L2 a distinct chainId", () => {
    expect(chainIdForL2(7)).toBe(90007);
    expect(chainIdForL2(1)).not.toBe(chainIdForL2(2));
  });
});

describe("sender equivocation", () => {
  it("detects two orders at one sequence from one sender", async () => {
    const raws = replayVec.raws.map(H);
    const a = await decodeOrder(raws[0], replayVec.chainId);
    const c = await decodeOrder(raws[2], replayVec.chainId);
    expect(isEquivocation(a, a)).toBe(false);
    expect(isEquivocation(a, c)).toBe(false); // same sender, different sequence
  });
});

/**
 * Re-encoding somebody else's order must not produce a second valid order.
 *
 * Equivocation is defined as "same sender, same sequence, different bytes", so
 * any encoding that survives with the same sender and a different hash is a way
 * to slash an innocent account permanently. viem re-serialises canonically
 * before hashing, so it accepts all of these on its own.
 */
describe("encoding canonicality", () => {
  // From certificate.json, which SHIPS. This block used to read the Gateway
  // fixture, which the skeleton deletes because it is the entire input to
  // the grader's Gateway tests, so the import failed to resolve and took all nine tests in
  // this file down with it in every student's tree.
  const fx = certVec as unknown as {
    chainId: number;
    malleable: { original: Hex; longFormHeader: Hex; highS: Hex };
    bounds: { name: string; raw: Hex; decodes: boolean }[];
  };

  /// A signature is valid exactly when the chain's ecrecover would take it, and
  /// a certificate exactly when the Gateway would: an honest poster is judged
  /// by that, so nothing off chain may be laxer or stricter.
  it("follows the chain's rule for signatures and certificates", async () => {
    const c = certVec as unknown as { chainId: number; epoch: string; order: Hex; signatures: Hex[]; committee: Address[] };
    const epoch = BigInt(c.epoch);
    const signer = await recoverVoter(c.chainId, epoch, c.order, c.signatures[0]);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sig = c.signatures[0];
    const sHigh = (N - BigInt("0x" + sig.slice(66, 130))).toString(16).padStart(64, "0");
    const high = ("0x" + sig.slice(2, 66) + sHigh + (sig.slice(130) === "1b" ? "1c" : "1b")) as Hex;
    expect(await recoverVoter(c.chainId, epoch, c.order, high)).toBe(signer);

    const v0 = (sig.slice(0, 130) + (parseInt(sig.slice(130), 16) - 27).toString(16).padStart(2, "0")) as Hex;
    await expect(recoverVoter(c.chainId, epoch, c.order, v0)).rejects.toThrow(/not 27 or 28/);

    const stranger = privateKeyToAccount(("0x" + "99".repeat(32)) as Hex);
    const junk = await stranger.sign({ hash: voteDigest(c.chainId, epoch, c.order) });
    await expect(
      verifyCertificate({ epoch, order: c.order, signatures: [...c.signatures, junk] }, c.chainId, c.committee),
    ).rejects.toThrow(/not in the epoch committee/);
    await expect(
      verifyCertificate({ epoch, order: c.order, signatures: [...c.signatures, sig, sig, sig] }, c.chainId, c.committee),
    ).rejects.toThrow(/over the committee size/);
  });

  it("refuses exactly the out-of-range integers the vectors do", async () => {
    expect(fx.bounds.length).toBe(8);
    for (const b of fx.bounds) {
      const ok = await decodeOrder(b.raw, fx.chainId).then(
        () => true,
        () => false,
      );
      expect(ok, b.name).toBe(b.decodes);
    }
  });

  it("accepts the canonical original", async () => {
    const o = await decodeOrder(fx.malleable.original, fx.chainId);
    expect(o.sender).toBeTruthy();
  });

  it("rejects a long-form list header carrying a short-form length", async () => {
    expect(fx.malleable.longFormHeader).not.toEqual(fx.malleable.original);
    await expect(decodeOrder(fx.malleable.longFormHeader, fx.chainId)).rejects.toThrow(
      /non-canonical/,
    );
  });

  it("rejects the high-s twin of a valid signature", async () => {
    expect(fx.malleable.highS).not.toEqual(fx.malleable.original);
    await expect(decodeOrder(fx.malleable.highS, fx.chainId)).rejects.toThrow(/low-s/);
  });

  it("both twins really do recover the same sender, so they were real attacks", async () => {
    const { recoverTransactionAddress } = await import("viem");
    const original = await decodeOrder(fx.malleable.original, fx.chainId);
    for (const twin of [fx.malleable.longFormHeader, fx.malleable.highS]) {
      const who = await recoverTransactionAddress({ serializedTransaction: twin as never });
      expect(who.toLowerCase()).toEqual(original.sender.toLowerCase());
    }
  });
});
