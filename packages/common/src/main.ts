/**
 * Is this module the process entry point?
 *
 * Substring tests on `process.argv[1]` look fine until one entry point imports
 * another. `packages/malicious/src/index.ts` ends with "index.ts", so a guard
 * written that way in the validator fired inside the malicious runner, started
 * a second pair of servers, and the process died on EADDRINUSE with a message
 * naming a port nothing else was using.
 *
 * Comparing resolved URLs is exact, and it is the only form that stays correct
 * when one runner imports another.
 */
import { pathToFileURL } from "node:url";

export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === new URL(moduleUrl).href;
  } catch {
    return false;
  }
}

/**
 * A per-key serial queue.
 *
 * Work for the same key runs one at a time, in the order it was asked for, and
 * a failure does not stall the queue behind it.
 *
 * This is not a nicety. Anything that MUTATES shared state across an `await`
 * needs it: the anchored replay advances one state tree in place, so two
 * overlapping calls would apply the same deposits twice and post a root no
 * other replayer can reproduce. That failure looks like a wrong state root,
 * not like a race, which is why it is worth a helper rather than a comment.
 */
export function serialiser(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(work, work) as Promise<T>;
    chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };
}
