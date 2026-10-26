#!/usr/bin/env tsx
/**
 * FastPay validator.
 *
 * Standalone (Task 1): sign orders, apply confirmed certificates, hold your own
 * account view. No L1.
 *
 * Anchored (Tasks 2 and 3): additionally replay the finalized state from L1
 * calldata, sign against that, pool certificates, and post batches. Validators
 * are the only parties allowed to post, and a poster stakes its own bond on the
 * root being right.
 */
import { privateKeyToAccount } from "viem/accounts";
import { type Address, type Hex } from "viem";
import {
  L1,
  applyCertifiedOrder,
  applyDeposit,
  decodeOrder,
  encodeCertData,
  epochOf,
  ConfigError,
  isMain,
  loadConfig,
  serialiser,
  signingKey,
  replayFromL1,
  type ReplayResult,
  serveRpc,
  FASTPAY_PARAMS,
  VAPI_PARAMS,
  type Certificate,
  type Handler,
} from "@atbt/common";
import { fastpayHandler, vapiHandler, type Hooks, type PostOutcome, type Signer } from "./rpc.js";

const NOTHING_POSTED: PostOutcome = { posted: false, batchId: null, certificates: 0 };
import { ValidatorState, type Mode } from "./state.js";

export { ValidatorState, Refusal } from "./state.js";
export type { Mode, RefusalReason } from "./state.js";
export * from "@atbt/common";
export { fastpayHandler, vapiHandler } from "./rpc.js";
export type { Signer, Hooks, PostOutcome } from "./rpc.js";

export interface ValidatorOptions {
  mode: Mode;
  name: string;
  privateKey: Hex;
  chainId: number;
  /** Standalone only. */
  committee?: Address[];
  genesis?: { address: Address; balance: bigint }[];
  /** Anchored only. */
  l1?: { rpcUrl: string; gateway: Address; registry: Address; l1ChainId: number };
  log?: (msg: string) => void;
}

export interface Validator {
  state: ValidatorState;
  signer: Signer;
  fastpay: Handler;
  vapi: Handler;
  hooks: Hooks;
  l1(): L1 | null;
}

/**
 * Build a validator without starting any servers, so tests and the grader can
 * drive it in-process and deterministically.
 */
