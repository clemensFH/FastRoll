/**
 * Validator state and the signing rule.
 *
 * Two modes, because Task 1 and Task 2 have genuinely different semantics and
 * the difference is the lesson.
 *
 * STANDALONE (Task 1, no L1). The paper. This validator holds its own account
 * view, credits arrive when a certificate is confirmed, and balances may go
 * temporarily negative. Safety comes from the commutativity of incoming credits,
 * not from a balance check at apply time. There is no state root, so there is no
 * Merkle tree here either, and a plain ledger with signed balances is the honest
 * representation.
 *
 * ANCHORED (Tasks 2 and 3). Signing is evaluated against the finalized L1 state
 * root, replayed from published calldata. That costs instant re-spendability of
 * received funds and caps one account at one transfer per posted batch. It buys
 * a deterministic replay, and decisively it makes "this validator should not
 * have signed" provable on L1. Under paper semantics a validator's balance view
 * is unobservable, so the same misbehaviour is only ever auditable.
 */
import { getAddress, type Address, type Hex } from "viem";
import {
  decodeOrder,
  InvalidOrderError,
  QUORUM,
  type Account,
  type Certificate,
  type StateTree,
  type TransferOrder,
} from "@atbt/common";

export type Mode = "standalone" | "anchored";

/** Why a validator refused to sign. Typed, so a client can react rather than
 *  guess, and so the grader can assert on the reason. */
export type RefusalReason =
  /** The order did not parse, or its encoding is not the canonical one. Not
   *  produced by `check`, which is only reached once an order has decoded: it
   *  is raised where decoding happens, so a malformed order gets a typed
   *  refusal like every other rejection rather than an untyped internal error. */
  | "INVALID_FORMAT"
  | "ZERO_AMOUNT"
  | "INVALID_NONCE"
  | "INSUFFICIENT_BALANCE"
  | "CONFLICTING_PENDING"
  | "WRONG_EPOCH";

