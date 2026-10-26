/**
 * CRS bridge, no dependencies.
 *
 * Deliberately no bundler, no framework and no ABI library. Seven function
 * selectors are hard-coded below, which is the whole cost of that decision, and
 * in exchange this is a file anyone can open and read against the contracts.
 *
 * The one thing it cannot do itself is find a withdrawal's batch, blob and
 * step roots.
 * That needs the whole L2 state replayed from L1, which a browser will not do,
 * so it asks the client for the calldata. A client that does not offer that is
 * not broken, and this says so rather than failing.
 */
"use strict";

// keccak256 of the signature, first four bytes. Checked against the contracts.
const SELECTORS = {
  faucet: "0xde5f72fd",                    // faucet()
  approve: "0x095ea7b3",                   // approve(address,uint256)
  deposit: "0xb3fb6564",                   // deposit(address,uint128)
  balanceOf: "0x70a08231",                 // balanceOf(address)
  allowance: "0xdd62ed3e",                 // allowance(address,address)
  escrow: "0xe2fdcc17",                    // escrow(), on the Gateway
  token: "0xfc0c546a",                     // token(), on the Escrow
};

const WITHDRAW_PRECOMPILE = "0x00000000000000000000000000000000000000fe";
const DECIMALS = 18n;

const state = {
  account: null,
  clientUrl: null,
  l2ChainId: null,
  l1ChainId: null,
  token: null,
  gateway: null,
  escrow: null,
};

// ------------------------------------------------------------------ plumbing

const $ = (id) => document.getElementById(id);

function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  $("log").prepend(line);
}

function fail(e) {
  const msg = e && e.message ? e.message : String(e);
  log(msg, "bad");
}

let rpcId = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params || [] }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const eth = (method, params) => window.ethereum.request({ method, params: params || [] });

// ABI encoding, for the few shapes needed here.
const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const word = (v) => pad(BigInt(v).toString(16));
const addr = (a) => pad(a.toLowerCase());

/** CRS amounts are 18 decimals. Parsed by hand so no library is needed, and
 *  strictly, because silently truncating somebody's amount is unforgivable. */
function parseAmount(text) {
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not an amount: ${text}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > Number(DECIMALS)) throw new Error(`more than ${DECIMALS} decimal places`);
  return BigInt(whole) * 10n ** DECIMALS + BigInt(frac.padEnd(Number(DECIMALS), "0") || "0");
}

