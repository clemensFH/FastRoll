/**
 * Generates spec/vectors/*.json. Run: pnpm vectors
 *
 * These files are the contract between the TypeScript and the Solidity. Both
 * test suites read them, so a hashing convention or bit-ordering disagreement
 * fails CI instead of surfacing when a student's validator cannot verify another
 * implementation's certificate.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import {
  COMMITTEE_SIZE,
  EPOCH_BLOCKS,
  GAS_PER_TX,
  QUORUM,
  SparseMerkleTree,
  TREE_DEPTH,
  UNBONDING_EPOCHS,
  WITHDRAW_PRECOMPILE,
  accountLeaf,
  applyCertifiedOrder,
  applyDeposit,
  certificateId,
  decodeCertData,
  encodeCertData,
  chainIdForL2,
  computeRoot,
  decodeOrder,
  epochOf,
  newStateTree,
  withdrawalKey,
  selectCommittee,
  snapshotBlock,
  verifyCertificate,
  voteDigest,
  type Account,
  type Certificate,
  type TransferOrder,
} from "../src/index.js";

const OUT = new URL("../../../spec/vectors/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const write = (name: string, data: unknown) => {
  writeFileSync(new URL(name, OUT), j(data) + "\n");
  console.log("  spec/vectors/" + name);
};

const L2_ID = 7;
const CHAIN_ID = chainIdForL2(L2_ID);
const GAS_PRICE = 1_000_000_000n;
const START = 10n ** 21n;

// Deterministic actors. Keys 0x01.. so vectors reproduce exactly.
const userKeys = Array.from({ length: 4 }, (_, i) => ("0x" + (i + 1).toString(16).padStart(64, "0")) as Hex);
const users = userKeys.map((k) => privateKeyToAccount(k));
// Validators 0x81.. so they never collide with users.
const valKeys = Array.from(
  { length: COMMITTEE_SIZE },
  (_, i) => ("0x" + (0x81 + i).toString(16).padStart(64, "0")) as Hex,
);
const validators = valKeys.map((k) => privateKeyToAccount(k));

console.log("generating FastPay conformance vectors...");

async function sign(
  from: (typeof users)[number],
  sequence: bigint,
  to: Address,
  amount: bigint,
  data: Hex = "0x",
): Promise<Hex> {
  return from.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce: Number(sequence),
    gasPrice: GAS_PRICE,
    gas: GAS_PER_TX,
    to,
    value: amount,
    data,
  });
}

const withdrawData = (to: Address) => encodeAbiParameters([{ type: "address" }], [to]) as Hex;

/**
 * Two re-encodings of ONE honest order.
 *
 * Both recover the same sender and both hash differently, so without the
 * canonicality checks either could be paired with the original to accuse an
 * innocent validator of signing two conflicting orders. A decoder that accepts
 * them is the bug; these are the two shapes it has to refuse.
 */
async function malleableTwins(victim: Hex): Promise<{ original: Hex; longFormHeader: Hex; highS: Hex }> {
  // 0xf8 LL ... -> 0xf9 00 LL ...: a long-form length for a length one byte
  // carried. The length byte is read off the original rather than assumed,
  // because hardcoding it produced a blob that was merely truncated, which
  // every decoder rejects for the wrong reason.
  if (victim.slice(2, 4) !== "f8") throw new Error(`expected a 0xf8 header, got ${victim.slice(2, 4)}`);
  const longFormHeader = ("0xf900" + victim.slice(4, 6) + victim.slice(6)) as Hex;

  // (r, n - s) with the recovery bit flipped. Same signer, same message.
  const { parseTransaction, serializeTransaction } = await import("viem");
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const parsed = parseTransaction(victim) as unknown as Record<string, unknown>;
  const { r, s: sig, v, yParity, ...unsigned } = parsed;
  void yParity;
  const flipped =
    BigInt(v as bigint) === BigInt(CHAIN_ID) * 2n + 35n
      ? BigInt(CHAIN_ID) * 2n + 36n
      : BigInt(CHAIN_ID) * 2n + 35n;
  const highS = serializeTransaction(unsigned as never, {
    r,
    s: ("0x" + (N - BigInt(sig as string)).toString(16).padStart(64, "0")) as Hex,
    v: flipped,
  } as never) as Hex;

  return { original: victim, longFormHeader, highS };
}

