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
// mapped to address
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
  epoch : bigint;
  committee: Address[];
}

export interface AccountInfo extends LedgerAccount {
  address: Address,
  pending: TransferOrder | undefined,
  vote: { epoch: bigint; signature: Hex } | undefined,
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
                      //  address?

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
                        // address?

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
      this.ledger.set(g.address.toLowerCase(), {
        balance: g.balance,
        nextSequence: 0n
      });
    }
  }

  getInfo(): ValidatorInfo {
    var info: ValidatorInfo = {
      name: this.name,
      address: this.address,
      mode: this.mode,
      chainId: this.chainId,
      epoch: this.epoch,
      committee: this.committee,
    };
    return info;
  }

  getAccountInfo(account: Address): AccountInfo {
    var ledger = this.account(account);
    var pendingOrder = this.pending.get(account);
    var vote = this.votes.get(account);

    var info: AccountInfo = {
      address: account,
      balance: ledger.balance,
      nextSequence: ledger.nextSequence,
      pending: pendingOrder,
      vote: vote,
    }

    return info;
  }

  // ------------------------------------------------------------- account view

  account(addr: Address): LedgerAccount {
    // One account's balance and next sequence, zero-valued if it has never
    // been seen. In ANCHORED mode this reads the replayed tree instead, which
    // is Task 2.
    // TODO(task-1): account

    var acc = this.ledger.get(addr);

    if (acc === undefined) {
      const newAcc: LedgerAccount = {
        balance: 0n,
        nextSequence: 1n,
      }
      this.ledger.set(addr, newAcc);

      return newAcc;
    }

    return acc;
  }

  pendingOf(addr: Address): TransferOrder | undefined {
    // The pending slot for one sender, if it holds anything.
    // TODO(task-1): pendingOf

    return this.pending.get(addr);
  }

  allPending(): { account: Address; order: TransferOrder }[] {
    // Every pending order. `vapi_pending` publishes this, and so does the
    // prover's evidence gathering.
    // TODO(task-1): allPending
    var res: {account: Address, order: TransferOrder}[] = [];

    this.pending.forEach((order, addr) => {res.push({account: getAddress(addr, this.chainId), order: order})})

    return res;
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
    // TODO(task-1): check

    if (this.epoch !== epoch) {
      const reason: RefusalReason = "WRONG_EPOCH";
      throw new Refusal(reason)
    }

    try {
      await decodeOrder(order.raw, this.chainId)
    }
    catch (error) {
      const reason: RefusalReason = "INVALID_FORMAT";
      throw new Refusal(reason)
    }
    
    if (order.amount <= 0n) {
      const reason: RefusalReason = "ZERO_AMOUNT";
      throw new Refusal(reason)
    }

    var ledger = this.ledger.get(order.sender);
    if (ledger === undefined || ledger.nextSequence !== order.sequence) {
      const reason: RefusalReason = "INVALID_NONCE";
      throw new Refusal(reason)
    }

    if (ledger.balance < (order.amount + order.fee)) {
      const reason: RefusalReason = "INSUFFICIENT_BALANCE";
      throw new Refusal(reason)
    }

    var pending = this.pending.get(order.sender);
    if (pending !== undefined && pending.raw !== order.raw) {
      const reason: RefusalReason = "CONFLICTING_PENDING";
      throw new Refusal(reason)
    }

    this.pending.set(order.sender, order);

  }

  /** Record that we voted for this order. Idempotent for a re-send. */
  remember(order: TransferOrder): void {
    // Take the pending slot for this sender's sequence. This is the echo in
    // Signed Echo Broadcast, and it is what makes a quorum unable to certify
    // two different orders at one sequence.
    // TODO(task-1): remember
    this.pending.set(order.sender, order);
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
   */
  confirm(cert: Certificate, order: TransferOrder): void {
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
    // TODO(task-1): confirm

    var senderLedger = this.ledger.get(order.sender);
    var recvLedger = this.ledger.get(order.recipient);

    if (senderLedger === undefined || recvLedger === undefined) {
      return;
    }

    var fee = order.fee// * order.gasPrice;
    senderLedger.balance -= (fee + order.amount);
    senderLedger.nextSequence++;

    recvLedger.balance += order.amount;

    this.ledger.set(order.sender, senderLedger);
    this.pending.delete(order.sender);
    this.ledger.set(order.recipient, recvLedger);
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
    // TODO(task-1): accounts
    var addresses: Address[] = [];
    this.ledger.forEach((acc, addr) => {addresses.push(getAddress(addr, this.chainId))})
    return addresses;
  }


}

/** The key of one signed sequence in `ValidatorState.signed`. */
function signedKey(epoch: bigint, sender: Address, sequence: bigint): string {
  return `${epoch}:${sender.toLowerCase()}:${sequence}`;
}