function formatAmount(v) {
  const n = BigInt(v);
  const unit = 10n ** DECIMALS;
  const whole = n / unit;
  const frac = (n % unit).toString().padStart(Number(DECIMALS), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

async function l1Call(to, data) {
  return eth("eth_call", [{ to, data }, "latest"]);
}

async function l1Send(to, data, label) {
  const hash = await eth("eth_sendTransaction", [{ from: state.account, to, data }]);
  log(`${label}: ${hash}`);
  return hash;
}

/** Wait for an L1 receipt. MetaMask returns before mining, and the next step
 *  usually depends on this one having landed. */
async function waitForL1(hash) {
  for (let i = 0; i < 120; i++) {
    const r = await eth("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (BigInt(r.status) === 0n) throw new Error(`transaction reverted: ${hash}`);
      return r;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no receipt for ${hash} after a minute`);
}

// -------------------------------------------------------------------- actions

async function connect() {
  if (!window.ethereum) {
    log("no injected wallet found. Install MetaMask.", "bad");
    return;
  }
  const accounts = await eth("eth_requestAccounts");
  state.account = accounts[0];
  const chainId = await eth("eth_chainId");
  $("wallet-state").textContent = `${state.account} on chain ${BigInt(chainId)}`;
  $("wallet-state").className = "ok";
  log(`connected ${state.account}`);
  await refresh();
}

/**
 * Ask the client what it is, and L1 what the Gateway is wired to.
 *
 * Only the Gateway's address is typed in. The escrow and the token are read
 * from it on L1 rather than typed as well, because a bridge pointed at the
 * wrong escrow is a way to lose funds and there is no reason to make that
 * possible. The L1 is whatever chain the wallet is on when this runs.
 */
async function check() {
  state.clientUrl = $("client-url").value.trim();
  const status = await rpc(state.clientUrl, "fpc_status");
  state.l2ChainId = BigInt(status.chainId);
  log(`client at ${state.clientUrl}: L2 chain ${state.l2ChainId}`);

  const gateway = $("gateway-address").value.trim();
  state.token = state.gateway = state.escrow = null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(gateway)) {
    $("config-state").textContent =
      `L2 chain ${state.l2ChainId}. Enter the Gateway address to bridge; transfers work without it.`;
    $("config-state").className = "muted warn";
    return refresh();
  }
  if (!window.ethereum) throw new Error("connect a wallet on L1 first, to read the Gateway");
  const asAddress = (word) => "0x" + word.replace(/^0x/, "").slice(-40);
  state.gateway = gateway;
  state.escrow = asAddress(await l1Call(gateway, SELECTORS.escrow));
  state.token = asAddress(await l1Call(state.escrow, SELECTORS.token));
  state.l1ChainId = BigInt(await eth("eth_chainId"));
  $("config-state").innerHTML =
    `L2 chain ${state.l2ChainId}, epoch ${BigInt(status.epoch)}, L1 chain ${state.l1ChainId}<br>` +
    `gateway ${state.gateway}<br>escrow ${state.escrow}<br>token ${state.token}`;
  $("config-state").className = "muted ok";
  await refresh();
}

async function refresh() {
  if (state.account && state.token) {
    try {
      const raw = await l1Call(state.token, SELECTORS.balanceOf + addr(state.account));
      $("bal-l1").textContent = `${formatAmount(raw)} CRS`;
    } catch (e) {
      $("bal-l1").textContent = "unavailable";
      fail(e);
    }
  }
  if (state.account && state.clientUrl) {
    try {
      const bal = await rpc(state.clientUrl, "eth_getBalance", [state.account, "latest"]);
      const seq = await rpc(state.clientUrl, "eth_getTransactionCount", [state.account, "latest"]);
      $("bal-l2").textContent = `${formatAmount(bal)} CRS`;
      $("seq-l2").textContent = String(BigInt(seq));
    } catch (e) {
      $("bal-l2").textContent = "unavailable";
      fail(e);
    }
  }
}

async function faucet() {
  requireBridge();
  const hash = await l1Send(state.token, SELECTORS.faucet, "faucet");
  await waitForL1(hash);
  log("faucet paid out", "ok");
  await refresh();
}

async function deposit() {
  requireBridge();
  const amount = parseAmount($("deposit-amount").value);

  const allowance = BigInt(
    await l1Call(state.token, SELECTORS.allowance + addr(state.account) + addr(state.escrow)),
  );
  if (allowance < amount) {
    const hash = await l1Send(
      state.token,
      SELECTORS.approve + addr(state.escrow) + word(amount),
      "approve",
    );
    await waitForL1(hash);
  } else {
    log("allowance already sufficient, skipping approve");
  }

  const hash = await l1Send(
    state.gateway,
    SELECTORS.deposit + addr(state.account) + word(amount),
    "deposit",
  );
  await waitForL1(hash);
  log(
    `deposited ${formatAmount(amount)} CRS. It appears on L2 once a validator posts ` +
      `the batch that credits it.`,
    "ok",
  );
  await refresh();
}

/**
 * Withdraw on L2.
 *
 * This is an ordinary legacy transaction to the withdraw precompile, with the
 * L1 recipient in the calldata. MetaMask signs it without knowing anything
 * about FastPay, which is the point of making transfer orders be Ethereum
 * transactions in the first place.
 */
async function withdraw() {
  if (!state.clientUrl) throw new Error("check the client endpoint first");
  const amount = parseAmount($("withdraw-amount").value);
  const to = ($("withdraw-to").value.trim() || state.account).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error(`not an address: ${to}`);

  const current = await eth("eth_chainId");
  if (BigInt(current) !== state.l2ChainId) {
    throw new Error(
      `MetaMask is on chain ${BigInt(current)} but the L2 is ${state.l2ChainId}. ` +
        `Add the L2 as a network first, with the client URL as its RPC.`,
    );
  }

  const seq = BigInt(await rpc(state.clientUrl, "eth_getTransactionCount", [state.account, "latest"]));
  const hash = await eth("eth_sendTransaction", [
    {
      from: state.account,
      to: WITHDRAW_PRECOMPILE,
      value: "0x" + amount.toString(16),
      data: "0x" + addr(to),
      gas: "0x5208",
      gasPrice: "0x" + (1000000000).toString(16),
    },
  ]);
  log(`withdrawal order sent at sequence ${seq}: ${hash}`);
  $("withdraw-sequence").value = String(seq);
  log(
    "wait for a validator to post the batch, then withdraw on L1. The sequence " +
      `to withdraw is ${seq}, already filled in.`,
    "ok",
  );
  await refresh();
}

/**
 * Withdraw on L1.
 *
 * The calldata comes from the client, which has to replay the chain to find
 * the batch that applied the withdrawal. If the client does not offer that,
 * say so plainly instead of leaving somebody wondering where their CRS went.
 */
async function claim() {
  requireBridge();
  const sequence = $("withdraw-sequence").value.trim();
  if (!/^\d+$/.test(sequence)) throw new Error("enter the sequence your withdrawal used");

  let plan;
  try {
    plan = await rpc(state.clientUrl, "fpc_withdrawCalldata", [state.account, "0x" + BigInt(sequence).toString(16)]);
  } catch (e) {
    const msg = String(e.message || e);
    if (/method not supported|not found/i.test(msg)) {
      throw new Error(
        "this client does not implement fpc_withdrawCalldata, which is optional. " +
          "Withdrawing needs the batch, the certificate blob and the step roots that " +
          "applied it, so it has to be built by something that replays the chain. " +
          "Use a client that offers it, or call the Gateway's withdraw yourself.",
      );
    }
    throw e;
  }

  if (BigInt(await eth("eth_chainId")) !== state.l1ChainId) {
    throw new Error(
      `MetaMask is on the wrong chain for withdrawing. Switch to L1, chain ${state.l1ChainId}.`,
    );
  }
  const hash = await l1Send(plan.to, plan.data, "withdraw");
  await waitForL1(hash);
  log(`withdrew ${formatAmount(plan.amount)} CRS to ${plan.recipient}`, "ok");
  await refresh();
}

function requireBridge() {
  if (!state.account) throw new Error("connect a wallet first");
  if (!state.token || !state.gateway || !state.escrow) {
    throw new Error("enter the Gateway address and check first, so the L1 addresses are known");
  }
}

// -------------------------------------------------------------------- wiring

function bind(id, fn) {
  $(id).addEventListener("click", async () => {
    const button = $(id);
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      button.disabled = false;
    }
  });
}

bind("connect", connect);
bind("check", check);
bind("refresh", refresh);
bind("faucet", faucet);
bind("deposit", deposit);
bind("withdraw", withdraw);
bind("claim", claim);

if (window.ethereum) {
  window.ethereum.on("accountsChanged", (a) => {
    state.account = a[0] || null;
    $("wallet-state").textContent = state.account || "Not connected.";
    refresh().catch(fail);
  });
  window.ethereum.on("chainChanged", () => refresh().catch(fail));
}

// scripts/up.sh prints a link that carries the Gateway, so a local stack needs
// nothing typed in.
try {
  const fromLink = new URLSearchParams(location.search).get("gateway");
  if (fromLink) $("gateway-address").value = fromLink;
} catch {
  // No query string to read, which is fine.
}

log("ready. Connect a wallet on L1, then check the endpoints.");
