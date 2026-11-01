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
import { getAddress, type Address, type Hex } from "viem";
import {
  RpcFault,
  paramAddress,
  decodeOrder,
  type TransferOrder,
  fromWire,
  verifyCertificate,
  voteDigest,
  type Certificate,
  type Handler,
  orderHash,
  decodeCertData,
} from "@atbt/common";

import { Refusal, ValidatorInfo, type ValidatorState } from "./state.js";
import { HandleOrderResult, HandleCertResult } from "@atbt/client";

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
  // TODO(task-1): the fastpay_ surface
  
  return async (method: string, params: unknown[]) => {
    console.log("testfastpay");
    switch (method.toLowerCase().split("_")[1]) {

      case "info":
        return state.getInfo();

      case "accountinfo":
        return state.getAccountInfo(params[0] as Address);

      case "handleorder":
        var raw = params[0] as Hex;
        var order = await decodeOrder(raw, state.chainId);
        await state.check(order, BigInt(params[1] as string));
        var hash = orderHash(raw);
        var signature = await signer.sign(raw);

        var result: HandleOrderResult = {
          validator: state.address,
          epoch: `0x${state.epoch}`,
          orderHash: hash,
          signature: signature,
        }

        return result;

      case "handlecertificate":
        var cert = readCert(params[0] as Hex)
        var order = await decodeOrder(cert.order, state.chainId);
        state.confirm(cert, order);

        var res: HandleCertResult = {
          ok: true,
          signers: cert.signatures,
          pooled: 0,
          orderHash: orderHash(cert.order),
        }

        return res;

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  };
}

export interface VapiInfoResult extends ValidatorInfo {
  fianlizedRoot: null,
  lastL1Sync: null,
  pooledCertificates: number,
  kownAccounts: number,
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
  // TODO(task-1): the vapi_ surface
  
  return async (method: string, params: unknown[]) => {
    console.log("testvapi");
    switch (method.toLowerCase().split("_")[1]) {

      case "info":
        var baseInfo = state.getInfo();
        var vapiInfo: VapiInfoResult = {
          name: baseInfo.name,
          address: baseInfo.address,
          mode: baseInfo.mode,
          chainId: baseInfo.chainId,
          epoch: baseInfo.epoch,
          committee: baseInfo.committee,
          fianlizedRoot: null,
          lastL1Sync: null,
          pooledCertificates: state.certPool.size,
          kownAccounts: state.accounts().length,
        }
        return vapiInfo;

      case "account":
        var baseAccInfo = state.getAccountInfo(params[0] as Address);

        return { address: baseAccInfo.address, balance: baseAccInfo.balance, nextSequence: baseAccInfo.nextSequence,
                pending: baseAccInfo.pending };

      case "pending":
        return state.allPending();

      case "health":
        return { ok: true, lastL1Sync: null, stoppedAt: null };
      
      default:
        throw new Error(`Unknown method: ${method}`);
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
