/**
 * Drives the FastPay protocol on behalf of a sender.
 *
 * The paper calls this a proxy trusted only for liveness. Aggregating votes into
 * a certificate needs no secret, so anyone can do it: the sender, the recipient,
 * a merchant, or a gateway like this one. The sender's only irreplaceable act is
 * signing the order.
 *
 * That is what lets `cast send` and MetaMask work unchanged against a protocol
 * that is not one round trip. The user signs a legacy transaction, this drives
 * everything after it, and the transaction hash comes back as usual.
 */
import type { Address, Hex } from "viem";
import {
  COMMITTEE_SIZE,
  MAX_FAULTY,
  QUORUM,
  decodeOrder,
  recoverVoter,
  rpcCall,
  type Certificate,
  type TransferOrder,
} from "@atbt/common";


export interface Peer {
  url: string;
  /** Filled in from fastpay_info, so a misconfigured peer list is visible. */
  address?: Address;
}

export interface DriveResult {
  order: TransferOrder;
  certificate: Certificate;
  /** Votes gathered, which may exceed the quorum. */
  votes: number;
  /** Peers that refused, with the reason they gave. */
  refusals: { url: string; reason: string }[];
  /** Peers that accepted the finished certificate. */
  confirmed: number;
}

export class NoQuorumError extends Error {
  constructor(
    readonly order: TransferOrder,
    readonly votes: number,
    readonly refusals: { url: string; reason: string }[],
  ) {
    super(
      `only ${votes} of ${QUORUM} votes for ${order.hash}; ` +
        refusals.map((r) => `${r.url}: ${r.reason}`).join("; "),
    );
  }
}

/**
 * The certificate formed, but too few validators accepted it.
 *
 * Not a failed payment: the certificate exists and resending the same order
 * gets the same votes back and broadcasts again. But it is not a success
 * either. With f or fewer acceptances, possibly no honest validator has moved,
 * and a receipt saying otherwise would tell the user their payment is final
 * before any honest node agrees.
 */
export class UnconfirmedError extends Error {
  constructor(
    readonly order: TransferOrder,
    readonly confirmed: number,
    /** Kept, because it is the only way to finish this payment: validators
     *  that already applied it refuse a fresh vote with INVALID_NONCE, so a
     *  resend has to rebroadcast this rather than collect again. */
    readonly certificate: Certificate,
  ) {
    super(
      `certificate for ${order.hash} formed, but only ${confirmed} validators accepted it ` +
        `and more than ${MAX_FAULTY} must; send the same transaction again to rebroadcast it`,
    );
  }
}

/**
 * Wait for `p`, or for `ms`, whichever is first.
 *
 * `rpcCall` itself has no timeout, so without this a validator that accepts
 * the connection and never answers holds the caller for as long as fetch is
 * willing to wait, which is minutes.
 */
export function within<T>(p: Promise<T>, ms: number, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((r) => (timer = setTimeout(() => r(otherwise), ms))),
  ]);
}

/**
 * Resolve as soon as `done` holds for the results so far, or once every
 * promise has settled, with however many results arrived by then.
 *
 * For the waits where enough is enough. The work behind the slow promises is
 * not cancelled, only no longer waited for.
 */
export function until<T>(ps: Promise<T>[], done: (sofar: T[]) => boolean): Promise<T[]> {
  return new Promise((resolve) => {
    const got: T[] = [];
    let settled = 0;
    if (ps.length === 0) resolve(got);
    for (const p of ps) {
      p.then(
        (v) => {
          got.push(v);
        },
        () => undefined,
      ).finally(() => {
        settled++;
        if (done(got) || settled === ps.length) resolve([...got]);
      });
    }
  });
}