/**
 * Orders on, and one past, every integer bound the decoders enforce.
 *
 * Signed by hand rather than through viem, because viem holds a nonce as a
 * JavaScript number and cannot sign one past 2^53 - 1. Each refused case is one past
 * exactly one bound and otherwise valid, so a decoder that refuses it for any
 * other reason, or accepts it, is caught.
 *
 * These exist because the three decoders disagreed. Solidity truncated the fee
 * and the nonce with a cast while TypeScript held them unbounded, and Rust
 * wrapped `amount + fee`, which let an order for 2^255 pass a balance check.
 */
async function boundsCases(): Promise<{ name: string; raw: Hex; decodes: boolean }[]> {
  const { keccak256, toRlp, numberToHex } = await import("viem");
  const key = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
  const int = (n: bigint): Hex => (n === 0n ? "0x" : numberToHex(n));
  const sign = async (
    nonce: bigint,
    gasPrice: bigint,
    gas: bigint,
    value: bigint,
    to: Hex = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
    data: Hex = "0x",
  ): Promise<Hex> => {
    const body = [int(nonce), int(gasPrice), int(gas), to, int(value), data];
    const unsigned = toRlp([...body, int(BigInt(CHAIN_ID)), "0x", "0x"]);
    const sig = await key.sign({ hash: keccak256(unsigned) });
    const rr = BigInt("0x" + sig.slice(2, 66));
    const ss = BigInt("0x" + sig.slice(66, 130));
    const yParity = BigInt(parseInt(sig.slice(130, 132), 16) - 27);
    return toRlp([...body, int(BigInt(CHAIN_ID) * 2n + 35n + yParity), int(rr), int(ss)]);
  };
  const MAX_NONCE = (1n << 53n) - 1n;
  const U128 = (1n << 128n) - 1n;
  const maxPrice = U128 / GAS_PER_TX;
  const word = encodeAbiParameters([{ type: "address" }], ["0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"]);
  return [
    { name: "every integer on its bound", raw: await sign(MAX_NONCE, maxPrice, GAS_PER_TX, U128), decodes: true },
    { name: "nonce one past 2^53 - 1", raw: await sign(MAX_NONCE + 1n, 1n, GAS_PER_TX, 1n), decodes: false },
    { name: "value one past uint128", raw: await sign(0n, 1n, GAS_PER_TX, U128 + 1n), decodes: false },
    { name: "gasPrice whose fee is past uint128", raw: await sign(0n, maxPrice + 1n, GAS_PER_TX, 1n), decodes: false },
    { name: "gas one above GAS_PER_TX", raw: await sign(0n, 1n, GAS_PER_TX + 1n, 1n), decodes: false },
    { name: "gas one below GAS_PER_TX", raw: await sign(0n, 1n, GAS_PER_TX - 1n, 1n), decodes: false },
    { name: "withdraw data of exactly one word", raw: await sign(0n, 1n, GAS_PER_TX, 1n, WITHDRAW_PRECOMPILE, word), decodes: true },
    { name: "withdraw data one word too long", raw: await sign(0n, 1n, GAS_PER_TX, 1n, WITHDRAW_PRECOMPILE, (word + "00".repeat(32)) as Hex), decodes: false },
  ];
}

// ------------------------------------------------------------- constants.json
{
  write("constants.json", {
    description: "frozen protocol parameters, mirrored in contracts/src/lib/Protocol.sol",
    committeeSize: COMMITTEE_SIZE,
    quorum: QUORUM,
    maxFaulty: 2,
    chainIdBase: 90000,
    l2Id: L2_ID,
    chainId: CHAIN_ID,
    gasPerTx: GAS_PER_TX.toString(),
    epochBlocks: EPOCH_BLOCKS.toString(),
    unbondingEpochs: UNBONDING_EPOCHS.toString(),
    withdrawPrecompile: WITHDRAW_PRECOMPILE,
    treeDepth: TREE_DEPTH,
    epochs: [0n, 1n, 999n, 1000n, 1001n, 12_345n].map((b) => ({
      l1Block: b.toString(),
      epoch: epochOf(b).toString(),
      snapshotBlock: snapshotBlock(epochOf(b)).toString(),
    })),
  });
}

