/**
 * Validator votes and certificates. FROZEN.
 *
 * A certificate is a transfer order plus QUORUM signatures from a single
 * epoch's committee. It is the object that authorises a state transition, and
 * forming one requires no secret, so anyone can aggregate votes and post it.
 * The paper leans on that: the sender need only sign, and a proxy or the
 * recipient can drive everything else.
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  recoverAddress,
  type Address,
  type Hex,
} from "viem";
import { COMMITTEE_SIZE, QUORUM } from "./constants.js";
import { orderHash } from "./order.js";

/**
 * What a validator signs.
 *
 * The epoch is inside the digest, so a vote cannot be carried across a
 * boundary, and chainId is inside it, so a vote cannot be replayed on another
 * L2. Both matter: certificates expire at the epoch boundary precisely because
 * old votes must become unusable.
 */
export const VOTE_DOMAIN = "FASTPAY_VOTE_V1";

export function voteDigest(chainId: number, epoch: bigint, order: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes32" }],
      [keccak256(new TextEncoder().encode(VOTE_DOMAIN)), BigInt(chainId), epoch, orderHash(order)],
    ),
  );
}

export interface Vote {
  validator: Address;
  signature: Hex;
}

export interface Certificate {
  epoch: bigint;
  /** The signed legacy transaction, verbatim. */
  order: Hex;
  /** At least QUORUM signatures, all from `epoch`'s committee, all distinct. */
  signatures: Hex[];
}

/**
 * The signatures on this set of votes that actually count.
 *
 * Only committee members, only once each. Everything else is discarded rather
 * than rejected, because a stranger's signature is not evidence of anything:
 * anyone can produce one.
 *
 * The client aggregates, so this is the client's check on what came back.
 * Counting `signatures.length` instead of committee members meant five keys
 * from nowhere certified anything, and even one junk signature from a byzantine
 * validator lowered the effective quorum by one, so the certificate the client
 * broadcast failed verification at every honest validator.
 *
 * The length guard comes first and before any recovery, because ecrecover is
 * the expensive part: recovering an attacker-sized array is a way to stall the
 * event loop for as long as they like. A valid certificate can never carry more
 * signatures than there are committee members, so anything larger is refused
 * unread.
 */
export async function committeeSignatures(
  env: Certificate,
  chainId: number,
  committee: readonly Address[],
): Promise<Hex[]> {
  if (env.signatures.length > COMMITTEE_SIZE) {
    throw new InvalidCertificateError(
      `${env.signatures.length} signatures, and a committee has ${COMMITTEE_SIZE} members`,
    );
  }
  const members = new Set(committee.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const sig of env.signatures) {
    let who: string;
    try {
      who = (await recoverVoter(chainId, env.epoch, env.order, sig)).toLowerCase();
    } catch {
      continue; // unrecoverable, so it is not a signature
    }
    if (!members.has(who) || seen.has(who)) continue;
    seen.add(who);
    out.push(sig);
  }
  return out;
}

/** Who signed these votes. */
export async function signersOf(env: Certificate, chainId: number): Promise<Address[]> {
  const out: Address[] = [];
  for (const sig of env.signatures) {
    out.push(await recoverVoter(chainId, env.epoch, env.order, sig));
  }
  return out;
}

export class InvalidCertificateError extends Error {}

/**
 * Who cast this vote.
 *
 * The only place vote recovery lives, so the prover, the grader and the tests
 * cannot drift from each other on how the digest is built. A prover that
 * recovers against the wrong digest sees equivocation everywhere.
 *
 * A signature is 65 bytes, r || s || v, with v 27 or 28, and nothing else.
 * viem would also recover v = 0 or 1, but the chain's ecrecover returns the
 * zero address for those, so a vote accepted here in that form would make a
 * certificate the Gateway judges invalid, and its honest poster slashable.
 */
export async function recoverVoter(
  chainId: number,
  epoch: bigint,
  order: Hex,
  signature: Hex,
): Promise<Address> {
  if (signature.length !== 132) {
    throw new InvalidCertificateError(`signature is ${(signature.length - 2) / 2} bytes, not 65`);
  }
  const v = signature.slice(130).toLowerCase();
  if (v !== "1b" && v !== "1c") throw new InvalidCertificateError(`signature v is 0x${v}, not 27 or 28`);
  return getAddress(await recoverAddress({ hash: voteDigest(chainId, epoch, order), signature }));
}

/**
 * Verify a certificate against a committee: exactly the Gateway's rule, which
 * is what an honest poster is judged by.
 *
 * Every rule here is load-bearing:
 *   - at least QUORUM and at most COMMITTEE_SIZE signatures
 *   - every signature recovers to a member of THIS epoch's committee, or a
 *     boundary becomes a window where the effective quorum is smaller
 *   - signers are distinct, or one validator counts five times
 * A certificate carrying one signature that fails any of these is invalid,
 * however many good ones it also carries, because the chain says so.
 */
export async function verifyCertificate(
  cert: Certificate,
  chainId: number,
  committee: readonly Address[],
): Promise<Address[]> {
  if (cert.signatures.length < QUORUM) {
    throw new InvalidCertificateError(`${cert.signatures.length} signatures, need ${QUORUM}`);
  }
  if (cert.signatures.length > COMMITTEE_SIZE) {
    throw new InvalidCertificateError(`${cert.signatures.length} signatures, over the committee size`);
  }
  const set = new Set(committee.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const signers: Address[] = [];

  for (const sig of cert.signatures) {
    const who = await recoverVoter(chainId, cert.epoch, cert.order, sig);
    const key = who.toLowerCase();
    if (!set.has(key)) throw new InvalidCertificateError(`${who} is not in the epoch committee`);
    if (seen.has(key)) throw new InvalidCertificateError(`${who} signed twice`);
    seen.add(key);
    signers.push(who);
  }
  return signers;
}

/** Identity of a certificate. Two certificates for the same order in the same
 *  epoch are the same certificate regardless of which signatures were gathered. */
export function certificateId(cert: Certificate): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }], [cert.epoch, orderHash(cert.order)]),
  );
}

