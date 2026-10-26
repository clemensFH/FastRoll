#!/usr/bin/env tsx
/**
 * Byzantine validators.
 *
 * The names and the descriptions ship. The bodies do not, and neither does the
 * mapping from variant to the fraud a prover should report for it, because that
 * mapping is most of Task 3's grade.
 *
 * Write them. Each variant must drop exactly ONE rule, so that a failure names
 * the rule: a validator that misbehaves in three ways at once tells you only
 * that something is wrong. Wrap the honest validator rather than adding a "be
 * evil" flag to it, so the honest path you are graded on stays untouched.
 *
 * One warning that cost the lecture team a day. Weaken the signing RULE, not
 * one endpoint. A variant that only overrides `fastpay_handleOrder` behaves
 * itself on every other path that consults the rule, and does so exactly when
 * you wanted it not to.
 *
 * `VARIANT` in the environment selects the variant. The grader spawns this file
 * with the same config contract as an honest validator.
 */
import { type Hex } from "viem";
import { isMain, loadConfig, serveRpc, signingKey } from "@atbt/common";
import { createValidator, type Validator, type ValidatorOptions } from "../../validator/src/index.js";

export const VARIANTS = [
  "honest",
  "silent",
  "equivocate",
  "overspend-signer",
  "wrong-sequence-signer",
  "bad-root-poster",
  "invalid-cert-poster",
  "colluding-quorum",
] as const;

export type Variant = (typeof VARIANTS)[number];

export function isVariant(s: string): s is Variant {
  return (VARIANTS as readonly string[]).includes(s);
}

/** What each variant is for. Printed by the grader so a failure reads as a
 *  sentence rather than a label. */
export const DESCRIPTIONS: Record<Variant, string> = {
  honest: "follows the protocol, for control runs and for the false-positive check",
  silent: "answers vapi_ and fastpay_info, and nothing else on fastpay_: a crash fault rather than byzantine behaviour",
  equivocate: "ignores its own pending order and signs both of two conflicting orders",
  "overspend-signer": "signs orders the finalized balance cannot cover",
  "wrong-sequence-signer": "signs orders at a sequence the account has not reached",
  "bad-root-poster": "posts a batch whose final state root does not follow from its certificates",
  "invalid-cert-poster": "posts a certificate it invented, with signatures from keys nobody staked",
  "colluding-quorum": "same as overspend-signer, meant to be run on a full quorum at once",
};

export interface MaliciousOptions extends ValidatorOptions {
  variant: Variant;
  /** Keys used to forge certificates. Not staked, which is the point. */
  forgeryKey?: Hex;
}

/**
 * Wrap an honest validator in one specific misbehaviour.
 *
 * Return something with a validator's shape, so the grader and the hosting
 * scripts can treat honest and byzantine nodes identically.
 */
export function createMalicious(opts: MaliciousOptions): Validator & { variant: Variant } {
  // TODO(byzantine): one branch per variant. `createValidator(opts)` gives you
  // the honest node to wrap; override the signing rule, not one endpoint.
  void createValidator;
  throw new Error(`TODO(byzantine): variant "${opts.variant}" is not implemented`);
}

/**
 * The runner, given and complete: the same config contract as an honest
 * validator, mapped onto the options the way packages/validator's own runner
 * does, and both interfaces served. Only `createMalicious` is yours.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const variant = process.env.VARIANT ?? "honest";
  if (!isVariant(variant)) throw new Error(`unknown VARIANT "${variant}", expected one of ${VARIANTS.join(", ")}`);

  const v = createMalicious({
    variant,
    mode: cfg.mode,
    name: cfg.name,
    privateKey: signingKey(cfg),
    chainId: cfg.l2.chainId,
    committee: cfg.committee,
    genesis: (cfg.genesis ?? []).map((g) => ({ address: g.address, balance: BigInt(g.balance) })),
    l1: cfg.l1
      ? { rpcUrl: cfg.l1.rpcUrl, gateway: cfg.l1.gateway, registry: cfg.l1.registry, l1ChainId: cfg.l1.chainId }
      : undefined,
    log: (m) => console.log(`[${cfg.name}] ${m}`),
  });

  serveRpc(v.fastpay, cfg.listen.port, false);
  serveRpc(v.vapi, cfg.listen.vapiPort!, cfg.listen.vapiHost !== "0.0.0.0");
  console.log(`[${cfg.name}] ${v.signer.address} variant=${variant}: ${DESCRIPTIONS[variant]}`);

  if (cfg.mode === "anchored") {
    await v.hooks.bond(cfg.stake).catch((e: unknown) => console.error(`[${cfg.name}] bond: ${e}`));
    setInterval(() => void v.hooks.syncNow().catch(() => {}), cfg.intervals!.syncMs);
    setInterval(() => void v.hooks.postNow().catch(() => {}), cfg.intervals!.postMs);
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
