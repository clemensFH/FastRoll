/**
 * The valid parameters of every method, as spec/SPEC.md "Parameters of
 * requests" gives them, and the one check every server runs before its handler.
 *
 * The spec defines only what a valid request looks like, and everything else
 * is -32602. Checking that here, once, is what makes every implementation
 * answer a malformed request the same way. Before this, the TypeScript and
 * Rust references disagreed on 18 of 106 malformed requests, and an answer
 * was whatever each parsing library happened to do.
 */
import { RpcFault } from "./jsonrpc.js";

export type ParamType =
  | "integer"
  | "address"
  | "hash"
  | "bytes"
  | "boolean"
  | "block"
  | "certificate"
  | "any";

/** One parameter: its type, and whether it may be left out (`?` in the spec). */
export interface Param {
  type: ParamType;
  optional?: boolean;
}

/** A surface's methods and their parameters, in order. */
export type Surface = Record<string, Param[]>;

const req = (type: ParamType): Param => ({ type });
const opt = (type: ParamType): Param => ({ type, optional: true });

export const FASTPAY_PARAMS: Surface = {
  fastpay_info: [],
  fastpay_handleOrder: [req("bytes"), opt("integer")],
  fastpay_handleCertificate: [req("certificate")],
  fastpay_accountInfo: [req("address")],
};

export const VAPI_PARAMS: Surface = {
  vapi_info: [],
  vapi_account: [req("address")],
  vapi_pending: [],
  vapi_certificates: [opt("any")],
  vapi_health: [],
  vapi_syncNow: [],
  vapi_postNow: [],
};

export const CLIENT_PARAMS: Surface = {
  eth_chainId: [],
  net_version: [],
  web3_clientVersion: [],
  eth_accounts: [],
  eth_blockNumber: [],
  eth_getBalance: [req("address"), opt("any")],
  eth_getTransactionCount: [req("address"), opt("any")],
  eth_sendRawTransaction: [req("bytes")],
  eth_getTransactionReceipt: [req("hash")],
  // cast sends the transaction and a block tag, as Ethereum nodes accept.
  eth_estimateGas: [opt("any"), opt("any")],
  eth_gasPrice: [],
  eth_getBlockByNumber: [opt("block"), opt("boolean")],
  eth_getBlockByHash: [req("hash"), opt("boolean")],
  fpc_status: [],
  fpc_withdrawCalldata: [req("address"), req("integer")],
  // eth_feeHistory and eth_maxPriorityFeePerGas take any parameters and always
  // fail with -32004, so they are deliberately not listed here.
};

export const PROVER_PARAMS: Surface = {
  prover_status: [],
  prover_scanNow: [],
  prover_observeVote: [req("integer"), req("bytes"), req("bytes")],
  prover_observeOrder: [req("bytes")],
};

const U64_MAX = (1n << 64n) - 1n;
const HEX = /^0x[0-9a-fA-F]+$/;
const TAGS = new Set(["latest", "pending", "safe", "finalized", "earliest"]);

/** An integer is `0x` and at least one hex digit, at most 2^64 - 1, as Ethereum writes quantities. */
function isInteger(v: unknown): boolean {
  return typeof v === "string" && HEX.test(v) && BigInt(v) <= U64_MAX;
}

const isBytes = (v: unknown): boolean => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v);

export function isOfType(type: ParamType, v: unknown): boolean {
  switch (type) {
    case "integer":
      return isInteger(v);
    case "address":
      return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
    case "hash":
      return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
    case "bytes":
      return isBytes(v);
    case "boolean":
      return typeof v === "boolean";
    case "block":
      return (typeof v === "string" && TAGS.has(v)) || isInteger(v);
    case "certificate": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const keys = Object.keys(v).sort().join(",");
      const c = v as { epoch?: unknown; order?: unknown; signatures?: unknown };
      return (
        keys === "epoch,order,signatures" &&
        isInteger(c.epoch) &&
        isBytes(c.order) &&
        Array.isArray(c.signatures) &&
        c.signatures.every(isBytes)
      );
    }
    case "any":
      return true;
  }
}

/**
 * Check one request's parameters against its method's row, or throw -32602.
 *
 * Returns the parameters with every optional `null` turned into `undefined`,
 * because the spec says a `null` in an optional place counts as left out, so a
 * handler only ever has to test for `undefined`.
 */
export function checkParams(method: string, list: Param[], params: unknown[]): unknown[] {
  const bad = (why: string) => new RpcFault(-32602, `${method}: ${why}`);
  if (params.length > list.length) {
    throw bad(`takes at most ${list.length} parameter${list.length === 1 ? "" : "s"}, got ${params.length}`);
  }
  return list.map((p, i) => {
    const v = params[i];
    if (v === undefined || v === null) {
      if (p.optional) return undefined;
      throw bad(`parameter ${i + 1} (${p.type}) is required`);
    }
    if (!isOfType(p.type, v)) throw bad(`parameter ${i + 1} is not a valid ${p.type}: ${JSON.stringify(v).slice(0, 80)}`);
    return v;
  });
}
