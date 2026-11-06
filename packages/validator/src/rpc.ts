/**
 * The two frozen validator interfaces.
 *
 * `fastpay_` on the public port is the protocol. Clients and other components
 * use it, and it must behave identically whatever language a student writes it
 * in.
 *
 * `vapi_` on a loopback-only port is control and introspection. The grader
 * drives it. It can make a validator sync or post now, which is exactly why it
 * must not be reachable from another machine.
 */
import { type Address, type Hex } from "viem";
import {
  RpcFault,
  decodeOrder,
  fromWire,
  verifyCertificate,
  voteDigest,
  type Certificate,
  type Handler,
  type TransferOrder,
} from "@atbt/common";

import { AheadOfLedger, Refusal, type RefusalReason, type ValidatorState } from "./state.js";

export interface Signer {
  address: Address;
  sign(digest: Hex): Promise<Hex>;
}

/**
 * What a post did, always with all three fields: `batchId` is the new batch's
 * id, or `null` when nothing was posted, and `certificates` is how many were
 * in it, `0` when nothing was posted. A transaction that reverted is not an
 * outcome but an error.
 */
export interface PostOutcome {
  posted: boolean;
  batchId: bigint | null;
  certificates: number;
}

export interface Hooks {
  /**
   * Bond this validator's own stake, if it is not bonded already.
   *
   * A validator stakes itself. `Registry.register()` is permissionless, so
   * nothing stops an operator doing it by hand, but making it part of startup
   * means a validator that cannot bond fails loudly at boot rather than being
   * quietly absent from the next committee.
   */
  bond(stake?: string): Promise<void>;
  /** Force an L1 sync now, so the grader never has to wait on a timer. */
  syncNow(): Promise<void>;
  /** Force a post now, same reason. */
  postNow(): Promise<PostOutcome>;
}

function orderWire(o: { raw: Hex; hash: Hex; sender: Address; sequence: bigint; amount: bigint; kind: string; recipient: Address }) {
  return {
    raw: o.raw,
    hash: o.hash,
    sender: o.sender,
    sequence: o.sequence,
    amount: o.amount,
    kind: o.kind,
    recipient: o.recipient,
  };
}

/** -32001 with the typed reason, the one shape every refusal goes out in. */
function refuse(reason: RefusalReason, message?: string): RpcFault {
  return new RpcFault(-32001, message ?? reason, { reason });
}

