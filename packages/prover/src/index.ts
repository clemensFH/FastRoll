#!/usr/bin/env tsx
/**
 * Fraud prover.
 *
 * Watches L1, judges what it is told, and submits proofs. There are five things
 * it can prove, and they differ in what evidence they need:
 *
 *   invalid certificate    L1 alone. Recheck the signatures the poster skipped.
 *   bad certificate step   L1 alone. Replay the published batch and compare.
 *   bad deposit step       L1 alone. Same.
 *   validator equivocation two votes from one validator on conflicting orders.
 *   unfunded signature     one vote, plus the finalized balance from L1.
 *
 * The first three need nothing but L1, which is the point of publishing batch
 * data at all. The last two need votes, and a vote is only ever seen by whoever
 * asked for it. So clients report the votes they gathered, and the prover judges.
 * That division is natural rather than a workaround: the client is the only
 * party that talks to the whole committee, and the prover is the only party that
 * wants the bounty. Validators also publish their own vote on their pending
 * order, which the prover polls as a second source.
 */
import { getAddress, keccak256, type Address, type Hex } from "viem";
import {
  L1,
  RpcFault,
  applyCertifiedOrder,
  applyDeposit,
  decodeCertData,
  decodeOrder,
  epochOf,
  ConfigError,
  isMain,
  loadConfig,
  signingKey,
  isEquivocation,
  newStateTree,
  replayFromL1,
  recoverVoter,
  rpcCall,
  verifyCertificate,
  serveRpc,
  PROVER_PARAMS,
  type Handler,
  type StateTree,
  type TransferOrder,
} from "@atbt/common";

export type FraudKind =
  | "invalid-certificate"
  | "bad-certificate-step"
  | "bad-deposit-step"
  | "validator-equivocation"
  | "unfunded-signature";

export interface Detection {
  kind: FraudKind;
  /** Who loses: a validator, or the poster of a batch. */
  subject: Address;
  detail: string;
  /** Set once the proof landed on L1, null until then. */
  txHash: Hex | null;
  /** Why the submission failed, null if it did not. */
  error: string | null;
}

interface Vote {
  epoch: bigint;
  order: Hex;
  signature: Hex;
  validator: Address;
}

export interface ProverOptions {
  l1: L1;
  chainId: number;
  /** Validator public endpoints, for polling pending orders. */
  peers: string[];
  log?: (msg: string) => void;
}

