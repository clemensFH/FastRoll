/**
 * L2 transaction decoding. FROZEN.
 *
 * An L2 transaction IS a standard Ethereum legacy transaction, so students sign
 * with `cast send` and their L1 key is their L2 key on every rollup. There is no
 * custom signing scheme to get wrong.
 *
 * Decoding is strict, and it is strict about the ENCODING as well as the
 * contents. Equivocation is defined as same sender, same sequence, different
 * bytes, so any second encoding of one order is a way to accuse an honest
 * validator of signing twice. See the canonicality check below.
 */
import {
  decodeAbiParameters,
  serializeTransaction,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerializedLegacy,
} from "viem";
import { GAS_PER_TX, WITHDRAW_PRECOMPILE, ZERO_ADDRESS } from "./constants.js";

export type TxKind = "transfer" | "withdraw";

export interface L2Tx {
  raw: Hex;
  /** keccak256(rlp(signedTx)) - the identifier cast polls receipts by. */
  hash: Hex;
  sender: Address;
  nonce: bigint;
  gasPrice: bigint;
  gas: bigint;
  to: Address;
  value: bigint;
  data: Hex;
  chainId: number;
  kind: TxKind;
  /** transfer: the L2 recipient. withdraw: the L1 recipient. */
  recipient: Address;
  /** gasPrice * GAS_PER_TX. Pure function of signed data, so a fraud proof
   *  reproduces it exactly. Sequencer policy sets only the accepted minimum. */
  fee: bigint;
}

export class InvalidTxError extends Error {}

/** The largest nonce any decoder accepts: 2^53 - 1, the largest viem decodes. */
export const MAX_NONCE = (1n << 53n) - 1n;

/** n / 2 for secp256k1. Signatures above this are the malleable twin of one
 *  below it, and EIP-2 made them invalid on Ethereum for the same reason. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function req(cond: boolean, msg: string): void {
  if (!cond) throw new InvalidTxError(msg);
}

/**
 * Decode and fully validate one raw transaction.
 * @param expectedChainId chainIdForL2(myL2Id). A mismatch is fatal: without the
 *        check, one signed tx replays on every rollup in the class.
 */
export async function decodeL2Tx(raw: Hex, expectedChainId: number): Promise<L2Tx> {
  const parsed = parseTransaction(raw);
  req(parsed.type === "legacy", "not a legacy transaction");
  req(parsed.chainId === expectedChainId, "wrong chainId");

  /**
   * The encoding must be the ONLY encoding of this transaction.
   *
   * viem re-serialises canonically before hashing, so it happily accepts a
   * redundant leading zero on an integer, a long-form list header where a short
   * one would do, or trailing bytes after the list. Every one of those decodes
   * to the same transaction with the same sender and a DIFFERENT
   * keccak256(raw).
   *
   * That is fatal here, because equivocation is defined as "same sender, same
   * sequence, different bytes". Without this check anyone who sees an honest
   * signed order can re-encode it, pair the two, and have the validator that
   * signed the original slashed for equivocating. An honest prover would
   * submit that proof automatically, which is what makes it worth the bytes.
   *
   * Re-serialising and comparing is the whole fix, and it is cheap.
   */
  const { r, s: sig, v, yParity, ...unsigned } = parsed as Record<string, unknown>;
  req(
    serializeTransaction(unsigned as never, { r, s: sig, v, yParity } as never) === raw,
    "non-canonical encoding: this transaction has another encoding with the same sender",
  );

  /**
   * Low-s only, per EIP-2.
   *
   * (r, s) and (r, n - s) are both valid signatures over the same message with
   * the same signer, so the high-s twin is a second encoding that survives the
   * canonicality check above. ecrecover does not reject it and neither does
   * viem, so it has to be rejected here.
   */
  req(sig != null && BigInt(sig as string) <= SECP256K1_HALF_N, "signature is not low-s");

  const gasPrice = parsed.gasPrice ?? 0n;
  const gas = parsed.gas ?? 0n;
  const value = parsed.value ?? 0n;
  const data = (parsed.data ?? "0x") as Hex;
  /**
   * Every integer bounded here, at decode, to exactly what the leaf and the
   * on-chain decoder can hold.
   *
   * Not for tidiness. Solidity holds the nonce as uint64 and the value and fee
   * as uint128, and a cast there truncates. So an order whose nonce is 2^64 + n,
   * or whose fee does not fit uint128, is a no-op here and could apply on
   * chain, and an honest poster is slashed for the difference. Refusing to
   * decode makes it a no-op in both places. And gas is exactly GAS_PER_TX, as
   * the spec says, because a second legal gas value is a second encoding of
   * the same payment.
   */
  req(gas === GAS_PER_TX, `gas must be exactly ${GAS_PER_TX}`);
  // 2^53 - 1, not the leaf's uint64: viem refuses a larger nonce in
  // parseTransaction already, and the other decoders match it.
  req(BigInt(parsed.nonce ?? 0) <= MAX_NONCE, "nonce above 2^53 - 1");
  req(value < 1n << 128n, "value does not fit uint128");
  req(gasPrice * GAS_PER_TX < 1n << 128n, "fee does not fit uint128");
  req(parsed.to != null, "missing to");

  const to = getAddress(parsed.to as Address);
  const sender = await recoverTransactionAddress({
    serializedTransaction: raw as TransactionSerializedLegacy,
  });

  let kind: TxKind;
  let recipient: Address = ZERO_ADDRESS;

  if (to.toLowerCase() === WITHDRAW_PRECOMPILE.toLowerCase()) {
    kind = "withdraw";
    // Exactly one ABI word, as RLPTx.sol requires. viem would also read the
    // first word of a longer payload, and an order that decodes here but not
    // on chain applies here and is a no-op there.
    req(data.length === 2 + 64, "withdraw data must be exactly one 32-byte word");
    const [l1recipient] = decodeAbiParameters([{ type: "address" }], data);
    recipient = getAddress(l1recipient as Address);
    req(recipient !== ZERO_ADDRESS, "withdraw to zero address");
    req(value > 0n, "withdraw of zero value");
  } else {
    kind = "transfer";
    req(data === "0x", "transfer must carry no data");
    req(to !== ZERO_ADDRESS, "transfer to zero address");
    // Reserved precompiles are handled above; nothing else may be a recipient.
    recipient = to;
  }

  return {
    raw,
    hash: keccak256(raw),
    sender: getAddress(sender),
    nonce: parsed.nonce != null ? BigInt(parsed.nonce) : 0n,
    gasPrice,
    gas,
    to,
    value,
    data,
    chainId: expectedChainId,
    kind,
    recipient,
    fee: gasPrice * GAS_PER_TX,
  };
}