export class Refusal extends Error {
  constructor(readonly reason: RefusalReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** Signed balance, because standalone mode permits temporary negatives. */
interface LedgerAccount {
  balance: bigint;
  nextSequence: bigint;
}

export interface ValidatorConfig {
  mode: Mode;
  name: string;
  address: Address;
  chainId: number;
  /** Standalone only: the fixed committee and the genesis allocation. */
  committee?: Address[];
  genesis?: { address: Address; balance: bigint }[];
}

export interface ValidatorInfo {
  name: string;
  address: Address;
  mode: Mode;
  chainId: number;
  epoch: bigint;
  committee: Address[];
}

export interface AccountInfo extends LedgerAccount {
  address: Address;
  pending: TransferOrder | undefined;
  vote: { epoch: bigint; signature: Hex } | undefined;
}

export class ValidatorState {
  readonly mode: Mode;
  readonly chainId: number;
  readonly name: string;
  readonly address: Address;

  /** Anchored: the replayed finalized state. Standalone: unused. */
  tree: StateTree | null = null;
  /** Standalone: this validator's own view. Anchored: unused. */
  private ledger = new Map<string, LedgerAccount>();

  /**
   * The last order this validator signed per account, awaiting confirmation.
   *
   * It locks the SEQUENCE NUMBER, not the account, and it is what turns a
   * plain nonce check into Signed Echo Broadcast on the label
   * (account, next_sequence). Without it a validator could sign two different
   * orders at one sequence and safety is gone.
   *
   * Never part of the committed state. It is per-validator by definition, and
   * it clears at every epoch boundary because the votes it protected expired.
   */
  private pending = new Map<string, TransferOrder>();

  epoch = 0n;
  committee: Address[] = [];

  /**
   * This validator's own vote on each pending order, by account.
   *
   * Published through `fastpay_accountInfo` beside the pending order, so a
   * challenger polling the committee collects votes without waiting for a
   * client to report them. Only ever its OWN signature: a validator holds no
   * one else's, because it does not aggregate.
   */
  votes = new Map<string, { epoch: bigint; signature: Hex }>();

  lastL1Sync: bigint | null = null;
  finalizedRoot: Hex | null = null;
  /** Anchored: the batch the replay stopped at, because its claimed root does
   *  not follow from its contents or its blob does not decode. While set, the
   *  finalized state is unknown past it, so nothing is signed and nothing is
   *  posted. `null` when the replay reached the tip. */
  stoppedAt: bigint | null = null;
  /** Anchored: the epoch this process started in. It restored no `pending`
   *  and no votes, so whatever it signed before a restart is forgotten, and it
   *  signs nothing until that epoch, and every vote in it, is over. `null`
   *  until recorded, which leaves signing unrestricted. */
  startEpoch: bigint | null = null;
  /** Anchored: every order this validator signed, by epoch, sender and
   *  sequence. `pending` is dropped once the finalized state moves past it,
   *  but a rollback can move the state back, and the vote cast at that
   *  sequence in this epoch is still out there: signing a different order at
   *  it would be equivocation. Keyed by epoch, because those votes expire at
   *  the boundary. */
  signed = new Map<string, Hex>();
  /** Anchored: certificates seen but not yet posted to L1. */
  certPool = new Map<string, Certificate>();

  constructor(cfg: ValidatorConfig) {
    this.mode = cfg.mode;
    this.chainId = cfg.chainId;
    this.name = cfg.name;
    this.address = cfg.address;
    if (cfg.committee) this.committee = cfg.committee;
    for (const g of cfg.genesis ?? []) {
      this.ledger.set(addressKey(g.address), { balance: g.balance, nextSequence: 0n });
    }
  }

  getInfo(): ValidatorInfo {
    return {
      name: this.name,
      address: this.address,
      mode: this.mode,
      chainId: this.chainId,
      epoch: this.epoch,
      committee: this.committee,
    };
  }

  /** One account together with this validator's pending order and own vote on it. */
  getAccountInfo(addr: Address): AccountInfo {
    const acc = this.account(addr);
    return {
      address: getAddress(addr),
      balance: acc.balance,
      nextSequence: acc.nextSequence,
      pending: this.pendingOf(addr),
      vote: this.votes.get(addressKey(addr)),
    };
  }

  // ------------------------------------------------------------- account view

  account(addr: Address): LedgerAccount {
    // One account's balance and next sequence, zero-valued if it has never
    // been seen. In ANCHORED mode this reads the replayed tree instead, which
    // is Task 2.

    // A read never creates an account: otherwise every balance query for a
    // random address would grow the ledger (and vapi_info's knownAccounts).
    const acc = this.ledger.get(addressKey(addr));
    return acc ? acc : { balance: 0n, nextSequence: 0n };
  }

  /** The stored account, created on first write. */
  private mutableAccount(addr: Address): LedgerAccount {
    const key = addressKey(addr);
    let acc = this.ledger.get(key);
    if (!acc) {
      acc = { balance: 0n, nextSequence: 0n };
      this.ledger.set(key, acc);
    }
    return acc;
  }

  pendingOf(addr: Address): TransferOrder | undefined {
    // The pending slot for one sender, if it holds anything.

    return this.pending.get(addressKey(addr));
  }

  allPending(): { account: Address; order: TransferOrder }[] {
    // Every pending order. `vapi_pending` publishes this, and so does the
    // prover's evidence gathering.

    return [...this.pending.values()].map((order) => ({ account: getAddress(order.sender), order }));
  }

  // ------------------------------------------------------------ the five checks

  /**
   * Decide whether to sign, and throw a typed Refusal if not.
   *
   * All five must hold. Dropping any one of them is a distinct way to lose
   * safety, and the grader injects a malicious validator for each.
   */
  async check(order: TransferOrder, epoch: bigint): Promise<void> {
    // All five signing rules from spec/SPEC.md, and each one is a scenario.
    //
    // The fifth is the interesting one: `pending` for that sender must be
    // empty, or hold a BYTE-IDENTICAL order. A client that lost the reply
    // will legitimately ask again, and refusing that turns a dropped packet
    // into stuck funds.
    //
    // Throw `Refusal` with a typed reason. A client that has to parse English
    // to know whether to retry will get it wrong.

    //
    // Order of the checks is the spec's "Which refusal reason applies first".
    // INVALID_FORMAT (rule 1) is raised by the caller, where decoding happens.

    if (epoch !== this.epoch) {
      throw new Refusal("WRONG_EPOCH", `asked for epoch ${epoch}, this validator is in ${this.epoch}`);
    }

    // A zero withdrawal already fails to decode, so this only catches transfers.
    if (order.amount <= 0n) {
      throw new Refusal("ZERO_AMOUNT");
    }

    const acc = this.account(order.sender);
    if (order.sequence !== acc.nextSequence) {
      throw new Refusal("INVALID_NONCE", `expected nonce ${acc.nextSequence}, got ${order.sequence}`);
    }

    if (acc.balance < order.amount + order.fee) {
      throw new Refusal("INSUFFICIENT_BALANCE", `balance ${acc.balance} < ${order.amount + order.fee}`);
    }

    // Signed Echo Broadcast on the label (sender, nextSequence): at most one
    // order per label, but a byte-identical re-send is fine.
    const pending = this.pendingOf(order.sender);
    if (pending && pending.raw.toLowerCase() !== order.raw.toLowerCase()) {
      throw new Refusal("CONFLICTING_PENDING", `already signed ${pending.hash} at nonce ${order.sequence}`);
    }
  }

  /** Record that we voted for this order. Idempotent for a re-send. */
  remember(order: TransferOrder, vote?: { epoch: bigint; signature: Hex }): void {
    // Take the pending slot for this sender's sequence. This is the echo in
    // Signed Echo Broadcast, and it is what makes a quorum unable to certify
    // two different orders at one sequence.

    this.pending.set(addressKey(order.sender), order);
    if (vote) this.votes.set(addressKey(order.sender), vote);
  }

  // ------------------------------------------------------------ confirmation

  /**
   * Apply a confirmed certificate.
   *
   * STANDALONE: this is where state moves. Debit the sender, advance the
   * sequence, clear pending, and credit the recipient asynchronously without
   * touching the recipient's sequence. Balances may go negative here, which the
   * paper permits: no value is created or destroyed and incoming credits commute.
   *
   * ANCHORED: state does NOT move. It moves when the certificate is posted to
   * L1 and the replay advances. All this does is pool the certificate for
   * posting and remember that the sequence is spoken for.
   *
   * Returns "applied" when state moved and "repeat" for a nonce that was
   * already applied. Throws `AheadOfLedger` when earlier certificates are
   * missing. The certificate must already have been verified.
   */
  confirm(cert: Certificate, order: TransferOrder): "applied" | "repeat" {
    // A certificate arrived.
    //
    // In STANDALONE mode this is where state moves: debit the sender by
    // amount plus fee, credit the recipient, advance the sequence, and clear
    // the pending slot.
    //
    // Balances may go NEGATIVE here, and working out why is part of Task 1.
    //
    // In ANCHORED mode state does NOT move here, which is Task 2: the
    // certificate is pooled for posting and the state moves when L1 accepts
    // the batch that carries it.

    const sender = this.mutableAccount(order.sender);

    // Already applied: a repeat, answered ok without changing anything. This
    // also covers a DIFFERENT valid certificate at an applied nonce, which can
    // only exist if more than f validators misbehaved.
    if (order.sequence < sender.nextSequence) return "repeat";

    // Earlier certificates are missing; orders apply strictly in nonce order.
    if (order.sequence > sender.nextSequence) throw new AheadOfLedger(sender.nextSequence);

    // No balance check: a certified order is applied whatever the balance.
    sender.balance -= order.amount + order.fee;
    sender.nextSequence += 1n;
    this.pending.delete(addressKey(order.sender));
    this.votes.delete(addressKey(order.sender));

    // A transfer credits the recipient without touching its nonce. A
    // withdrawal credits nobody here: amount and fee are burned (Task 1).
    if (order.kind === "transfer") {
      this.mutableAccount(order.recipient).balance += order.amount;
    }
    return "applied";
  }

  /**
   * Drop pending orders the finalized state has already moved past.
   *
   * Anchored mode needs this and standalone mode does not, which is easy to
   * miss. In standalone mode `confirm` applies the transfer and clears pending
   * in the same step. In anchored mode `confirm` only pools the certificate,
   * state moves later when a batch lands, and nothing was clearing pending
   * afterwards. The effect was that an account could make one transfer per
   * EPOCH rather than one per batch: the next order arrived at a new sequence,
   * pending still held the old one, and the signing rule refused it as
   * conflicting.
   *
   * The condition is deliberately strict. Pending is dropped only once the
   * finalized sequence has moved PAST it, meaning the label
   * (account, that sequence) is spent for good and no vote protecting it can
   * ever be combined into anything. A pending order at a sequence the
   * finalized state has not reached yet is still doing its job and stays.
   */
  prunePending(): void {
    // Drop pending orders the finalized state has moved past.
    //
    // Without this an account is stuck for a whole epoch after its transfer
    // settles: the sequence advanced on L1 but the slot still holds the old
    // order, so the next one looks like a conflict.
    // TODO(task-2): prunePending
    throw new Error("TODO(task-2): prunePending");
  }


  // ------------------------------------------------------------ epoch change

  /**
   * Move to a new epoch.
   *
   * Clearing `pending` is safe precisely because certificates expire at the
   * boundary: the votes it was protecting can no longer be combined into
   * anything. An honest sender whose certificate missed the boundary simply
   * re-collects at the same sequence.
   *
   * The certificate pool clears too, for the same reason. A stale certificate
   * posted after a rotation would be rejected anyway.
   */
  enterEpoch(epoch: bigint, committee: Address[]): boolean {
    // Move to a new epoch. Certificates expire at the boundary, so both the
    // pending slots and the certificate pool go with the old epoch.
    //
    // Return whether the epoch actually changed: callers log on a real
    // handover and must not log once per tick.
    // TODO(task-2): enterEpoch
    throw new Error("TODO(task-2): enterEpoch");
  }

  quorumReached(signatureCount: number): boolean {
    return signatureCount >= QUORUM;
  }

  accounts(): Address[] {
    // Every address this validator knows about.

    return [...this.ledger.keys()].map(k => getAddress(k));
  }


}

/** Ledger, pending and vote maps are keyed by the lowercase address, so a
 *  checksummed and a lowercase spelling of one account are the same account. */
function addressKey(addr: Address | string): string {
  return addr.toLowerCase();
}

/** A certificate for a nonce this validator has not reached yet (-32008). */
export class AheadOfLedger extends Error {
  constructor(readonly nextSequence: bigint) {
    super(`certificate is ahead of this validator; next sequence is ${nextSequence}`);
  }
}

/** The key of one signed sequence in `ValidatorState.signed`. */
function signedKey(epoch: bigint, sender: Address, sequence: bigint): string {
  return `${epoch}:${sender.toLowerCase()}:${sequence}`;
}