export function createProver(opts: ProverOptions) {
  const log = opts.log ?? (() => {});
  const { l1, chainId } = opts;

  /** Every order we have ever seen, by hash. */
  const orders = new Map<Hex, TransferOrder>();
  /** Votes, keyed by validator and then by epoch and order hash. The epoch is
   *  part of the key because the same order is legitimately re-signed after a
   *  boundary, and those are two votes, not one. */
  const votes = new Map<string, Map<string, Vote>>();
  const detections: Detection[] = [];
  const done = new Set<string>();
  /** How many batches were invalidated last time we looked, so a rollback is
   *  detectable. Counting invalidations rather than live batches, because an
   *  invalidation followed by new posts inside one scan interval leaves the
   *  live count where it was. */
  let lastInvalidated: number | null = null;
  /** The epoch in which the latest rollback was seen, if any. A vote from that
   *  epoch or earlier is never judged as unfunded at all, on sequence or on
   *  balance. See `noticeRollbacks`. */
  let lastRollbackEpoch: bigint | null = null;
  const peers = [...opts.peers];

  function remember(order: TransferOrder): void {
    orders.set(order.hash, order);
  }

  /**
   * Record a vote, from wherever it came: a client's report or a validator's
   * pending slot. Where and when it was seen does not matter, because what a
   * vote can be judged against is decided by the epoch it is signed for. See
   * `noticeRollbacks`.
   */
  async function observeVote(epoch: bigint, raw: Hex, signature: Hex): Promise<Address> {
    const order = await decodeOrder(raw, chainId);
    remember(order);
    const validator = await recoverVoter(chainId, epoch, raw, signature);
    const key = validator.toLowerCase();
    if (!votes.has(key)) votes.set(key, new Map());
    votes.get(key)!.set(`${epoch}:${order.hash}`, { epoch, order: raw, signature, validator });
    return validator;
  }

  /** Pull pending orders, and each validator's own vote on its pending order,
   *  from the committee. The paper publishes pending so anyone can drive a
   *  stalled transfer or audit the authority. */
  async function pollPending(): Promise<void> {
    // Clients report the votes they gathered, and that is the main source:
    // validators do not aggregate, so nobody else ever holds two validators'
    // votes on one order. fastpay_accountInfo is the second source: every
    // validator publishes its pending order with its own vote on it.
    // TODO(task-3): gather evidence from the committee
    throw new Error("TODO(task-3): gather evidence from the committee");
  }

  /** Only a member's vote is evidence against it: anyone may vote. */
  async function isMember(epoch: bigint, who: Address): Promise<boolean> {
    const committee = (await l1.committeeOf(epoch)) ?? [];
    return committee.some((a) => a.toLowerCase() === who.toLowerCase());
  }

  function record(found: Omit<Detection, "txHash" | "error">): Detection | null {
    const d: Detection = { ...found, txHash: null, error: null };
    const key = `${d.kind}:${d.subject.toLowerCase()}:${d.detail}`;
    if (done.has(key)) return null;
    done.add(key);
    detections.push(d);
    return d;
  }


  async function submit(d: Detection, target: string, args: unknown[]): Promise<void> {
    // Call your own Gateway. Whether the call reverts matters: a proof your own
    // contract rejects is one you should not have built.
    // TODO(task-3): submit one proof
    throw new Error("TODO(task-3): submit one proof");
  }

  // --------------------------------------------------------- L1-only fraud

  /**
   * Recheck every posted certificate against its epoch committee.
   *
   * postBatch does not verify signatures, on purpose: charging every honest
   * post for five ecrecovers per certificate would price fraud that almost
   * never happens into the common path. The check lives here instead, which
   * means a poster can put an invented certificate on chain and it stays there
   * until somebody looks. Somebody is this function.
   */
  async function scanCertificateValidity(): Promise<void> {
    // A posted certificate that never had a quorum behind it. postBatch does
    // not check signatures, so this is reachable and it is meant to be.
    // TODO(task-3): find forged certificates
    throw new Error("TODO(task-3): find forged certificates");
  }

  /**
   * Replay every posted batch and find the first step whose published root is
   * wrong.
   *
   * The replay walks the same order the contract's proofs assume: deposits
   * first, one step each, then certificates in blob order. A mismatch anywhere
   * means the poster staked its bond on arithmetic it got wrong.
   */
  async function scanTransitions(): Promise<void> {
    // Replay each step yourself and compare. A no-op step leaves the root
    // unchanged, and claiming that is TRUE, so there is nothing to prove
    // about an order the transition rejected.
    // TODO(task-3): find batches whose roots do not follow
    throw new Error("TODO(task-3): find batches whose roots do not follow");
  }

  // ------------------------------------------------------- evidence-based fraud

  /** One validator voting for two conflicting orders in one epoch. */
  async function scanValidatorEquivocation(): Promise<void> {
    // Same signer, same epoch, same sender, same sequence, different order
    // bytes: exactly isEquivocation, within one epoch.
    // TODO(task-3): find validators that signed twice
    throw new Error("TODO(task-3): find validators that signed twice");
  }

  /**
   * A vote for an order the finalized state could not afford.
   *
   * This proof only exists because validators sign against the finalized root.
   * Under the paper's semantics a validator's balance view is unobservable, so
   * the same misbehaviour is auditable and never provable.
   */
  async function scanUnfundedSignatures(finalized: StateTree, batchId: bigint): Promise<void> {
    // The one most likely to slash somebody honest. A vote commits to no state
    // root, so YOU choose which state to judge it against, and a free choice
    // lets a challenger hunt for a state that makes an honest vote look bad.
    // TODO(task-3): find votes the state could not afford
    throw new Error("TODO(task-3): find votes the state could not afford");
  }

  /**
   * Notice when a batch has been invalidated.
   *
   * Invalidating a batch discards every batch after it, so balances can go DOWN
   * and sequences can go BACK. A vote that was perfectly funded when it was
   * cast then looks unfunded against the new tip, and one cast at the next
   * sequence of a state that was rolled back looks like a vote at a sequence
   * the account never reached. Neither argument for judging a vote, the
   * sequence or the balance, survives a rollback.
   *
   * This is not hypothetical. It slashed six honest validators on the first run
   * of the rollback scenario, immediately after correctly slashing the liar,
   * which is the exact failure the whole system exists to prevent.
   *
   * The fix is an epoch rather than throwing the vote pool away, and not a
   * timestamp of when a vote was seen. An honest validator signs only in the
   * current epoch, so a vote for an epoch after the one the rollback was seen in
   * was certainly cast after it, however late it is reported, and every other
   * vote is not judged as unfunded at all. Two earlier versions keyed this on
   * when the prover first SAW a vote instead, and both broke: a client that
   * reports late, or a sender that holds its votes back until after a
   * rollback, makes "seen after" say nothing about "cast after".
   *
   * Equivocation is not affected, because of a validator rule rather than by
   * luck: a rollback can rewind a sequence, but an honest validator keeps the
   * votes it cast in the current epoch and, at a sequence it already signed
   * at, signs only the same order again until the epoch ends. So two votes
   * from one validator for different orders at one sequence in one epoch are
   * equivocation whether or not a rollback came between them, and discarding
   * them would lose real proofs. Only unfunded-signature judgement, on
   * sequence and balance alike, is epoch-bound.
   */
  async function noticeRollbacks(): Promise<void> {
    // Invalidating a batch discards every batch after it, so evidence gathered
    // against the old tip is not evidence any more.
    // TODO(task-3): re-judge evidence after a rollback
    throw new Error("TODO(task-3): re-judge evidence after a rollback");
  }

  /** One pass over everything. Exposed so grading never waits on a timer. */
  async function scanNow(): Promise<Detection[]> {
    // One pass over everything: find the five kinds of fraud, build the
    // witnesses your proofs want, submit them, and return ONLY what this pass
    // found. The grader counts new detections per pass.
    //
    // spec/SPEC.md section 3 says what must be provable and, more usefully,
    // what must NOT be. A prover that slashes an honest validator is worse
    // than one that misses fraud, and one graded scenario is an entirely
    // honest run where you must stay silent.
    // TODO(task-3): scanNow
    throw new Error("TODO(task-3): scanNow");
  }

  const handler: Handler = async (method, params) => {
    // spec/SPEC.md gives the five methods and their exact envelopes,
    // which matter because the grader parses them. prover_status is also
    // the readiness probe.
    // TODO(task-3): the prover_ surface
    throw new Error("TODO(task-3): the prover_ surface");
  };

  return { handler, scanNow, observeVote, detections: () => detections };
}