// ------------------------------------------------------------------ tree.json
{
  const tree = newStateTree();
  const seeded: { address: Address; nextSequence: string; balance: string; leaf: Hex }[] =
    [];
  for (let i = 0; i < users.length; i++) {
    const a: Account = { nextSequence: BigInt(i), balance: START + BigInt(i) };
    tree.set(users[i].address, a);
    seeded.push({
      address: users[i].address,
      nextSequence: a.nextSequence.toString(),
      balance: a.balance.toString(),
      leaf: accountLeaf(a),
    });
  }
  const root = tree.root();
  const target = users[1].address;
  const compressed = tree.prove(target);
  const uncompressed = tree.decompress(compressed);
  const absent = getAddress("0x00000000000000000000000000000000dead0001");
  const absentProof = tree.prove(absent);

  write("tree.json", {
    description: "sparse Merkle tree over the address space, 160 levels, LSB-first",
    treeDepth: TREE_DEPTH,
    emptyLeaf: tree.emptyLeaf,
    emptyRoot: tree.emptyHashes[TREE_DEPTH],
    emptyHashesFirst4: tree.emptyHashes.slice(0, 4),
    accounts: seeded,
    root,
    inclusion: {
      address: target,
      leaf: accountLeaf(tree.get(target)),
      compressed: { bitmap: compressed.bitmap.toString(), siblings: compressed.siblings },
      uncompressed: { bitmap: uncompressed.bitmap.toString(), siblings: uncompressed.siblings },
      note: "both encodings must verify to the same root",
    },
    absence: {
      address: absent,
      leaf: tree.emptyLeaf,
      compressed: { bitmap: absentProof.bitmap.toString(), siblings: absentProof.siblings },
    },
  });

  if (computeRoot(target, accountLeaf(tree.get(target)), compressed, tree.emptyLeaf) !== root) {
    throw new Error("compressed inclusion proof does not verify");
  }
  if (computeRoot(target, accountLeaf(tree.get(target)), uncompressed, tree.emptyLeaf) !== root) {
    throw new Error("uncompressed inclusion proof does not verify");
  }
  if (computeRoot(absent, tree.emptyLeaf, absentProof, tree.emptyLeaf) !== root) {
    throw new Error("absence proof does not verify");
  }
}

// ------------------------------------------------------------ committee.json
{
  const stakes = validators.map((v, i) => ({
    validator: v.address,
    // Deliberate tie between the last two, to pin the tie-break rule.
    amount: i >= COMMITTEE_SIZE - 2 ? 5n * 10n ** 18n : BigInt(20 - i) * 10n ** 18n,
  }));
  // 0x...aa ties with the last two as well, so three validators compete for
  // the last two seats and the tie-break decides who sits, not just the order.
  const extra = [
    { validator: getAddress("0x00000000000000000000000000000000000000aa"), amount: 5n * 10n ** 18n },
    { validator: getAddress("0x00000000000000000000000000000000000000bb"), amount: 1n * 10n ** 18n },
  ];
  write("committee.json", {
    description: "top-N stake selection, ties broken on the address ascending",
    stakes: [...stakes, ...extra].map((s) => ({ ...s, amount: s.amount.toString() })),
    committee: selectCommittee([...stakes, ...extra]),
    note: "three validators tie at 5 CRS for the last two seats, so the two lowest addresses sit and the highest does not",
  });
}

