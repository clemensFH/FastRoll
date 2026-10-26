/**
 * Protocol constants. FROZEN.
 *
 * FastPay parameters follow the paper: 3f+1 authorities with a 2f+1 quorum.
 * With 7 validators, f = 2 and a certificate is 5 signatures.
 */
import type { Address } from "viem";

export const COMMITTEE_SIZE = 7;
/** Byzantine tolerance. floor((n-1)/3) */
export const MAX_FAULTY = 2;
/** Signatures required for a certificate. 2f+1 */
export const QUORUM = 5;

/** chainId = CHAIN_ID_BASE + l2Id, so a signed order cannot replay across L2s. */
export const CHAIN_ID_BASE = 90000;
export function chainIdForL2(l2Id: number): number {
  return CHAIN_ID_BASE + l2Id;
}

/** Every transfer is one operation, so gas used is constant and the fee is a
 *  pure function of the signed order. */
export const GAS_PER_TX = 21000n;


/** Reserved addresses trigger flows instead of crediting a balance. Their
 *  leaves must stay permanently empty. */
export const WITHDRAW_PRECOMPILE: Address = "0x00000000000000000000000000000000000000fe";
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const RESERVED_ADDRESSES: readonly Address[] = [ZERO_ADDRESS, WITHDRAW_PRECOMPILE];

export function isReserved(addr: Address): boolean {
  const a = addr.toLowerCase();
  return RESERVED_ADDRESSES.some((r) => r.toLowerCase() === a);
}

/** Epoch length in L1 blocks. Committee for epoch e+1 is snapshotted at the
 *  last block of epoch e. Changeable; 1000 is a starting point. */
export const EPOCH_BLOCKS = 1000n;

/** Epochs a departing validator's stake stays locked. Must exceed the window
 *  in which an equivocation proof can still be submitted, which must exceed
 *  the window in which that epoch's certificates can still be posted. */
export const UNBONDING_EPOCHS = 3n;

export function epochOf(l1Block: bigint): bigint {
  return l1Block / EPOCH_BLOCKS;
}

/** Padding leaf for list-Merkle roots. */
export const LIST_PAD = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
