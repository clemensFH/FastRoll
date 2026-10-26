/**
 * Transfer orders. FROZEN.
 *
 * A FastPay transfer order IS a legacy Ethereum transaction. That is what keeps
 * `cast send` and MetaMask working with no custom signing scheme, and it means a
 * student's L1 key is their L2 key.
 *
 * The mapping onto the paper:
 *
 *   sender(O)     ecrecover of the transaction
 *   sequence(O)   the transaction nonce
 *   amount(O)     the transaction value
 *   recipient(O)  `to`, or the L1 address in `data` when `to` is the withdraw
 *                 precompile
 *
 * A correct user signs exactly one order per sequence number. Two orders at
 * that sequence bearing the same sender signature strand that sender until the
 * next epoch boundary, and harm nobody else, so there is nothing to prove.
 *
 * The definition still matters, because the same comparison identifies a
 * VALIDATOR that signed twice, and that is provable.
 */
import { keccak256, type Address, type Hex } from "viem";
import { WITHDRAW_PRECOMPILE } from "./constants.js";
import { decodeL2Tx, type L2Tx } from "./tx.js";

export type OrderKind = "transfer" | "withdraw";

export interface TransferOrder {
  /** The signed legacy transaction, verbatim. This is the canonical form. */
  raw: Hex;
  /** keccak256(raw). Identifies the order everywhere. */
  hash: Hex;
  sender: Address;
  /** The paper's sequence(O). */
  sequence: bigint;
  amount: bigint;
  kind: OrderKind;
  /** transfer: the L2 recipient. withdraw: the L1 recipient. */
  recipient: Address;
  gasPrice: bigint;
  fee: bigint;
}

export class InvalidOrderError extends Error {}

/**
 * Decode and authenticate an order.
 *
 * @param expectedChainId chainIdForL2(l2Id). Without this check one signed
 *        order replays on every L2 in the class.
 */
export async function decodeOrder(raw: Hex, expectedChainId: number): Promise<TransferOrder> {
  let tx: L2Tx;
  try {
    tx = await decodeL2Tx(raw, expectedChainId);
  } catch (e) {
    throw new InvalidOrderError(e instanceof Error ? e.message : String(e));
  }

  const kind: OrderKind = tx.to.toLowerCase() === WITHDRAW_PRECOMPILE.toLowerCase() ? "withdraw" : "transfer";

  return {
    raw,
    hash: tx.hash,
    sender: tx.sender,
    sequence: tx.nonce,
    amount: tx.value,
    kind,
    recipient: tx.recipient,
    gasPrice: tx.gasPrice,
    fee: tx.fee,
  };
}

/** Two orders that prove their shared sender equivocated. */
export function isEquivocation(a: TransferOrder, b: TransferOrder): boolean {
  return (
    a.sender.toLowerCase() === b.sender.toLowerCase() &&
    a.sequence === b.sequence &&
    a.hash !== b.hash
  );
}


export function orderHash(raw: Hex): Hex {
  return keccak256(raw);
}
