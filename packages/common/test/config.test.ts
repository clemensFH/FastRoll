/**
 * The startup contract.
 *
 * The config file (`spec/SPEC.md`, "The config file") is the one thing a
 * solution in another language has to get right before anything else can be
 * graded. It had no test at all, so every role rule in it
 * was a claim the spec made and nothing checked.
 *
 * These are the rules a wrong config should fail on loudly at startup rather
 * than be ignored for: a field in the wrong file means the author believed
 * something about the process that is not true.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, signingKey } from "../src/config.js";

const KEY = "0x8100000000000000000000000000000000000000000000000000000000000000";
const L1 = { rpcUrl: "http://anvil:8545", chainId: 31337, gateway: `0x${"11".repeat(20)}`, registry: `0x${"22".repeat(20)}` };

const validator = {
  role: "validator",
  mode: "anchored",
  identity: { privateKey: KEY },
  listen: { port: 9600, vapiPort: 9700 },
  l2: { chainId: 90007 },
  l1: L1,
};
const SEVEN = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}`);
const client = { role: "client", mode: "anchored", listen: { port: 9545 }, l2: { chainId: 90007 }, l1: L1 };

/** The field the error names, which is the whole value of a schema error. */
function fieldOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  throw new Error("expected a ConfigError, got none");
}

describe("the config contract", () => {
  it("accepts the three roles as documented", () => {
    expect(parseConfig(validator).role).toBe("validator");
    expect(parseConfig(client).role).toBe("client");
    expect(parseConfig({ ...validator, role: "prover", listen: { port: 9900 } }).role).toBe("prover");
  });

  it("refuses an identity on a client, and requires one everywhere else", () => {
    // The single most likely mistake, because requiring a key for every role
    // is the obvious schema and it is what every launcher here did.
    expect(fieldOf(() => parseConfig({ ...client, identity: { privateKey: KEY } }))).toMatch(/identity/);
    const { identity, ...noKey } = validator;
    void identity;
    expect(fieldOf(() => parseConfig(noKey))).toMatch(/identity/);
  });

  it("gives a client no signing key, and refuses to invent one", () => {
    expect(parseConfig(client).identity).toBeUndefined();
    expect(() => signingKey(parseConfig(client))).toThrow(/no identity/);
    expect(signingKey(parseConfig(validator))).toBe(KEY);
  });

  it("scopes stake to an anchored validator", () => {
    expect(parseConfig({ ...validator, stake: "1" }).stake).toBe("1");
    expect(fieldOf(() => parseConfig({ ...client, stake: "1" }))).toMatch(/stake/);
    const standalone = { ...validator, mode: "standalone", l1: undefined, stake: "1" };
    expect(fieldOf(() => parseConfig(standalone))).toMatch(/stake/);
  });

  it("scopes minGasPrice and proverUrl to a client", () => {
    expect(fieldOf(() => parseConfig({ ...validator, minGasPrice: "1" }))).toMatch(/minGasPrice/);
    expect(fieldOf(() => parseConfig({ ...validator, proverUrl: "http://p" }))).toMatch(/proverUrl/);
    expect(parseConfig({ ...client, minGasPrice: "1", proverUrl: "http://p" }).proverUrl).toBe("http://p");
  });

  it("requires l1 when anchored and refuses it when standalone", () => {
    const { l1, ...noL1 } = validator;
    void l1;
    expect(fieldOf(() => parseConfig(noL1))).toMatch(/l1/);
    expect(fieldOf(() => parseConfig({ ...validator, mode: "standalone" }))).toMatch(/l1/);
  });

  it("requires a vapi port for a validator only", () => {
    expect(fieldOf(() => parseConfig({ ...validator, listen: { port: 9600 } }))).toMatch(/vapiPort/);
    expect(parseConfig(client).listen.vapiPort).toBeUndefined();
  });

  it("refuses genesis balances in anchored mode, where balances come from deposits", () => {
    const g = [{ address: `0x${"33".repeat(20)}`, balance: "1" }];
    expect(fieldOf(() => parseConfig({ ...validator, genesis: g }))).toMatch(/genesis/);
    expect(parseConfig({ ...validator, mode: "standalone", l1: undefined, genesis: g, committee: SEVEN }).genesis).toHaveLength(1);
  });

  it("refuses peers on a validator, which never talks to another validator", () => {
    expect(fieldOf(() => parseConfig({ ...validator, peers: [] }))).toMatch(/peers/);
    expect(parseConfig({ ...client, peers: ["http://v0:9600"] }).peers).toEqual(["http://v0:9600"]);
  });

  it("defaults name, mode, peers and vapiHost, and keeps loopback as the default host", () => {
    const c = parseConfig({ role: "client", listen: { port: 9545 }, l2: { chainId: 90007 }, l1: L1 });
    expect(c.name).toBe("client");
    expect(c.mode).toBe("anchored");
    expect(c.peers).toEqual([]);
    // Loopback by default: a process that has to be told to be private is one
    // that is public whenever somebody forgets.
    expect(parseConfig(validator).listen.vapiHost).toBe("127.0.0.1");
  });

  it("names the field it rejected", () => {
    // The point of a schema error is that it says where to look. A parser that
    // says "invalid config" is a parser somebody has to bisect by hand.
    expect(fieldOf(() => parseConfig({ ...validator, role: "wizard" }))).toMatch(/role/);
    expect(fieldOf(() => parseConfig({ ...validator, listen: { port: -1, vapiPort: 9700 } }))).toMatch(/listen.port/);
    expect(fieldOf(() => parseConfig({ ...validator, identity: { privateKey: "0xnope" } }))).toMatch(/privateKey/);
    expect(fieldOf(() => parseConfig({ ...validator, l1: { ...L1, gateway: "nope" } }))).toMatch(/gateway/);
  });

  it("needs all seven committee members for a standalone validator, and none when anchored", () => {
    const standalone = { ...validator, mode: "standalone", l1: undefined };
    expect(fieldOf(() => parseConfig(standalone))).toMatch(/committee/);
    expect(fieldOf(() => parseConfig({ ...standalone, committee: SEVEN.slice(0, 6) }))).toMatch(/committee/);
    expect(parseConfig({ ...standalone, committee: SEVEN }).committee).toHaveLength(7);
    expect(fieldOf(() => parseConfig({ ...validator, committee: SEVEN }))).toMatch(/committee/);
  });
});