/**
 * Proof that a validator equivocated: two votes from the same signer, at the
 * same sequence, for different orders.
 *
 * No state and no Merkle witness. Two signatures and a comparison.
 */
export interface EquivocationProof {
  epoch: bigint;
  orderA: Hex;
  signatureA: Hex;
  orderB: Hex;
  signatureB: Hex;
}

/**
 * The blob that goes into L1 calldata, ABI encoded.
 *
 *   (uint64 epoch, bytes order, (bytes32 r, bytes32 s, uint8 v)[] signatures)[]
 *
 * ABI rather than a packed format with hand-written length prefixes, and that
 * is a deliberate reversal.
 *
 * The cost is real and larger than it first looks: 864 bytes against 448 for
 * one certificate, and 40064 against 22400 for fifty, so 79% to 93% more
 * calldata. Almost all of it is ABI padding each one-byte `v` out to a full
 * 32-byte word, which is inherent to the encoding rather than something a
 * better field order would fix.
 *
 * What it buys is that `Protocol.sol` went from seventy lines of offset
 * arithmetic, in two near-identical parsers so that one could avoid reverting,
 * to one `abi.decode` that bounds-checks itself. The same format was also
 * written a second time here, where the two had to agree exactly.
 *
 * Hand-optimising the calldata of a toy project is not the lesson, and given
 * code that is already optimised removes the exercise.
 */
const MAX_UINT64 = (1n << 64n) - 1n;

const CERT_DATA_ABI = parseAbiParameters(
  "(uint64 epoch, bytes order, (bytes32 r, bytes32 s, uint8 v)[] signatures)[]",
);

/** A 65-byte signature as the three fields Solidity wants. */
function splitSignature(sig: Hex): { r: Hex; s: Hex; v: number } {
  if (sig.length !== 132) throw new InvalidCertificateError(`signature is ${(sig.length - 2) / 2} bytes, not 65`);
  return {
    r: ("0x" + sig.slice(2, 66)) as Hex,
    s: ("0x" + sig.slice(66, 130)) as Hex,
    v: parseInt(sig.slice(130, 132), 16),
  };
}

function joinSignature(p: { r: Hex; s: Hex; v: number }): Hex {
  return ("0x" + p.r.slice(2) + p.s.slice(2) + p.v.toString(16).padStart(2, "0")) as Hex;
}

export function encodeCertData(certs: readonly Certificate[]): Hex {
  // The packed encoding could not express more signatures than a byte, so it
  // checked. ABI can express any number, and `postBatch` still refuses more
  // than the committee size, so building such a blob produces calldata the
  // chain rejects. Failing here says which certificate rather than leaving a
  // revert to explain it.
  for (const c of certs) {
    if (c.signatures.length > COMMITTEE_SIZE) {
      throw new InvalidCertificateError(
        `certificate for epoch ${c.epoch} carries ${c.signatures.length} signatures, over the committee size`,
      );
    }
  }
  // Empty is empty, not a 64-byte encoding of an empty array. A batch that
  // only credits deposits carries no certificates, paying 64 bytes to say
  // "nothing" on every such batch would be silly, and the Solidity decoder
  // accepts an empty blob as none. `postBatch` counts the decoded
  // certificates, so both forms mean the same.
  if (certs.length === 0) return "0x";
  return encodeAbiParameters(CERT_DATA_ABI, [
    certs.map((c) => ({
      epoch: c.epoch,
      order: c.order,
      signatures: c.signatures.map(splitSignature),
    })),
  ]);
}

export function decodeCertData(blob: Hex): Certificate[] {
  if (blob === "0x") return [];
  let decoded: readonly {
    epoch: bigint;
    order: Hex;
    signatures: readonly { r: Hex; s: Hex; v: number }[];
  }[];
  try {
    [decoded] = decodeAbiParameters(CERT_DATA_ABI, blob) as [typeof decoded];
  } catch (e) {
    // One error type out, whatever viem threw. Callers distinguish "this blob
    // is not a certificate list" from every other failure, and nothing above
    // here should have to know how the decoder words it.
    throw new InvalidCertificateError(`not an ABI encoded certificate list: ${e instanceof Error ? e.message : e}`);
  }
  return decoded.map((c) => {
    // The decoder is typed but not bounded: a blob with dirty high bits in the
    // epoch word decodes to a number far outside uint64, and a dirty `v` byte
    // produces an odd-length signature. Solidity's decoder refuses both, so
    // nothing from the chain reaches here, but this is a public function and a
    // caller should not have to know that.
    if (c.epoch > MAX_UINT64) {
      throw new InvalidCertificateError(`epoch ${c.epoch} does not fit in uint64`);
    }
    if (c.signatures.length > COMMITTEE_SIZE) {
      throw new InvalidCertificateError(`${c.signatures.length} signatures, over the committee size`);
    }
    return {
      epoch: c.epoch,
      order: c.order,
      signatures: c.signatures.map(joinSignature),
    };
  });
}
