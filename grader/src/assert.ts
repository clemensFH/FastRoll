/**
 * Assertions that explain themselves.
 *
 * A grader's error messages are the only feedback a student gets from it, so
 * "expected 5, got 4" is not good enough. Every helper here takes a sentence
 * describing the property, and failures quote both values.
 */
import { trace } from "./trace.js";

/** A failed check. Raising it also writes the failure into the transcript, so
 *  the transcript shows WHERE in the scenario it happened, not just that it did. */
export class Failed extends Error {
  constructor(message: string) {
    super(message);
    trace("fail", message);
  }
}

export function ok(cond: unknown, what: string): void {
  if (!cond) throw new Failed(what);
  trace("check", what);
}

export function eq(actual: unknown, expected: unknown, what: string): void {
  const a = show(actual);
  const e = show(expected);
  if (a !== e) throw new Failed(`${what}\n      expected ${e}\n      actual   ${a}`);
  trace("check", `${what} (${e})`);
}

export function ne(actual: unknown, forbidden: unknown, what: string): void {
  if (show(actual) === show(forbidden)) {
    throw new Failed(`${what}\n      must not be ${show(forbidden)}`);
  }
  trace("check", `${what} (${show(actual)}, not ${show(forbidden)})`);
}

export function gt(actual: bigint, floor: bigint, what: string): void {
  if (!(actual > floor)) throw new Failed(`${what}\n      ${actual} is not greater than ${floor}`);
  trace("check", `${what} (${actual} > ${floor})`);
}

/** Every element must satisfy the predicate, and the message names which failed. */
export function all<T>(items: T[], what: string, pred: (t: T) => boolean, label: (t: T) => string): void {
  const bad = items.filter((t) => !pred(t));
  if (bad.length > 0) {
    throw new Failed(`${what}\n      failed for: ${bad.map(label).join(", ")}`);
  }
  trace("check", `${what} (all ${items.length})`);
}

export async function rejects(fn: () => Promise<unknown>, what: string): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    trace("check", `${what} (refused: ${why.split("\n")[0]})`);
    return why;
  }
  throw new Failed(`${what}\n      the call succeeded, and it must not have`);
}

function show(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}
