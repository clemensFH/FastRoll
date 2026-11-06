#!/usr/bin/env tsx
/**
 * FastPay client, and the cast-compatible RPC.
 *
 * This is the whole client story. No custom SDK, no bespoke wallet. A user runs
 * `cast send` or points MetaMask at this endpoint, and the multi-round protocol
 * happens behind a single `eth_sendRawTransaction`.
 *
 * Two omissions are load-bearing rather than lazy: no `eth_feeHistory` and no
 * `baseFeePerGas`. Measured against Foundry 1.4.1, cast asks for feeHistory
 * anyway and needs `--legacy`, but the omissions still matter because under
 * EIP-1559 the charge would depend on a base fee, which is validator state. The
 * fee has to be a pure function of the signed order or the fraud proof cannot
 * reproduce it.
 */
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, type Address, type Hex } from "viem";
import {
  GAS_PER_TX,
  L1,
  MAX_FAULTY,
  decodeCertData,
  decodeOrder,
  RpcFault,
  paramAddress,
  epochOf,
  ConfigError,
  isMain,
  loadConfig,
  gatewayAbi,
  replayFromL1,
  serialiser,
  type ReplayResult,
  rpcCall,
  serveRpc,
  CLIENT_PARAMS,
  type Certificate,
  type Handler,
  type StateTree,
  type TransferOrder,
  QUORUM,
} from "@atbt/common";

import { Remembered } from "./remembered.js";
import { broadcast, drive, identify, NoQuorumError, UnconfirmedError, until, within, type Peer } from "./driver.js";

export * from "./driver.js";
export * from "./remembered.js";

const hex = (v: bigint | number) => ("0x" + BigInt(v).toString(16)) as Hex;

/** Read an integer off the wire. A standalone balance can be negative, and
 *  toWire writes that as "0x-5", which BigInt() refuses. */
function wireInt(v: string): bigint {
  return v.startsWith("0x-") ? -BigInt("0x" + v.slice(3)) : BigInt(v);
}

export interface ClientOptions {
  mode: "standalone" | "anchored";
  chainId: number;
  peers: string[];
  minGasPrice: bigint;
  l1?: { rpcUrl: string; gateway: Address; registry: Address; l1ChainId: number };
  /** Where to report gathered votes. Optional, and a prover being down never
   *  stops a payment. */
  proverUrl?: string;
  /** How long to wait for votes before reporting no quorum. */
  pollMs?: number;
  log?: (msg: string) => void;
}

interface Settled {
  orderHash: Hex;
  sender: Address;
  sequence: bigint;
  to: Address;
  votes: number;
  /** The epoch its certificate was formed in. A certificate expires at the
   *  boundary, so a resend in a later epoch is a fresh collection. */
  epoch: bigint;
  /** Standalone: the synthetic block it settled in, which is the number of
   *  payments this client had settled, itself included. */
  block: bigint;
}

/**
 * Anchored: block n is the live batch with id n, and its hash is
 * keccak256(abi.encode(uint256 id, bytes32 postStateRoot)). Not the root alone,
 * because a batch whose certificates were all no-ops leaves the root where it
 * was, and two blocks would share a hash. Ids of invalidated batches are gaps.
 * Before any batch is live there is one empty block 0, with a hash of zero.
 */
export const batchBlockHash = (id: bigint, postStateRoot: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [id, postStateRoot]));

/**
 * Which anchored block a lookup names, among the live batches in id order: a
 * batch, "genesis" for the empty block 0 before any batch is live, or null.
 * A tag means the tip, `earliest` block 0, a number its id, a hash its hash.
 */
export function selectBlock<B extends { id: bigint; postStateRoot: Hex }>(
  live: readonly B[],
  byHash: boolean,
  wanted: unknown,
): B | "genesis" | null {
  if (byHash) return live.find((b) => batchBlockHash(b.id, b.postStateRoot) === String(wanted).toLowerCase()) ?? null;
  const tip = live.at(-1);
  let height: bigint;
  try {
    height =
      wanted === undefined || wanted === null || ["latest", "pending", "safe", "finalized"].includes(wanted as string)
        ? (tip?.id ?? 0n)
        : wanted === "earliest"
          ? 0n
          : BigInt(wanted as string);
  } catch {
    throw new RpcFault(-32602, `cannot read ${JSON.stringify(wanted)} as a block`);
  }
  const b = live.find((x) => x.id === height);
  if (b) return b;
  return !tip && height === 0n ? "genesis" : null;
}

/** 256 zero bytes, the logsBloom of every receipt and block. */
const ZERO_BLOOM = ("0x" + "00".repeat(256)) as Hex;

