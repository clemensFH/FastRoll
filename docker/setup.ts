#!/usr/bin/env tsx
/**
 * Fund the committee, publish the addresses, then move the chain to the first
 * epoch with a committee.
 *
 * The deploy itself happens in a separate one-shot service, because it needs
 * `forge` and this image has node instead. Everything after the deploy is
 * ordinary transactions, so it lives here where there is a real language and
 * the ABIs are already typed.
 *
 * It used to be bash in the foundry image, which meant shelling out to `cast`
 * fourteen times to derive seven addresses, and pulling the deployed addresses
 * out of forge's output with a grep piped into a second grep piped into head.
 *
 * ORDER MATTERS, in two places, and both are load-bearing:
 *
 *   - Funding comes before the addresses are published. Every other container
 *     blocks on the addresses file, so publishing first would start validators
 *     that have no gas to bond with.
 *   - Crossing an epoch boundary comes after they have bonded. A stake change
 *     takes effect from the next epoch, so the committee of the epoch they
 *     bonded in is empty, and nothing can be posted until the next one begins.
 *
 * Funding is also the ONLY thing done on a validator's behalf. Bonding is the
 * validator's own transaction: doing it here made that path dead code, and a
 * student whose validator never bonds would have passed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registryAbi } from "@atbt/common";

const RPC = process.env.L1_RPC ?? "http://anvil:8545";
const DEPLOY_LOG = process.env.DEPLOY_LOG ?? "/shared/deploy.log";
const OUT = process.env.OUT ?? "/shared/addresses";
const L1_CHAIN_ID = Number(process.env.L1_CHAIN_ID ?? 31337);

/** Anvil's first account. Deployer and faucet. */
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

/** 0x81.. through 0x87.., so validator keys never collide with a user's. */
const VALIDATORS = Array.from({ length: 7 }, (_, i) =>
  privateKeyToAccount((`0x8${i + 1}` + "0".repeat(62)) as Hex),
);

const chain = {
  id: L1_CHAIN_ID,
  name: "l1",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const pub = createPublicClient({ transport: http(RPC), cacheTime: 0 });
const wallet = createWalletClient({ account: DEPLOYER, transport: http(RPC), chain });

/** The four addresses the deploy printed, as `ATBT_NAME=0x…` lines. */
function deployedAddresses(log: string): Record<string, Address> {
  const found: Record<string, Address> = {};
  for (const m of log.matchAll(/ATBT_([A-Z]+)\s*=?\s*(0x[0-9a-fA-F]{40})/g)) {
    found[m[1]] = m[2] as Address;
  }
  const missing = ["TOKEN", "REGISTRY", "ESCROW", "GATEWAY"].filter((k) => !found[k]);
  if (missing.length > 0) {
    throw new Error(
      `the deploy did not print ${missing.map((m) => `ATBT_${m}`).join(", ")}.\n` +
        log.trim().split("\n").slice(-20).join("\n"),
    );
  }
  return found;
}

async function send(to: Address, value: bigint): Promise<void> {
  const hash = await wallet.sendTransaction({ to, value });
  await pub.waitForTransactionReceipt({ hash });
}

async function registeredCount(registry: Address): Promise<number> {
  const n = await pub.readContract({ address: registry, abi: registryAbi, functionName: "registeredCount" });
  return Number(n);
}

async function main(): Promise<void> {
  const addr = deployedAddresses(readFileSync(DEPLOY_LOG, "utf8"));
  console.log(`gateway  ${addr.GATEWAY}`);
  console.log(`registry ${addr.REGISTRY}`);

  console.log("funding the committee...");
  for (const v of VALIDATORS) {
    await send(v.address, parseEther("100"));
  }

  writeFileSync(
    OUT,
    [
      `TOKEN=${addr.TOKEN}`,
      `REGISTRY=${addr.REGISTRY}`,
      `ESCROW=${addr.ESCROW}`,
      `GATEWAY=${addr.GATEWAY}`,
      `COMMITTEE=${VALIDATORS.map((v) => v.address).join(",")}`,
      "",
    ].join("\n"),
  );
  console.log(`wrote ${OUT}; the validators can start now`);

  console.log("waiting for the committee to bond itself...");
  const deadline = Date.now() + 120_000;
  let bonded = 0;
  while (bonded < VALIDATORS.length && Date.now() < deadline) {
    bonded = await registeredCount(addr.REGISTRY).catch(() => 0);
    if (bonded < VALIDATORS.length) await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`bonded ${bonded}/${VALIDATORS.length}`);
  if (bonded === 0) {
    throw new Error("nobody bonded, so the next epoch would have an empty committee and nothing could be posted");
  }

  // A bond takes effect from the epoch after the one it was made in, so mine
  // to the next boundary: that epoch is the first one the committee sits on.
  // The Registry answers for every epoch that has begun.
  const now = await pub.getBlockNumber();
  const next = (now / 1000n + 1n) * 1000n;
  await pub.request({ method: "anvil_mine" as never, params: [`0x${(next - now).toString(16)}`] as never });
  console.log(`epoch ${next / 1000n} begun, with the committee seated`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
