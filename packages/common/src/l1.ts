/**
 * L1 access, shared by the validator, the client, the prover and the grader.
 *
 * Everything here reads what any observer can read. No component has a
 * privileged view of L1, which is the property that makes the whole system
 * checkable from outside.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  getAddress,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayAbi, registryAbi } from "./abi.js";
import { decodeCertData, type Certificate } from "./certificate.js";
import { applyCertifiedOrder, applyDeposit, newStateTree, type StateTree } from "./state.js";
import { decodeOrder, type TransferOrder } from "./order.js";
import { serialiser } from "./main.js";
import { epochOf } from "./constants.js";

export interface L1Config {
  rpcUrl: string;
  gateway: Address;
  registry: Address;
  chainId: number;
  privateKey?: Hex;
}

export interface PostedBatch {
  id: bigint;
  preStateRoot: Hex;
  postStateRoot: Hex;
  certDataHash: Hex;
  stepRootsHash: Hex;
  epoch: bigint;
  certCount: bigint;
  depositCount: bigint;
  depositsFrom: bigint;
  poster: Address;
  postedAt: bigint;
  invalidated: boolean;
  /** Published blob and per-step roots, recovered from the posting
   *  transaction's calldata rather than from storage. */
  certData: Hex;
  stepRoots: Hex[];
  depositsThrough: bigint;
}

export interface DepositRecord {
  index: bigint;
  recipient: Address;
  amount: bigint;
}

export class L1 {
  readonly pub: PublicClient;
  readonly wallet?: WalletClient;
  readonly account?: ReturnType<typeof privateKeyToAccount>;
  readonly cfg: L1Config;

  // ---- ingest cursor
  //
  // Every reader here used to scan `fromBlock: 0n` on every call, and
  // readBatches additionally made two RPCs per batch ever posted. The client
  // called it from eth_getBalance, so one `cast balance` re-derived the entire
  // chain. The first pass is still a full replay, because with no state there
  // is nothing to build on but the published history: what this removes is
  // REPEATING it.
  //
  // Batch metadata is immutable once posted, with one exception: `invalidated`.
  // Rather than re-reading storage to catch that, a BatchInvalidated log in the
  // new range drops the whole cache and rescans. Invalidation is rare, and a
  // cold start is obviously right where a partial update would need an argument.
  private gwThrough: bigint | null = null;
  private batchCache = new Map<bigint, PostedBatch>();
  // Keyed by index, not a list. An append-only list plus a cursor committed at
  // the END of the scan meant any throw mid-loop left the deposits behind with
  // the cursor unmoved, so the next scan pushed them all again: balances
  // inflated, the root diverged from every other replayer, and the poster was
  // slashed for a batch that was honestly built. A map makes the scan
  // idempotent, which is the property that was actually wanted.
  private depositCache = new Map<bigint, DepositRecord>();
  /** Committees of epochs that have begun, which never change again. */
  private committeeCache = new Map<bigint, Address[]>();
  /** The highest head seen, so a chain that went backwards drops the cache. */
  private committeeHead: bigint | null = null;
  /** Batches whose posting calldata does not decode, so the blob cannot be
   *  recovered. Remembered so the scan does not retry them every tick. */
  private undecodable = new Set<bigint>();
  // The caches are shared mutable state, so the scans that append to them run
  // one at a time. Two concurrent scans would both start from the same cursor
  // and append the same deposits twice.
  private readonly serialised = serialiser();

  private readonly chain: { id: number; name: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: { default: { http: string[] } } };

