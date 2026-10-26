/**
 * FastPay account state and the state transition. FROZEN.
 *
 * The account state follows the paper: a balance and a next sequence number.
 *
 * A pending order lives only in a validator's memory and never in the committed
 * state. It is per-validator by definition, and it clears at every epoch
 * boundary because the votes it was protecting have expired.
 *
 * There is deliberately nothing here for an equivocating sender. Signing two
 * orders at one sequence strands that sender until the next boundary and harms
 * nobody: a certificate IS the payment, so no counterparty is ever deceived by
 * a half-collected one, and two quorums of five out of seven always share at
 * least three validators, each holding one pending order per sequence, so a
 * double spend cannot form. Punishing it would have cost a bit in this leaf,
 * a branch in both transitions, a whole batch step kind and two proofs, to
 * make self-inflicted harm permanent.
 */
import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { SparseMerkleTree } from "./merkle.js";
import type { TransferOrder } from "./order.js";

export interface Account {
  balance: bigint;
  nextSequence: bigint;
}

export const EMPTY_ACCOUNT: Account = { balance: 0n, nextSequence: 0n };

/** leaf = keccak256(abi.encodePacked(uint64 nextSequence, uint128 balance)) */
export function accountLeaf(a: Account): Hex {
  return keccak256(encodePacked(["uint64", "uint128"], [a.nextSequence, a.balance]));
}

/** Why a certificate did not apply. An honest committee never produces any of
 *  these, so seeing one means a quorum was corrupted. */
export type RejectReason =
  | "INVALID_NONCE"
  | "INSUFFICIENT_BALANCE";

export interface Applied {
  applied: true;
  /** Set for withdrawals. The claim L1 makes claimable. */
  withdrawal?: { sender: Address; sequence: bigint; recipient: Address; amount: bigint };
}
export interface Rejected {
  applied: false;
  reason: RejectReason;
}
export type StepResult = Applied | Rejected;

/**
 * Apply one certified order.
 *
 * TOTAL AND DETERMINISTIC. It never throws and never reverts. A certificate
 * that fails the checks is a complete no-op: no debit, no credit, and the
 * sequence does not advance, so the sender may retry.
 *
 * That containment matters. Under the L1-anchored signing rule every honest
 * validator evaluates these same five checks against the same finalized root,
 * so an honest committee cannot produce a rejected certificate. If one appears,
 * at least QUORUM validators ignored the rule, and the fraud proof slashes them.
 * Meanwhile no funds moved, so the escrow stays solvent while that is sorted out.
 *
 * ORDER MATTERS AND IS PART OF THE PROTOCOL. Debit the sender first, then credit
 * the recipient. The credit must not touch the recipient's sequence number,
 * or receiving a payment would invalidate an outgoing order the recipient
 * already has in flight.
 */
export function applyCertifiedOrder(tree: StateTree, order: TransferOrder): StepResult {
  const sender = tree.get(order.sender);

  if (sender.nextSequence !== order.sequence) return { applied: false, reason: "INVALID_NONCE" };

  const debit = order.amount + order.fee;
  if (sender.balance < debit) return { applied: false, reason: "INSUFFICIENT_BALANCE" };

  tree.set(order.sender, {
    balance: sender.balance - debit,
    nextSequence: sender.nextSequence + 1n,
  });

  if (order.kind === "transfer") {
    const r = tree.get(order.recipient);
    tree.set(order.recipient, {
      balance: r.balance + order.amount,
      nextSequence: r.nextSequence,
    });
    return { applied: true };
  }

  return {
    applied: true,
    withdrawal: {
      sender: order.sender,
      sequence: order.sequence,
      recipient: order.recipient,
      amount: order.amount,
    },
  };
}

/**
 * Credit a deposit arriving from L1.
 *
 * Always applicable, by construction. Whatever a deposit is checked against is
 * checked on L1 at deposit time, so a validator is never trapped between
 * refusing a deposit it must consume and producing an invalid state.
 */
export function applyDeposit(tree: StateTree, recipient: Address, amount: bigint): void {
  const a = tree.get(recipient);
  tree.set(recipient, { balance: a.balance + amount, nextSequence: a.nextSequence, });
}

/** Key L1 uses to prevent a withdrawal being withdrawn twice, matching the
 *  paper's per-account withdraw log. */
/** A tree carrying FastPay accounts. This is the committed L2 state. */
export type StateTree = SparseMerkleTree<Account>;

export function newStateTree(): StateTree {
  return new SparseMerkleTree<Account>(EMPTY_ACCOUNT, accountLeaf);
}

export function withdrawalKey(sender: Address, sequence: bigint): Hex {
  return keccak256(encodePacked(["address", "uint64"], [sender, sequence]));
}