// ------------------------------------------------------------------- helpers

/** A detection on the wire: every field present, null when there is nothing
 *  in it, as for everything on the wire. */
function wire(d: Detection) {
  return { kind: d.kind, subject: d.subject, txHash: d.txHash, detail: d.detail, error: d.error };
}

// A Merkle witness for one account. Which ROOT it is taken against is
// the part worth thinking about: get it wrong and your own Gateway
// rejects the proof. `packages/common` gives you the tree and its
// proof format; nothing here shapes how you use them.


// The recipient's witness is taken against the root AFTER the sender
// update, because update order is part of the protocol.

// -------------------------------------------------------------------- runner

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.role !== "prover") {
    throw new ConfigError(`this is the prover, but the config says role ${cfg.role}`);
  }
  if (!cfg.l1) throw new ConfigError("a prover needs an l1 section: there is nothing to watch");

  const l1 = new L1({
    rpcUrl: cfg.l1.rpcUrl,
    gateway: cfg.l1.gateway,
    registry: cfg.l1.registry,
    chainId: cfg.l1.chainId,
    privateKey: signingKey(cfg),
  });

  const prover = createProver({
    l1,
    chainId: cfg.l2.chainId,
    peers: cfg.peers,
    log: (m) => console.log(`[${cfg.name}] ${m}`),
  });

  serveRpc(prover.handler, cfg.listen.port, false, PROVER_PARAMS);
  console.log(`[${cfg.name}] watching ${l1.cfg.gateway} chainId=${cfg.l2.chainId} rpc=:${cfg.listen.port}`);
  console.log(`[${cfg.name}] reward address ${l1.account?.address}`);

  // `intervals.scanMs`. The grader sets it to an hour and drives every pass by
  // hand, so nothing it grades depends on a timer. One pass must not overlap
  // the next.
  // TODO(task-3): scan on the configured interval
  throw new Error("TODO(task-3): scan on the configured interval");
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  });
}
