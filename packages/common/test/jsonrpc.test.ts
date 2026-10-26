import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { RpcFault, serveRpc } from "../src/jsonrpc.js";
import { FASTPAY_PARAMS } from "../src/params.js";

/**
 * The transport, over HTTP. A method name is looked up in the Parameters table
 * as its own key only, so a name that every JavaScript object inherits is an
 * unknown method like any other.
 */
describe("serveRpc", () => {
  it("answers -32601 for an Object.prototype name", async () => {
    const handler = async (method: string) => {
      throw new RpcFault(-32601, `method not found: ${method}`);
    };
    const server = serveRpc(handler, 0, true, FASTPAY_PARAMS);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    try {
      for (const method of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
        const res = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        });
        const body = (await res.json()) as { error?: { code: number } };
        expect(body.error?.code, method).toBe(-32601);
      }
    } finally {
      server.close();
    }
  });
});