/** Standalone's synthetic block hash: the block number, as 32 bytes. */
const syntheticBlockHash = (n: bigint): Hex => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

export function createClient(opts: ClientOptions) {
  const log = opts.log ?? (() => {});
  const peers: Peer[] = opts.peers.map((url) => ({ url }));
  const settled = new Remembered<Settled>();
  /** Certificates formed but taken by too few validators, by order hash, so a
   *  resend can finish them. */
  const formed = new Remembered<Certificate>();
  const l1 = opts.l1
    ? new L1({
        rpcUrl: opts.l1.rpcUrl,
        gateway: opts.l1.gateway,
        registry: opts.l1.registry,
        chainId: opts.l1.l1ChainId,
      })
    : null;

  let finalized: StateTree | null = null;
  let epoch = 0n;
  /** Kept so refresh() advances instead of rebuilding. Without it every
   *  eth_getBalance re-derived the entire chain, which is the single most
   *  expensive thing the client did. */
  let lastReplay: ReplayResult | undefined;

  // Serialised for the same reason the validator's sync is: the replay mutates
  // one tree in place, and two concurrent eth_getBalance calls would otherwise
  // apply the same deposits twice.
  const serialised = serialiser();

  function refresh(): Promise<ReplayResult | undefined> {
    if (!l1) return Promise.resolve(undefined);
    return serialised("refresh", async () => {
      epoch = epochOf(await l1.blockNumber());
      lastReplay = await replayFromL1(l1, opts.chainId, lastReplay);
      finalized = lastReplay.tree;
      return lastReplay;
    });
  }

  /**
   * The committee whose votes count, for the epoch being signed against.
   *
   * Anchored: L1 says, and nothing else is evidence. Standalone: there is no
   * L1, so take the committee that f + 1 validators report, since at least one
   * of those is honest. Believing the first answer would let one byzantine
   * validator name a committee of its own keys.
   */
  async function committeeOf(e: bigint): Promise<Address[]> {
    if (l1) return (await l1.committeeOf(e)) ?? [];
    // Bounded, because a validator that accepts the connection and never
    // answers would otherwise stall every payment before it starts, and done
    // as soon as f + 1 answers agree, so it does not wait for that validator
    // at all.
    const keyOf = (c: Address[]) => c.map((x) => x.toLowerCase()).sort().join(",");
    const agreed = (answers: ({ committee: Address[] } | null)[]): Address[] | null => {
      const tally = new Map<string, { committee: Address[]; n: number }>();
      for (const a of answers) {
        if (!a) continue;
        const t = tally.get(keyOf(a.committee)) ?? { committee: a.committee, n: 0 };
        t.n += 1;
        tally.set(keyOf(a.committee), t);
      }
      for (const t of tally.values()) if (t.n > MAX_FAULTY) return t.committee;
      return null;
    };
    const answers = await until(
      peers.map((p) =>
        within(
          rpcCall<{ committee: Address[] }>(p.url, "fastpay_info", []).catch(() => null),
          budget,
          null,
        ),
      ),
      (sofar) => agreed(sofar) !== null,
    );
    return agreed(answers) ?? [];
  }

  /** How long any one question to a validator may take. */
  const budget = opts.pollMs ?? 8000;

  async function accountOf(who: Address): Promise<{ balance: bigint; nextSequence: bigint }> {
    if (opts.mode === "anchored") {
      await refresh();
      const a = finalized ? finalized.get(who) : { balance: 0n, nextSequence: 0n };
      return { balance: a.balance, nextSequence: a.nextSequence };
    }
    /**
     * Believe a value only as far as f + 1 validators vouch for it.
     *
     * Standalone has no L1, so the validators are the only source, and f of
     * them may lie. Taking the (f+1)-th highest answer means at least one
     * honest validator reported that much or more, so no coalition of f can
     * push the answer above what an honest node holds. Honest validators can
     * lag one another, because certificates reach them at different times, so
     * this reads slightly behind the fastest of them, never ahead of all of
     * them.
     */
    const answers = (
      await Promise.all(
        peers.map((p) =>
          within(
            rpcCall<{ balance: Hex; nextSequence: Hex }>(p.url, "fastpay_accountInfo", [who]).catch(() => null),
            budget,
            null,
          ),
        ),
      )
    ).filter((a): a is { balance: Hex; nextSequence: Hex } => a !== null);
    if (answers.length <= MAX_FAULTY) {
      throw new RpcFault(-32000, `only ${answers.length} validators answered, and ${MAX_FAULTY + 1} must agree`);
    }
    const vouched = (xs: bigint[]): bigint => xs.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))[MAX_FAULTY];
    return {
      balance: vouched(answers.map((a) => wireInt(a.balance))),
      nextSequence: vouched(answers.map((a) => wireInt(a.nextSequence))),
    };
  }

  const handler: Handler = async (method: string, params: unknown[]) => {
    // This is what makes `cast` and MetaMask work, and spec/SPEC.md lists
    // every method. Four things in there are load-bearing and none is
    // obvious:
    //
    // eth_feeHistory and eth_maxPriorityFeePerGas must FAIL, with a message
    // naming --legacy. Omitting baseFeePerGas is not enough: cast still
    // takes the 1559 path and builds a transaction your validators cannot
    // decode as an order.
    //
    // A receipt is null until the state has actually moved. Returning one
    // because a certificate exists tells a user their payment is final
    // before it is.
    //
    // Believe an advanced sequence only when f + 1 peers agree. One
    // validator's word is not evidence when f of them may lie.
    //
    // The synthetic block needs its full field set, including the canonical
    // empty-uncles hash: alloy refuses to deserialise a block without
    // sha3Uncles and prints an error on every poll.
    //
    // Task 2 changes where balances come from: eth_getBalance and
    // eth_getTransactionCount read the finalized state replayed from L1,
    // and eth_getBlockByNumber answers about posted batches.

    switch (method) {
      case "eth_chainId":
      case "net_version":
        return hex(opts.chainId);

      case "web3_clientVersion":
        return "fastroll-client/1.0";

      case "eth_accounts":
        return [];

      case "eth_gasPrice":
        return hex(opts.minGasPrice);

      case "eth_estimateGas":
        return hex(GAS_PER_TX);

      case "eth_feeHistory":
      case "eth_maxPriorityFeePerGas":
        throw new RpcFault(-32004, `${method} is not supported: FastRoll only takes legacy transactions, use --legacy`);

      case "eth_getBalance": {
        const { balance } = await accountOf(params[0] as Address);
        // Ethereum tools read the balance as unsigned.
        return hex(balance < 0n ? 0n : balance);
      }

      case "eth_getTransactionCount":
        return hex((await accountOf(params[0] as Address)).nextSequence);

      case "eth_sendRawTransaction":
        return sendRaw(params[0] as Hex);

      case "eth_getTransactionReceipt": {
        const s = settled.peek(params[0] as Hex);
        if (!s) return null;
        return {
          transactionHash: s.orderHash,
          transactionIndex: "0x0",
          blockNumber: hex(s.block),
          blockHash: syntheticBlockHash(s.block),
          from: s.sender,
          to: s.to,
          cumulativeGasUsed: hex(GAS_PER_TX),
          gasUsed: hex(GAS_PER_TX),
          effectiveGasPrice: hex(opts.minGasPrice),
          contractAddress: null,
          logs: [],
          logsBloom: ZERO_BLOOM,
          status: "0x1",
          type: "0x0",
        };
      }

      case "eth_blockNumber":
        return hex(settledCount);

      case "eth_getBlockByNumber": {
        const tag = params[0];
        let n: bigint;
        if (tag === undefined || ["latest", "pending", "safe", "finalized"].includes(tag as string)) n = BigInt(settledCount);
        else if (tag === "earliest") n = 0n;
        else n = BigInt(tag as string);
        return n <= BigInt(settledCount) ? syntheticBlock(n) : null;
      }

      case "eth_getBlockByHash": {
        const n = BigInt(params[0] as Hex);
        return n <= BigInt(settledCount) && syntheticBlockHash(n) === (params[0] as string).toLowerCase()
          ? syntheticBlock(n)
          : null;
      }

      case "fpc_status":
        await identified();
        return {
          mode: opts.mode,
          chainId: opts.chainId,
          epoch,
          peers: peers.map((p) => ({ url: p.url, address: p.address ?? null })),
          settled: settledCount,
          finalizedRoot: finalized ? finalized.root() : null,
        };

      default:
        throw new RpcFault(-32601, `method not found: ${method}`);
    }
  };

  /** Blocks settled so far: block n is the n-th settled order. */
  let settledCount = 0;

  function syntheticBlock(n: bigint) {
    const Z32 = ("0x" + "00".repeat(32)) as Hex;
    return {
      number: hex(n),
      hash: syntheticBlockHash(n),
      parentHash: syntheticBlockHash(n === 0n ? 0n : n - 1n),
      nonce: "0x0000000000000000",
      sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
      logsBloom: ZERO_BLOOM,
      transactionsRoot: Z32,
      stateRoot: Z32,
      receiptsRoot: Z32,
      miner: "0x0000000000000000000000000000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      size: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      timestamp: hex(Math.floor(Date.now() / 1000)),
      transactions: [],
      uncles: [],
      mixHash: Z32,
    };
  }

  /** Identify the peers once, and again only while some are still unknown. */
  let identifying: Promise<unknown> | null = null;
  function identified(): Promise<unknown> {
    if (peers.some((p) => !p.address) && !identifying) {
      identifying = identify(peers).finally(() => (identifying = null));
    }
    return identifying ?? Promise.resolve();
  }

  /** The committee is fixed in standalone mode, so it is asked for once. */
  let standaloneCommittee: Address[] | null = null;
  async function committeeNow(): Promise<Address[]> {
    if (l1) return committeeOf(epoch);
    if (!standaloneCommittee) {
      const c = await committeeOf(epoch);
      if (c.length > 0) standaloneCommittee = c;
      return c;
    }
    return standaloneCommittee;
  }

  async function sendRaw(raw: Hex): Promise<Hex> {
    let order: TransferOrder;
    try {
      order = await decodeOrder(raw, opts.chainId);
    } catch (e) {
      throw new RpcFault(-32000, `order does not decode: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (order.gasPrice < opts.minGasPrice) {
      throw new RpcFault(-32006, `gas price ${order.gasPrice} is below this client's minimum ${opts.minGasPrice}`, {
        gasPrice: order.gasPrice,
        minGasPrice: opts.minGasPrice,
      });
    }

    if (l1) await refresh();

    // Already settled in this epoch: answer with the same hash, send nothing.
    if (settled.get(order.hash, epoch)) return order.hash;

    const settle = (votes: number) => {
      settledCount += 1;
      settled.set(order.hash, {
        orderHash: order.hash,
        sender: order.sender,
        sequence: order.sequence,
        to: order.recipient,
        votes,
        epoch,
        block: BigInt(settledCount),
      });
      formed.delete(order.hash);
    };
    const tooFew = (confirmed: number, cert: Certificate) => {
      formed.set(order.hash, cert);
      return new RpcFault(-32007, `certificate formed, but only ${confirmed} validators accepted it`, {
        confirmed,
        needed: MAX_FAULTY + 1,
      });
    };

    // A certificate formed earlier but taken by too few: rebroadcast it, since
    // validators that applied it would now refuse a fresh vote.
    const earlier = formed.get(order.hash, epoch);
    if (earlier) {
      const confirmed = await broadcast(peers, earlier, budget);
      if (confirmed <= MAX_FAULTY) throw tooFew(confirmed, earlier);
      settle(earlier.signatures.length);
      log(`settled ${order.hash} on rebroadcast (${confirmed} accepted)`);
      return order.hash;
    }

    const committee = await committeeNow();
    try {
      const r = await drive(peers, raw, opts.chainId, epoch, committee, opts.proverUrl, budget);
      settle(r.votes);
      log(`settled ${order.hash}: ${r.votes} votes, ${r.confirmed} accepted`);
      return order.hash;
    } catch (e) {
      if (e instanceof NoQuorumError) {
        throw new RpcFault(-32003, e.message, { votes: e.votes, quorum: QUORUM, refusals: e.refusals });
      }
      if (e instanceof UnconfirmedError) throw tooFew(e.confirmed, e.certificate);
      throw e;
    }
  }

  // Ask the peers who they are as soon as the client starts.
  void identified();

  return { handler, refresh, peers: () => peers };
}

// -------------------------------------------------------------------- runner

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.role !== "client") {
    throw new ConfigError(`this is the client, but the config says role ${cfg.role}`);
  }

  const client = createClient({
    mode: cfg.mode,
    chainId: cfg.l2.chainId,
    peers: cfg.peers,
    minGasPrice: BigInt(cfg.minGasPrice!),
    proverUrl: cfg.proverUrl,
    pollMs: cfg.intervals!.pollMs,
    l1: cfg.l1
      ? {
          rpcUrl: cfg.l1.rpcUrl,
          gateway: cfg.l1.gateway,
          registry: cfg.l1.registry,
          l1ChainId: cfg.l1.chainId,
        }
      : undefined,
    log: (m) => console.log(`[${cfg.name}] ${m}`),
  });

  serveRpc(client.handler, cfg.listen.port, false, CLIENT_PARAMS);
  console.log(`[${cfg.name}] chainId=${cfg.l2.chainId} rpc=:${cfg.listen.port}`);
  console.log(`[${cfg.name}] remember --legacy`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  });
}