// ----------------------------------------------------------- certificate.json
{
  const order = await sign(users[0], 0n, users[1].address, 5n * 10n ** 18n);
  const epoch = 3n;
  const digest = voteDigest(CHAIN_ID, epoch, order);
  const committee = validators.map((v) => v.address);

  const signatures: Hex[] = [];
  for (let i = 0; i < QUORUM; i++) {
    signatures.push(await validators[i].sign({ hash: digest }));
  }
  const cert: Certificate = { epoch, order, signatures };
  const signers = await verifyCertificate(cert, CHAIN_ID, committee);

  write("certificate.json", {
    description: "vote digest, certificate, certificate identity, and encoding canonicality",
    chainId: CHAIN_ID,
    // Canonicality lives here rather than in the Gateway fixture, because it
    // is a Task 1 property of order DECODING and the Gateway fixture is
    // deliberately withheld from students. Keeping it there meant the shipped
    // conformance suite imported a file the skeleton deletes, so nine of its
    // tests never ran in a student's tree at all.
    malleable: await malleableTwins(order),
    bounds: await boundsCases(),
    epoch: epoch.toString(),
    order,
    orderHash: (await decodeOrder(order, CHAIN_ID)).hash,
    voteDigest: digest,
    validatorKeys: valKeys,
    committee,
    signatures,
    signers,
    certificateId: certificateId(cert),
    withdrawalKey: withdrawalKey(users[0].address, 0n),
    certData: encodeCertData([cert]),
    certDataTwo: encodeCertData([cert, { ...cert, epoch: epoch + 1n }]),
  });

  // The bounds must hold in the generator's own decoder before they are
  // published as the answer.
  for (const b of await boundsCases()) {
    const ok = await decodeOrder(b.raw, CHAIN_ID).then(() => true, () => false);
    if (ok !== b.decodes) throw new Error(`bounds case "${b.name}": decodes=${ok}, expected ${b.decodes}`);
  }

  // Round-trip check before anything downstream trusts the blob.
  const back = decodeCertData(encodeCertData([cert, { ...cert, epoch: epoch + 1n }]));
  if (back.length !== 2 || back[0].order !== cert.order || back[1].epoch !== epoch + 1n) {
    throw new Error("certData round trip failed");
  }
}

// -------------------------------------------------------------- replay.json
{
  const tree = newStateTree();
  for (const u of users.slice(0, 3)) applyDeposit(tree, u.address, START);
  const genesisRoot = tree.root();

  const fresh = getAddress("0x00000000000000000000000000000000f0000001");
  const raws: Hex[] = [
    await sign(users[0], 0n, users[1].address, 5n * 10n ** 18n),
    await sign(users[1], 0n, users[2].address, 3n * 10n ** 18n),
    await sign(users[0], 1n, users[0].address, 2n * 10n ** 18n), // self transfer
    await sign(users[2], 0n, fresh, 4_000_000_000_000n), // creates an account
    await sign(users[0], 2n, WITHDRAW_PRECOMPILE, 10n ** 18n, withdrawData(users[3].address)),
  ];

  const steps: unknown[] = [];
  const orders: TransferOrder[] = [];
  for (const raw of raws) {
    const o = await decodeOrder(raw, CHAIN_ID);
    orders.push(o);
    const r = applyCertifiedOrder(tree, o);
    steps.push({
      orderHash: o.hash,
      kind: o.kind,
      sender: o.sender,
      sequence: o.sequence.toString(),
      amount: o.amount.toString(),
      applied: r.applied,
      reason: r.applied ? null : r.reason,
      withdrawal: r.applied && r.withdrawal ? { ...r.withdrawal, amount: r.withdrawal.amount.toString(), sequence: r.withdrawal.sequence.toString() } : null,
      stateRootAfter: tree.root(),
    });
  }

  // Rejection cases, each from a fresh copy so they are independent.
  const rejections: unknown[] = [];
  for (const [name, raw] of [
    ["INVALID_NONCE", await sign(users[0], 99n, users[1].address, 10n ** 18n)],
    ["INSUFFICIENT_BALANCE", await sign(users[1], 1n, users[2].address, START * 100n)],
  ] as const) {
    const probe = tree.clone();
    const o = await decodeOrder(raw, CHAIN_ID);
    const r = applyCertifiedOrder(probe, o);
    rejections.push({
      name,
      orderHash: o.hash,
      applied: r.applied,
      reason: r.applied ? null : r.reason,
      rootUnchanged: probe.root() === tree.root(),
    });
  }

  write("replay.json", {
    description: "state transition replay: a total, deterministic function over certified orders",
    chainId: CHAIN_ID,
    userKeys,
    genesis: { balance: START.toString(), addresses: users.slice(0, 3).map((u) => u.address), root: genesisRoot },
    raws,
    steps,
    postStateRoot: tree.root(),
    accountsTouched: tree.size,
    rejections,
    note: "a rejected order is a complete no-op: no debit, no credit, the sequence does not advance",
  });
}

console.log("done.");