  constructor(cfg: L1Config) {
    this.cfg = cfg;
    // cacheTime 0, deliberately. viem caches getBlockNumber for the polling
    // interval by default, so a validator's view of the head can be seconds
    // stale. Epoch boundaries are a block height, so a stale head means a
    // validator keeps signing in an epoch that has already ended, and which
    // validators do that depends on when their timers happened to fire. That
    // is the least debuggable class of failure there is.
    this.pub = createPublicClient({ transport: http(cfg.rpcUrl), cacheTime: 0 });
    this.chain = {
      id: cfg.chainId,
      name: "l1",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    };
    if (cfg.privateKey) {
      this.account = privateKeyToAccount(cfg.privateKey);
      this.wallet = createWalletClient({ account: this.account, transport: http(cfg.rpcUrl) });
    }
  }

  blockNumber(): Promise<bigint> {
    return this.pub.getBlockNumber();
  }

  gateway<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({
      address: this.cfg.gateway,
      abi: gatewayAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  /** Read any contract. Used for the pieces the Gateway only points at, such as
   *  the escrow's token. */
  read<T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  registry<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({
      address: this.cfg.registry,
      abi: registryAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  async send(target: "gateway" | "registry", functionName: string, args: unknown[], value = 0n): Promise<Hex> {
    if (!this.wallet || !this.account) throw new Error("no signer configured");
    return this.wallet.writeContract({
      address: target === "gateway" ? this.cfg.gateway : this.cfg.registry,
      abi: target === "gateway" ? gatewayAbi : registryAbi,
      functionName: functionName as never,
      args: args as never,
      value,
      account: this.account,
      chain: this.chain,
    });
  }

  async sendAndWait(target: "gateway" | "registry", functionName: string, args: unknown[], value = 0n) {
    const hash = await this.send(target, functionName, args, value);
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return receipt;
  }

  // ------------------------------------------------------------- committee

  async currentEpoch(): Promise<bigint> {
    return this.registry<bigint>("currentEpoch");
  }

  /**
   * The committee of an epoch, or null if it has not begun.
   *
   * Cached, because the answer for an epoch that has begun is final: a stake
   * change only ever takes effect from the next epoch, so nothing can move a
   * begun epoch's committee afterwards, pinned or not. One RPC per epoch,
   * rather than one per tick, and no event history to replay.
   *
   * The one thing that can invalidate it is the chain itself going backwards,
   * from a restart or an anvil_reset, so a head below the highest one seen
   * drops the cache.
   */
  committeeOf(epoch: bigint): Promise<Address[] | null> {
    return this.serialised("registry", async () => {
      const head = await this.blockNumber();
      if (this.committeeHead !== null && head < this.committeeHead) this.committeeCache.clear();
      this.committeeHead = head;
      const hit = this.committeeCache.get(epoch);
      if (hit) return [...hit];
      if (epoch > epochOf(head)) return null;
      const c = (await this.registry<Address[]>("committeeOf", [epoch])).map(getAddress);
      this.committeeCache.set(epoch, c);
      return [...c];
    });
  }

  // --------------------------------------------------------------- batches

  /**
   * Forget everything and rescan from genesis on the next read.
   *
   * Serialised, because clearing the caches underneath an in-flight scan lets
   * that scan re-add only the events it had not yet reached and then claim
   * completeness by setting the cursor to head. `resetIngest` is the private
   * synchronous half, for callers already inside the queue.
   */
  async reset(): Promise<void> {
    await this.serialised("gateway", async () => this.resetIngest());
  }

  private resetIngest(): void {
    this.gwThrough = null;
    this.batchCache.clear();
    this.depositCache.clear();
    this.undecodable.clear();
  }

  /**
   * Advance the Gateway cursor, decoding only what is new.
   *
   * One pass drives batches and deposits together, because they come from the
   * same log range and a second scan would double the cost of the thing this
   * exists to make cheap.
   */
  private scanGateway(): Promise<void> {
    return this.serialised("gateway", () => this.doScanGateway());
  }

  private async doScanGateway(): Promise<void> {
    const head = await this.blockNumber();
    const cold = this.gwThrough === null;

    // A head BELOW the cursor is not "nothing new": it is a different chain,
    // from a restart or an anvil_reset. Serving the old chain's batches from
    // cache forever, with the cursor permanently ahead of the head and no error
    // anywhere, is the worst available answer.
    if (!cold && head < this.gwThrough!) {
      this.resetIngest();
      return this.doScanGateway();
    }

    const from = cold ? 0n : this.gwThrough! + 1n;
    if (!cold && from > head) return;

    const logs = await this.pub.getLogs({ address: this.cfg.gateway, fromBlock: from, toBlock: head });
    const events = parseEventLogs({ abi: gatewayAbi, logs });

    // An invalidation walks the tip back, so ids this cache holds may no longer
    // be live and `invalidated` may have flipped under us. Start over.
    if (!cold && events.some((e) => e.eventName === "BatchInvalidated")) {
      this.resetIngest();
      // Directly, not through the queue: this call is already inside it.
      return this.doScanGateway();
    }

    for (const ev of events) {
      if (ev.eventName === "Deposited") {
        const a = ev.args as { index: bigint; recipient: Address; amount: bigint };
        this.depositCache.set(a.index, { index: a.index, recipient: getAddress(a.recipient), amount: a.amount });
        continue;
      }
      if (ev.eventName !== "BatchPosted") continue;

      const id = (ev.args as { batchId: bigint }).batchId;
      if (this.batchCache.has(id)) continue;
      const rec = (await this.gateway<unknown[]>("batches", [id])) as unknown[];
      const tx = await this.pub.getTransaction({ hash: ev.transactionHash });

      // `postBatch` is plain external, so a committee member may post through a
      // relayer and the transaction input is then not a bare postBatch call.
      // Throwing here would re-throw on every scan forever, and with an
      // append-only deposit cache that was an unbounded leak. The batch is
      // unusable either way, so record why and carry on: a replayer that cannot
      // read the blob cannot check the batch, which is the poster's problem.
      let a: readonly unknown[];
      try {
        a = decodeFunctionData({ abi: gatewayAbi, data: tx.input }).args as readonly unknown[];
      } catch {
        this.undecodable.add(id);
        continue;
      }

      this.batchCache.set(id, {
        id,
        preStateRoot: rec[0] as Hex,
        postStateRoot: rec[1] as Hex,
        certDataHash: rec[2] as Hex,
        stepRootsHash: rec[3] as Hex,
        epoch: rec[4] as bigint,
        certCount: rec[5] as bigint,
        depositCount: rec[6] as bigint,
        depositsFrom: rec[7] as bigint,
        poster: getAddress(rec[8] as Address),
        postedAt: rec[9] as bigint,
        invalidated: rec[10] as boolean,
        certData: a[0] as Hex,
        stepRoots: a[1] as Hex[],
        depositsThrough: a[3] as bigint,
      });
    }

    this.gwThrough = head;
  }

  /**
   * Read every live posted batch, including the blob that makes it checkable.
   *
   * The blob is a `postBatch` argument, so it comes from the transaction
   * calldata rather than from storage. That is deliberate: calldata is the
   * cheapest place to publish data nobody needs to read on-chain.
   */
  async readBatches(): Promise<PostedBatch[]> {
    await this.scanGateway();
    return [...this.batchCache.values()].sort((x, y) => Number(x.id - y.id));
  }

  async readDeposits(): Promise<DepositRecord[]> {
    await this.scanGateway();
    return [...this.depositCache.values()].sort((x, y) => Number(x.index - y.index));
  }

}

/** Results already advanced from. A result's tree moves when it is used as
 *  `prev`, so the result itself is single-use: anything still holding it is
 *  holding a description of a state that no longer exists. */
const consumed = new WeakSet<ReplayResult>();

export interface ReplayResult {
  tree: StateTree;
  /** Batches actually applied, invalidated ones excluded. */
  applied: PostedBatch[];
  /** Orders the replay actually applied, in order. This is the L2's history,
   *  and it is the only place a withdrawal's recipient and amount can be
   *  recovered from, since L1 stores the certificate blob and nothing else. */
  orders: { batchId: bigint; order: TransferOrder }[];
  /** Certificates whose order the replay rejected. An honest committee never
   *  produces one, so a non-empty list means a quorum was corrupted. */
  rejected: { batchId: bigint; index: number; orderHash: Hex; reason: string }[];
  /** Root the replay reached, which must equal the last applied batch's claim. */
  root: Hex;
  /** Set when a batch's claimed root disagrees with the replay. That batch and
   *  everything after it is NOT in `applied` and its effects are NOT in `tree`:
   *  a state the Gateway disagrees with is not one to hold. `computed` is what
   *  the batch should have claimed, which is what a challenger proves. */
  mismatch?: { batchId: bigint; claimed: Hex; computed: Hex };
  /** Set when the replay stopped before the end of the published history,
   *  which happens when a blob does not decode at all. Such a result is not
   *  advanceable: resuming would re-reject the same batch on every tick and
   *  grow `rejected` without bound, so the next pass rebuilds instead. */
  stoppedAt?: bigint;
}

/**
 * Rebuild the L2 state from L1 alone.
 *
 * Used by the validator to know what it is signing against, by the prover to
 * find fraud, and by the grader to check both. It works because every batch
 * publishes its certificates in calldata, so no component has to ask the
 * committee for anything.
 *
 * ORDER IS PART OF THE PROTOCOL. Within a batch, deposits credited by that
 * batch are applied first, then its certificates in blob order. Deposits are
 * L1-originated and unconditional, so putting them first means a transfer can
 * spend funds that arrived in the same batch.
 *
 * Pass the previous result back in to advance instead of rebuilding. The tree
 * is then MUTATED rather than replaced, so a caller holding `prev.tree` sees
 * the new state: that is what the anchored validator wants, and it is why the
 * posting probe clones before it experiments.
 */
export async function replayFromL1(l1: L1, chainId: number, prev?: ReplayResult): Promise<ReplayResult> {
  // Claim `prev` before the first await, so of two concurrent advances only one
  // gets to mutate the tree and the other rebuilds from genesis. Advancing the
  // same result twice applied the same batches twice and produced a root no
  // other replayer could reproduce, which reads as a consensus bug rather than
  // a race. Serialising at the call site is still worth doing; this is what
  // makes forgetting to survivable.
  const usable = prev !== undefined && !consumed.has(prev);
  if (usable) consumed.add(prev!);

  const batches = (await l1.readBatches()).filter((b) => !b.invalidated);
  const deposits = await l1.readDeposits();

  // Continue from `prev` only if the history it was built on is still a prefix
  // of the published history, compared id by id AND root by root.
  //
  // Not by length: invalidate batch 2 of 0..2 and then post two more, and the
  // live list is [0,1,3,4], which is LONGER than the three-batch prefix. What
  // makes the id comparison sufficient is that `postBatch` allocates
  // `id = batches.length` and the array never shrinks, so an id is never
  // reused. That is a property of the Gateway, which students write, so it is
  // stated in the spec rather than only relied on here.
  const reusable =
    usable &&
    prev!.stoppedAt === undefined &&
    prev!.applied.length <= batches.length &&
    prev!.applied.every((b, i) => batches[i].id === b.id && batches[i].postStateRoot === b.postStateRoot);

  // Reused, not copied. `prev` is single-use and already surrendered its tree
  // to be mutated in place, so copying three arrays that grow with the whole
  // history would put an O(history) allocation back into every tick, which is
  // most of what the cursor exists to remove.
  const tree = reusable ? prev!.tree : newStateTree();
  const rejected: ReplayResult["rejected"] = reusable ? prev!.rejected : [];
  const applied: PostedBatch[] = reusable ? prev!.applied : [];
  const orders: ReplayResult["orders"] = reusable ? prev!.orders : [];
  let depositsDone = reusable ? (applied.at(-1)?.depositsThrough ?? 0n) : 0n;
  // Not carried over: a result that found a mismatch also stopped, and a
  // stopped result is never advanced from, so the rebuild rediscovers it.
  let mismatch: ReplayResult["mismatch"];
  let stoppedAt: bigint | undefined;

  for (const b of batches.slice(reusable ? prev!.applied.length : 0)) {
    // Snapshot, so a batch whose claimed root is wrong can be UNAPPLIED. The
    // alternative was to apply it, notice, and carry on with a state the chain
    // disagrees with, which is the wrong invariant: see the stop below.
    const before = tree.clone();
    const ordersBefore = orders.length;
    const rejectedBefore = rejected.length;
    const depositsBefore = depositsDone;

    // Deposits first, one step each, then certificates in blob order. The
    // Gateway's per-step proofs assume exactly this order, so the replay has to
    // match it or an honest poster becomes provably wrong.
    for (const d of deposits) {
      if (d.index >= depositsDone && d.index < b.depositsThrough) {
        applyDeposit(tree, d.recipient, d.amount);
      }
    }
    depositsDone = b.depositsThrough;


    /** Unapply this batch and stop. Both exits from the loop go through here:
     *  the first version rolled back on a bad root but NOT on an undecodable
     *  blob, so that path left the batch's deposits applied and the validator
     *  adopted a tree matching neither the honest replay nor the chain. */
    const stopHere = (): void => {
      tree.replaceWith(before);
      orders.length = ordersBefore;
      rejected.length = rejectedBefore;
      depositsDone = depositsBefore;
      stoppedAt = b.id;
    };

    let certs: Certificate[];
    try {
      certs = decodeCertData(b.certData);
    } catch (e) {
      const why = `certData does not decode: ${e instanceof Error ? e.message : e}`;
      stopHere();
      // After the rollback, so it survives the truncation.
      rejected.push({ batchId: b.id, index: -1, orderHash: "0x", reason: why });
      break;
    }

    for (let i = 0; i < certs.length; i++) {
      const order = await decodeOrder(certs[i].order, chainId).catch(() => null);
      if (!order) {
        rejected.push({ batchId: b.id, index: i, orderHash: "0x", reason: "order does not decode" });
        continue;
      }
      const r = applyCertifiedOrder(tree, order);
      if (r.applied) {
        orders.push({ batchId: b.id, order });
      } else {
        rejected.push({ batchId: b.id, index: i, orderHash: order.hash, reason: r.reason });
      }
    }

    // THE STOP. A batch whose claimed root does not follow from its own
    // contents is not state, it is a lie awaiting a challenge, and everything
    // after it is built on that lie. So the replay unapplies it and stops.
    //
    // The alternative, applying it and carrying on with the honestly computed
    // root, looks more useful and is worse. It means holding a state the
    // Gateway disagrees with, signing against it, and posting on top of it:
    // `postBatch` stamps `preStateRoot` from `currentStateRoot()`, which is the
    // liar's root, so an honest poster's own batch inherits the lie and becomes
    // provably wrong. An honest validator gets slashed for somebody else's
    // fraud.
    //
    // Stopping costs liveness and keeps safety, which is the trade this whole
    // protocol already makes everywhere else. The chain is stuck until somebody
    // challenges, and somebody is paid to.
    if (tree.root() !== b.postStateRoot) {
      // BEFORE the rollback. `computed` is what the batch should have claimed,
      // which is what a challenger proves; reading it after `replaceWith` gave
      // the batch's PRE-state root instead, which is a different number and a
      // useless one.
      const computed = tree.root();
      stopHere();
      mismatch = { batchId: b.id, claimed: b.postStateRoot, computed };
      break;
    }

    applied.push(b);
  }

  return { tree, applied, orders, rejected, root: tree.root(), mismatch, stoppedAt };
}
