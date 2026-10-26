/**
 * Minimal JSON-RPC over HTTP. Node's built-in http, no framework.
 *
 * Both validator interfaces speak this, because every student already
 * implements JSON-RPC for `cast` and it works from any language. That is the
 * whole reason the interface is shaped this way rather than as gRPC or REST.
 */
import { createServer, type Server } from "node:http";
import { getAddress } from "viem";

import { checkParams, type Surface } from "./params.js";

export interface RpcRequest {
  id: unknown;
  method: string;
  params?: unknown[];
}

/** The largest request body a server accepts: 1 MiB, from the spec's Transport. */
export const MAX_BODY = 1 << 20;

export type Handler = (method: string, params: unknown[]) => Promise<unknown>;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** All bigints out as 0x hex, so the wire is language-agnostic and matches
 *  Ethereum convention. */
export function toWire(v: unknown): unknown {
  if (typeof v === "bigint") return "0x" + v.toString(16);
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWire(x)]));
  }
  return v;
}

/** An address parameter, or -32602. Without this a malformed one escaped as
 *  the address library's own error, which went out as -32000 and told the
 *  caller nothing it could act on. */
export function paramAddress(v: unknown): `0x${string}` {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new RpcFault(-32602, `expected a 0x-prefixed 20-byte address, got ${JSON.stringify(v)}`);
  }
  return getAddress(v);
}

export function fromWire(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new RpcFault(-32602, `cannot read ${JSON.stringify(v)} as an integer`);
}

/**
 * @param bindLocalOnly true for the control interface. It listens on 127.0.0.1
 *        so `vapi_` is unreachable from another machine, which matters because
 *        it can rewrite a validator's peer list and make it sync or post now.
 */
export function serveRpc(handler: Handler, port: number, bindLocalOnly: boolean, surface?: Surface): Server {
  const server = createServer((req, res) => {
    // A body over MAX_BODY is refused with HTTP 413, as the spec's Transport
    // says. Counted as it arrives and not kept, so an attacker cannot make
    // this process hold an arbitrarily large request in memory.
    let body = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) body += c;
    });
    req.on("end", async () => {
      if (size > MAX_BODY) {
        res.statusCode = 413;
        res.setHeader("access-control-allow-origin", "*");
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      const one = async (r: unknown) => {
        // A request is an object with a string method and, optionally, an
        // array of params. Anything else is -32600, before the method is read.
        const q = r as Partial<RpcRequest> | null;
        const id = q && typeof q === "object" && !Array.isArray(q) ? (q.id ?? null) : null;
        if (!q || typeof q !== "object" || Array.isArray(q) || typeof q.method !== "string" ||
            (q.params !== undefined && !Array.isArray(q.params))) {
          return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
        }
        try {
          // Parameters are checked against the method's row in the spec's
          // "Parameters" table before the handler sees them. A method not in
          // the table goes straight to the handler, which answers -32601 for one
          // it does not have.
          const listed = surface && Object.hasOwn(surface, q.method) ? surface[q.method] : undefined;
          const params = listed ? checkParams(q.method, listed, q.params ?? []) : (q.params ?? []);
          return { jsonrpc: "2.0", id, result: toWire(await handler(q.method, params)) };
        } catch (e) {
          const err: RpcError =
            e instanceof RpcFault
              ? { code: e.code, message: e.message, data: toWire(e.data) }
              : { code: -32000, message: e instanceof Error ? e.message : String(e) };
          return { jsonrpc: "2.0", id, error: err };
        }
      };

      try {
        const parsed = JSON.parse(body) as unknown;
        const out = Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed);
        res.end(JSON.stringify(out));
      } catch {
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }),
        );
      }
    });
  });
  server.listen(port, bindLocalOnly ? "127.0.0.1" : "0.0.0.0");
  return server;
}

/** Call a JSON-RPC endpoint. Used by the client, the prover and the grader. */
export async function rpcCall<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: toWire(params) }),
  });
  const json = (await res.json()) as { result?: T; error?: RpcError };
  if (json.error) throw new RpcFault(json.error.code, json.error.message, json.error.data);
  return json.result as T;
}