function reasonOf(e: unknown): string {
  if (e && typeof e === "object" && "data" in e) {
    const d = (e as { data?: { reason?: string } }).data;
    if (d?.reason) return d.reason;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Collect votes, form a certificate, and hand it back to the committee.
 *
 * Votes are gathered concurrently and the whole committee is asked, not just a
 * quorum. Asking exactly five and stopping means one slow validator stalls a
 * payment that four others already agreed to.
 */
export async function drive(
  peers: Peer[],
  raw: Hex,
  chainId: number,
  epoch: bigint,
  committee: readonly Address[],
  proverUrl?: string,
  pollMs = POLL_TIMEOUT_MS,
): Promise<DriveResult> {
  // One payment, end to end.
  //
  // COLLECT, THEN BROADCAST. Ask every validator for its vote with
  // `fastpay_handleOrder`, keep the signatures, and once you hold five from
  // distinct committee members, send the certificate to every validator with
  // `fastpay_handleCertificate`. Validators never talk to each other: the
  // aggregation is yours, which is what keeps it one round of messages
  // instead of every validator talking to every other.
  //
  // Ask every peer, not five. Asking exactly a quorum and stopping means one
  // slow validator stalls a payment that four others already agreed to.
  //
  // Count committee members, never signatures. A byzantine validator can
  // hand back a junk signature, and a certificate built on it fails at every
  // honest validator.
  //
  // Bound every wait, not only the votes: the certificate broadcast and the
  // prover reports too. A validator that never answers must not hang the
  // payment; with three of them down, no quorum is the right answer.
  //
  // Success needs more than f validators to accept the certificate, or no
  // honest one may have moved and the receipt would be a lie.
  //
  // Collect refusals rather than throwing on the first one. When it fails, the
  // reasons are the whole diagnostic; that is what NoQuorumError is for.
  //
  // Task 3 adds one thing here, and `proverUrl` is why it is a parameter:
  // report each vote to a prover the moment you get it, if one is configured.
  // Report them even when the run FAILED to reach a quorum, because that is
  // exactly when a validator signed two conflicting orders. A prover being
  // down must never stop a payment.
  // TODO(task-1): drive
  const order = await decodeOrder(raw, chainId);
  const members = new Set(committee.map((a) => a.toLowerCase()));

  // One accepted vote per committee member, keyed by the RECOVERED signer:
  // a peer's own claim of who it is proves nothing.
  const votes = new Map<string, Hex>();
  const refusals: { url: string; reason: string }[] = [];

  const ask = async (peer: Peer): Promise<void> => {
    let answer: { signature?: Hex } | null;
    try {
      answer = await within(
        rpcCall<{ signature?: Hex }>(peer.url, "fastpay_handleOrder", [raw, epoch]),
        pollMs,
        null,
      );
    } catch (e) {
      refusals.push({ url: peer.url, reason: reasonOf(e) });
      return;
    }
    if (!answer) {
      refusals.push({ url: peer.url, reason: `no answer within ${pollMs} ms` });
      return;
    }
    const sig = answer.signature;
    if (sig === undefined) {
      refusals.push({ url: peer.url, reason: "answer carried no signature" });
      return;
    }
    // Report every vote, valid for this order or not, to the prover (Task 3).
    // Fire and forget: a prover being down never stops a payment.
    if (proverUrl) {
      void within(rpcCall(proverUrl, "prover_observeVote", [epoch, raw, sig]), pollMs, null).catch(() => {});
    }
    let who: Address;
    try {
      who = await recoverVoter(chainId, epoch, raw, sig);
    } catch (e) {
      refusals.push({ url: peer.url, reason: `bad signature: ${reasonOf(e)}` });
      return;
    }
    if (!members.has(who.toLowerCase())) {
      refusals.push({ url: peer.url, reason: `signer ${who} is not in the committee` });
      return;
    }
    if (!votes.has(who.toLowerCase())) votes.set(who.toLowerCase(), sig);
  };

  // Ask every peer at once and stop waiting as soon as a quorum of distinct
  // members has voted; the stragglers carry on unwaited.
  await until(peers.map(ask), () => votes.size >= QUORUM);

  if (votes.size < QUORUM) throw new NoQuorumError(order, votes.size, [...refusals]);

  const certificate: Certificate = { epoch, order: raw, signatures: [...votes.values()].slice(0, COMMITTEE_SIZE) };
  const confirmed = await broadcast(peers, certificate, pollMs);
  if (confirmed <= MAX_FAULTY) throw new UnconfirmedError(order, confirmed, certificate);

  return { order, certificate, votes: votes.size, refusals: [...refusals], confirmed };
}

/**
 * Send a certificate to every peer, and say how many accepted it.
 *
 * Resolves as soon as n - f = 5 have, or once every peer has answered or run
 * out of time, and the payment succeeds with more than f. Also how a payment that ended in "too few accepted" is
 * finished: sending the same transaction again rebroadcasts its certificate.
 */
export async function broadcast(peers: Peer[], certificate: Certificate, pollMs = POLL_TIMEOUT_MS): Promise<number> {
  // Send the certificate to every peer with fastpay_handleCertificate, each
  // call bounded by pollMs, and count the acceptances. Stop waiting once
  // n - f = 5 have accepted, or all have answered; the rest may carry on
  // unwaited.
  // TODO(task-1): broadcast
  let accepted = 0;
  const send = async (peer: Peer): Promise<void> => {
    const r = await within(
      rpcCall<{ ok?: boolean }>(peer.url, "fastpay_handleCertificate", [certificate]).catch(() => null),
      pollMs,
      null,
    );
    if (r && r.ok === true) accepted++;
  };
  await until(peers.map(send), () => accepted >= QUORUM);
  return accepted;
}

const POLL_TIMEOUT_MS = 8000;

/** Ask each peer who it is. Used to map endpoints to committee addresses. */
export async function identify(peers: Peer[]): Promise<Peer[]> {
  // Ask each peer who it is, so endpoints can be mapped to committee
  // addresses. One unreachable peer must not lose the others: keep what you
  // knew about it rather than dropping it.
  // TODO(task-1): identify
  await Promise.all(
    peers.map(async (peer) => {
      const info = await within(
        rpcCall<{ address?: Address }>(peer.url, "fastpay_info", []).catch(() => null),
        POLL_TIMEOUT_MS,
        null,
      );
      if (info && typeof info.address === "string") peer.address = info.address;
    }),
  );
  return peers;
}
