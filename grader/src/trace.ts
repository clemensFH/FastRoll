/**
 * What the grader did, said and heard, per scenario.
 *
 * The transcript is the feedback a student gets, so it records every request
 * the grader sent to a submission and every answer that came back, every chain
 * action, every container started, and every check with what was expected and
 * what was seen. Each line carries the time since the scenario started, dmesg
 * style, because "the client answered after 7.9 seconds" is often the whole
 * diagnosis.
 *
 * One trace per scenario, found through AsyncLocalStorage rather than passed
 * down by hand, so the assertions and the RPC helpers can write to it without
 * every call site threading it through, and so scenarios running side by side
 * under --jobs never write into each other's transcript.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type Kind = "info" | "send" | "recv" | "error" | "check" | "fail" | "chain" | "proc";

export interface Line {
  /** Seconds since the scenario started. */
  t: number;
  kind: Kind;
  text: string;
}

export class Trace {
  readonly lines: Line[] = [];
  private readonly start = performance.now();

  log(kind: Kind, text: string): void {
    this.lines.push({ t: (performance.now() - this.start) / 1000, kind, text });
  }

  render(): string {
    return this.lines.map(renderLine).join("\n");
  }
}

const MARK: Record<Kind, string> = {
  info: "   ",
  send: "-> ",
  recv: "<- ",
  error: "<! ",
  check: "ok ",
  fail: "XX ",
  chain: "L1 ",
  proc: "   ",
};

function renderLine(l: Line): string {
  const stamp = `[${l.t.toFixed(4).padStart(9)}]`;
  const [first, ...rest] = l.text.split("\n");
  const pad = " ".repeat(stamp.length + 1 + MARK[l.kind].length);
  return [`${stamp} ${MARK[l.kind]}${first}`, ...rest.map((r) => pad + r)].join("\n");
}

const store = new AsyncLocalStorage<Trace>();

/** Run `fn` with `trace` as the current trace for everything it awaits. */
export function withTrace<T>(trace: Trace, fn: () => Promise<T>): Promise<T> {
  return store.run(trace, fn);
}

/** Write to the current scenario's trace, if there is one. */
export function trace(kind: Kind, text: string): void {
  store.getStore()?.log(kind, text);
}

/**
 * A value as it goes into a transcript.
 *
 * Bigints as decimals, and long hex cut in the middle so a signed order or a
 * certificate blob stays recognisable without filling the page. The full bytes
 * are rarely what a reader needs and the start and end identify them.
 */
export function shown(v: unknown, max = 600): string {
  const s =
    typeof v === "string"
      ? v
      : (JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v));
  const compact = s.replace(
    /0x[0-9a-fA-F]{80,}/g,
    (h) => `${h.slice(0, 34)}...${h.slice(-16)} (${(h.length - 2) / 2} bytes)`,
  );
  return compact.length > max ? `${compact.slice(0, max)}... (${compact.length - max} more characters)` : compact;
}
