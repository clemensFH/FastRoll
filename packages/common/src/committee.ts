/**
 * Committee and epoch helpers. FROZEN.
 *
 * The committee for epoch e+1 is the top COMMITTEE_SIZE stakers snapshotted at
 * the last L1 block of epoch e. Boundaries are a fixed block interval, which is
 * what makes "which set was current when this was signed" answerable.
 */
import { getAddress, type Address } from "viem";
import { COMMITTEE_SIZE, EPOCH_BLOCKS, QUORUM, UNBONDING_EPOCHS, epochOf } from "./constants.js";

export interface Stake {
  validator: Address;
  amount: bigint;
}

export interface Committee {
  epoch: bigint;
  members: Address[];
}

/**
 * Deterministic top-N selection.
 *
 * Ties break on the address, ascending, so every observer computes the same
 * committee from the same stakes. Without a tie rule, two honest nodes can
 * disagree about the committee and nothing works.
 */
export function selectCommittee(stakes: readonly Stake[], size = COMMITTEE_SIZE): Address[] {
  return [...stakes]
    .sort((a, b) => {
      if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
      return BigInt(a.validator) < BigInt(b.validator) ? -1 : 1;
    })
    .slice(0, size)
    .map((s) => getAddress(s.validator));
}

export function isMember(committee: readonly Address[], who: Address): boolean {
  const k = who.toLowerCase();
  return committee.some((m) => m.toLowerCase() === k);
}

export function hasQuorum(signerCount: number): boolean {
  return signerCount >= QUORUM;
}

/** First L1 block of an epoch. */
export function epochStart(epoch: bigint): bigint {
  return epoch * EPOCH_BLOCKS;
}

/** Block at which epoch `e`'s committee was snapshotted, namely the last block
 *  of the previous epoch. */
export function snapshotBlock(epoch: bigint): bigint {
  return epoch === 0n ? 0n : epochStart(epoch) - 1n;
}

/** Can an equivocation from `epoch` still be punished at `now`? */
export function stillSlashable(epoch: bigint, nowBlock: bigint): boolean {
  return epochOf(nowBlock) <= epoch + UNBONDING_EPOCHS;
}

export { epochOf };