export function createValidator(opts: ValidatorOptions): Validator {
  const account = privateKeyToAccount(opts.privateKey);
  const log = opts.log ?? (() => {});

  const state = new ValidatorState({
    mode: opts.mode,
    name: opts.name,
    address: account.address,
    chainId: opts.chainId,
    committee: opts.committee,
    genesis: opts.genesis,
  });

  const signer: Signer = {
    address: account.address,
    sign: (digest) => account.sign({ hash: digest }),
  };

  let l1: L1 | null = opts.l1
    ? new L1({
        rpcUrl: opts.l1.rpcUrl,
        gateway: opts.l1.gateway,
        registry: opts.l1.registry,
        chainId: opts.l1.l1ChainId,
        privateKey: opts.privateKey,
      })
    : null;

  /** The last replay, kept so the next tick advances instead of rebuilding.
   *  A cold start leaves this undefined, which is the whole of what `dataDir`
   *  being absent means: rebuild from the published history. */
  let lastReplay: ReplayResult | undefined;
  // The replay advances ONE tree in place, so two overlapping syncs would
  // apply the same deposits twice and post a root nobody else can reproduce.
  // postNow calls syncNow while the sync timer is also running, so overlapping
  // is the normal case, not an edge one.
  const serialised = serialiser();

  /**
   * Rebuild the finalized state from L1 and adopt the current committee.
   *
   * A validator is also a full replayer. That is not extra work bolted on: it
   * has to know the finalized balances to apply the signing rule at all, and it
   * gets them the same way any outside observer would.
   *
   * The first pass is a full replay and always will be: with no state there is
   * nothing to build on but what L1 published. Every pass after it advances
   * from the cursor.
   */
  function syncNow(): Promise<void> {
    if (!l1 || state.mode !== "anchored") return Promise.resolve();
    return serialised("sync", doSync);
  }

  async function doSync(): Promise<void> {
    // Rebuild the finalized state from L1 and adopt the current committee.
    //
    // `replayFromL1` in packages/common does the replay and is given. What is
    // yours is what to do with the result: which root to hold, when to prune
    // pending, and where the committee comes from.
    //
    // Take the epoch BOUNDARY from the block height, which is arithmetic, and
    // the COMMITTEE from Registry.committeeOf. It is final once the epoch has
    // begun, because a stake change only takes effect from the next epoch, so
    // read it once per epoch, not once per tick.
    //
    // A batch whose claimed root does not follow from its contents is not
    // state, it is a lie awaiting a challenge. Do not adopt it: see
    // spec/SPEC.md "Following L1", and note that posting on top of one gets
    // YOU slashed, because postBatch stamps preStateRoot from the chain.
    // Record where the replay stopped in `state.stoppedAt`: the given RPC
    // handler reads it to refuse signing and to report vapi_health.
    // TODO(task-2): syncNow
    throw new Error("TODO(task-2): syncNow");
  }

  /**
   * Post the pooled certificates.
   *
   * Only a current committee member may post, and the poster is the one slashed
   * if the blob or the root is wrong. That is the whole reason posting is
   * permissioned here: the poster must have stake to lose.
   */
  /**
   * One post at a time, whoever asks. The timer guards only against itself, and
   * `vapi_postNow` arriving while a timed post is in flight would build a second
   * batch from the same snapshot: the chain applies the first, so the second's
   * step roots start from the wrong state and its honest poster is slashable.
   */
  function postNow(): Promise<PostOutcome> {
    return serialised("post", doPost);
  }

  async function doPost(): Promise<PostOutcome> {
    // Post the pooled certificates.
    //
    // Only a committee member may post, and the poster is the one slashed if
    // the blob or a root is wrong, so replay your own batch before publishing
    // it and drop any certificate that does not apply.
    //
    // One published root per step, deposits first and then certificates in
    // blob order. That ordering IS the protocol: a challenger brackets one
    // step rather than replaying the whole batch on chain.
    //
    // The tree is mutated in place by the replay, so take the deposit
    // counters and your working copy of the tree together, or a sync firing
    // on its own timer will tear the copy you are posting from.
    // TODO(task-2): postNow
    throw new Error("TODO(task-2): postNow");
  }

  /**
   * Bond, once, at startup.
   *
   * Idempotent by checking the registry first, because a validator restarting
   * with its dataDir intact must not stake twice, and because `register()`
   * reverts on a second call anyway.
   */
  async function bond(stake?: string): Promise<void> {
    // Bond this validator's own stake. Nobody does it for you: the grader
    // funds the address and nothing else, and a validator that never bonds is
    // absent from every committee.
    //
    // Idempotent, because a validator restarting with its dataDir intact must
    // not stake twice.
    // TODO(task-2): bond
    throw new Error("TODO(task-2): bond");
  }

  const hooks: Hooks = {
    bond,
    syncNow,
    postNow,
  };

  return {
    state,
    signer,
    fastpay: fastpayHandler(state, signer),
    vapi: vapiHandler(state, hooks),
    hooks,
    l1: () => l1,
  };
}

// -------------------------------------------------------------------- runner

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.role !== "validator") {
    throw new ConfigError(`this is the validator, but the config says role ${cfg.role}`);
  }

  const v = createValidator({
    mode: cfg.mode,
    name: cfg.name,
    privateKey: signingKey(cfg),
    chainId: cfg.l2.chainId,
    committee: cfg.committee,
    genesis: (cfg.genesis ?? []).map((g) => ({ address: g.address, balance: BigInt(g.balance) })),
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

  // The public port is reachable. The control port is bound wherever the
  // operator said, defaulting to loopback: vapi_ can make this validator sync
  // or post on demand, so it must not be reachable from outside whatever the
  // operator considers inside.
  serveRpc(v.fastpay, cfg.listen.port, false, FASTPAY_PARAMS);
  serveRpc(v.vapi, cfg.listen.vapiPort!, cfg.listen.vapiHost !== "0.0.0.0", VAPI_PARAMS);
  console.log(
    `[${cfg.name}] ${v.signer.address} mode=${cfg.mode} chainId=${cfg.l2.chainId} ` +
      `fastpay=:${cfg.listen.port} vapi=${cfg.listen.vapiHost}:${cfg.listen.vapiPort}`,
  );

  if (cfg.mode === "anchored") {
    // Bond first, then sync, then keep both running on the intervals the
    // config gives you. `intervals.syncMs` and `postMs`: the grader sets
    // both to an hour and drives every step by hand, so nothing it grades
    // depends on a timer, but a validator left alone still has to work.
    //
    // One pass must not overlap the next, in either loop.
    //
    // If cfg.dataDir does not exist you MUST start from an empty state and
    // rebuild from L1. Persisting is your choice; being able to start
    // without it is not.
    // TODO(task-2): bond, sync, and post on the configured intervals
    throw new Error("TODO(task-2): bond, sync, and post on the configured intervals");
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  });
}