/** Decode an order, or refuse with INVALID_FORMAT. */
async function decodeOrRefuse(raw: Hex, chainId: number): Promise<TransferOrder> {
  try {
    return await decodeOrder(raw, chainId);
  } catch (e) {
    throw refuse("INVALID_FORMAT", `INVALID_FORMAT: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The protocol interface. */
export function fastpayHandler(state: ValidatorState, signer: Signer): Handler {
  // fastpay_info, handleOrder, handleCertificate, accountInfo.
  // spec/SPEC.md gives all four and their exact shapes.
  //
  // A validator never talks to another validator. It answers handleOrder
  // with one vote or a typed refusal, and moves state only when somebody
  // hands it a finished certificate. Assembling five votes into that
  // certificate is the client's job, not the committee's.
  //
  // accountInfo publishes `pending` with this validator's own vote on it, so
  // a challenger can collect votes by asking rather than waiting to be told.

  // Parameters reach this handler already checked against FASTPAY_PARAMS
  // (serveRpc does that), so only the protocol rules are judged here.

  return async (method: string, params: unknown[]) => {
    switch (method) {
      case "fastpay_info":
        return state.getInfo();

      case "fastpay_accountInfo": {
        const info = state.getAccountInfo(params[0] as Address);
        return {
          address: info.address,
          balance: info.balance,
          nextSequence: info.nextSequence,
          pending: info.pending
            ? {
                ...orderWire(info.pending),
                epoch: info.vote?.epoch ?? null,
                signature: info.vote?.signature ?? null,
              }
            : null,
        };
      }

      case "fastpay_handleOrder": {
        const raw = params[0] as Hex;
        const epoch = params[1] === undefined ? state.epoch : fromWire(params[1]);

        // Rule 1: the order must decode (signature, chain id, legacy, ...).
        const order = await decodeOrRefuse(raw, state.chainId);
        // Rules 2 to 6.
        try {
          await state.check(order, epoch);
        } catch (e) {
          if (e instanceof Refusal) throw refuse(e.reason, e.message);
          throw e;
        }

        // The vote is a signature over the vote digest, which binds chain,
        // epoch and order. RFC 6979 makes a re-send return the same bytes.
        const signature = await signer.sign(voteDigest(state.chainId, epoch, raw));
        state.remember(order, { epoch, signature });
        return { validator: signer.address, epoch, orderHash: order.hash, signature };
      }

      case "fastpay_handleCertificate": {
        // 1. Shape (-32602).
        const cert = readCert(params[0]);
        // 2. The order decodes (-32001 INVALID_FORMAT).
        const order = await decodeOrRefuse(cert.order, state.chainId);
        // 3. Epoch (-32002).
        if (cert.epoch !== state.epoch) {
          throw new RpcFault(-32002, `certificate is for epoch ${cert.epoch}, this validator is in ${state.epoch}`);
        }
        // 4. Five to seven distinct committee members (-32002).
        let signers: Address[];
        try {
          signers = await verifyCertificate(cert, state.chainId, state.committee);
        } catch (e) {
          throw new RpcFault(-32002, `invalid certificate: ${e instanceof Error ? e.message : String(e)}`);
        }
        // 5. The nonce (-32008 when earlier certificates are missing).
        try {
          state.confirm(cert, order);
        } catch (e) {
          if (e instanceof AheadOfLedger) {
            throw new RpcFault(-32008, e.message, { nextSequence: e.nextSequence });
          }
          throw e;
        }
        return { ok: true, signers, pooled: state.certPool.size, orderHash: order.hash };
      }

      default:
        throw new RpcFault(-32601, `method not found: ${method}`);
    }
  };
}

/** The control and introspection interface. Loopback only. */
export function vapiHandler(state: ValidatorState, hooks: Hooks): Handler {
  // Reads, plus a way to act now instead of on a timer. Nothing else.
  //
  // Task 1: info, account, pending, health.
  // Task 2: certificates, syncNow, postNow.
  //
  // syncNow and postNow exist so grading never waits on a timer: a
  // scenario that depended on which interval fired first would pass on a
  // fast machine and fail on a slow one. info is also the readiness probe.
  //
  // Nothing here may mutate state beyond that. An earlier version could
  // wipe a validator, re-point it at another chain and mint balances, and
  // nothing ever called any of it.

  return async (method: string, params: unknown[]) => {
    switch (method) {
      case "vapi_info":
        return {
          ...state.getInfo(),
          finalizedRoot: state.finalizedRoot,
          lastL1Sync: state.lastL1Sync,
          pooledCertificates: state.certPool.size,
          knownAccounts: state.accounts().length,
        };

      case "vapi_account": {
        const info = state.getAccountInfo(params[0] as Address);
        return {
          address: info.address,
          balance: info.balance,
          nextSequence: info.nextSequence,
          pending: info.pending ? orderWire(info.pending) : null,
        };
      }

      case "vapi_pending":
        return state.allPending().map((p) => ({ account: p.account, order: orderWire(p.order) }));

      case "vapi_health":
        return { ok: state.stoppedAt === null, lastL1Sync: state.lastL1Sync, stoppedAt: state.stoppedAt };

      // Task 2 fills these in. In standalone mode they answer with the
      // empty values the spec gives, and never touch L1.
      case "vapi_certificates":
        return [...state.certPool.values()].map((c) => ({
          epoch: c.epoch,
          order: c.order,
          signatures: c.signatures.length,
        }));

      case "vapi_syncNow":
        if (state.mode === "anchored") await hooks.syncNow();
        return { epoch: state.epoch, finalizedRoot: state.finalizedRoot, lastL1Sync: state.lastL1Sync };

      case "vapi_postNow":
        if (state.mode === "anchored") return hooks.postNow();
        return { posted: false, batchId: null, certificates: 0 };

      default:
        throw new RpcFault(-32601, `method not found: ${method}`);
    }
  };
}

/**
 * The certificate's shape, before anything about its content.
 *
 * Every shape error is -32602, whatever field it is in: an order or a
 * signature that is not 0x-prefixed hex, an epoch that is not an integer, or
 * signatures that are not an array. Only a well-formed certificate goes on to
 * be decoded (-32001), judged (-32002) and placed (-32008).
 */
function readCert(v: unknown): Certificate {
  const shape = (why: string) => new RpcFault(-32602, `expected { epoch, order, signatures }: ${why}`);
  const hexBytes = (x: unknown): x is Hex => typeof x === "string" && /^0x([0-9a-fA-F]{2})*$/.test(x);
  const o = v as { epoch?: unknown; order?: unknown; signatures?: unknown } | null;
  if (!o || typeof o !== "object") throw shape("not an object");
  if (!hexBytes(o.order)) throw shape("order is not 0x-prefixed hex bytes");
  if (!Array.isArray(o.signatures) || !o.signatures.every(hexBytes)) {
    throw shape("signatures is not an array of 0x-prefixed hex bytes");
  }
  let epoch: bigint;
  try {
    epoch = fromWire(o.epoch);
  } catch {
    throw shape("epoch is not an integer");
  }
  if (epoch < 0n || epoch >= 1n << 64n) throw shape("epoch is not a uint64");
  return { epoch, order: o.order, signatures: o.signatures as Hex[] };
}
