/**
 * Container supervision.
 *
 * Every process the grader starts runs in a container, and there is no host
 * path. That is not about isolation for its own sake: a lecturer must not run a
 * submission on their own machine, where a different node version or a stray
 * write is their problem rather than the student's.
 *
 * Two things matter beyond that, and both come from the same place: a grader
 * that hangs, or that reports a failure caused by its own timing, is worse than
 * no grader.
 *
 * So every start waits for the container to actually answer an RPC call rather
 * than sleeping, and its output is collected on failure so a report can show
 * what the process said instead of only that it did not answer.
 */
import { rpcCall } from "@atbt/common";
import * as dk from "./docker.js";

export interface Started {
  name: string;
  /** How the GRADER reaches it: loopback, on the published port. */
  url: string;
  /** How the other containers reach it: the network alias, inside the scenario network.
   *  Distinct from `url`, because a config written with 127.0.0.1 in it would
   *  point every validator at itself. This is the PROTOCOL port, which for a
   *  validator is not the port the grader probes. */
  internalUrl: string;
  port: number;
  container: string;
  logs(): Promise<string[]>;
  stop(): Promise<void>;
}

const running: Started[] = [];

export interface StartOptions {
  name: string;
  /** Container name, unique per scenario. */
  container: string;
  network: string;
  image: string;
  /** Command and arguments, already split. Never a shell string: a shell in
   *  the middle means the signal handling and the exit code are the shell's. */
  argv: string[];
  entrypoint?: string;
  env?: Record<string, string>;
  mounts?: { from: string; to: string; ro?: boolean }[];
  workdir?: string;
  /** Published on loopback: hostPort is what the grader talks to. */
  hostPort: number;
  containerPort: number;
  /** A second published port, for a validator's vapi_. */
  extraPorts?: { host: number; container: number }[];
  /** The port other containers talk to, when that is not the port the grader
   *  probes. A validator is probed on vapi_ but addressed on fastpay_ by the
   *  client and the prover. */
  protocolPort?: number;
  /** An RPC method that must answer before the process counts as up. */
  readyMethod: string;
  readyParams?: unknown[];
  timeoutMs?: number;
  /** Print output as it arrives. */
  verbose?: boolean;
}

export async function start(opts: StartOptions): Promise<Started> {
  await dk.runDetached({
    name: opts.container,
    alias: opts.name,
    network: opts.network,
    image: opts.image,
    argv: opts.argv,
    entrypoint: opts.entrypoint,
    publish: [{ host: opts.hostPort, container: opts.containerPort }, ...(opts.extraPorts ?? [])],
    mounts: opts.mounts,
    // The image's HEALTHCHECK reads these. Without them it probes
    // "http://127.0.0.1:" forever, and a lecturer debugging with `docker ps`
    // sees nine unhealthy containers that are working perfectly. The grader
    // itself does not read docker health; it probes over RPC.
    env: { HEALTH_PORT: String(opts.containerPort), ...opts.env },
    workdir: opts.workdir,
  });

  // Labelled by container, which carries the scenario's prefix, so output
  // from scenarios running side by side under --jobs can be told apart.
  const unfollow = opts.verbose ? dk.follow(opts.container, opts.container) : () => {};

  const url = dk.loopbackUrl(opts.network, opts.container, opts.containerPort, opts.hostPort);
  const started: Started = {
    name: opts.name,
    url,
    internalUrl: `http://${opts.name}:${opts.protocolPort ?? opts.containerPort}`,
    port: opts.hostPort,
    container: opts.container,
    logs: () => dk.logs(opts.container),
    /**
     * Stop, and mean it.
     *
     * The host version of this leaked twice during the build: `bash -lc` died
     * on the SIGTERM, its exit event fired, the follow-up kill was cancelled,
     * and the `npx tsx` grandchild was still holding the port. `docker rm -f`
     * has no equivalent failure, which is most of why this file is shorter
     * than it was.
     */
    async stop() {
      unfollow();
      await dk.remove(opts.container);
      const i = running.indexOf(started);
      if (i >= 0) running.splice(i, 1);
    },
  };
  running.push(started);

  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  while (Date.now() < deadline) {
    const st = await dk.state(opts.container);
    if (st.kind !== "running") {
      const out = st.kind === "exited" ? await dk.logs(opts.container, 25) : [];
      await started.stop();
      throw new Error(
        st.kind === "gone"
          ? `${opts.name}'s container disappeared before it answered ${opts.readyMethod}. ` +
            `Something removed it: another grader run, or a docker prune.`
          : `${opts.name} exited with ${st.code} before answering ${opts.readyMethod}\n` +
            out.map((l) => `    ${l}`).join("\n"),
      );
    }
    try {
      // Bounded per attempt. Publishing through docker-proxy means the TCP
      // connect always succeeds, so "accepts the connection and never answers"
      // is the normal shape of a half-broken submission; on the default fetch
      // timeout one such attempt outlives the whole deadline, and the report
      // blames a timeout on a process that was answering nothing.
      await withDeadline(rpcCall(url, opts.readyMethod, opts.readyParams ?? []), 3000);
      if (opts.verbose) console.log(`    [${opts.name}] up on ${url} (${opts.container})`);
      return started;
    } catch {
      await sleep(150);
    }
  }
  const out = await dk.logs(opts.container, 25);
  await started.stop();
  throw new Error(
    `${opts.name} did not answer ${opts.readyMethod} on ${url} in time\n` +
      out.map((l) => `    ${l}`).join("\n"),
  );
}


/** Reject if a promise has not settled in time. Used per readiness attempt, so
 *  a socket that accepts and never replies costs one interval, not the run. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error("probe timed out")), ms);
    }),
  ]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until a condition holds.
 *
 * Every wait in the grader goes through here rather than through a sleep,
 * because a scenario that passes on a fast machine and fails on a slow one
 * teaches a student nothing about their code.
 */
export async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 20000,
  everyMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false) return v as T;
    } catch (e) {
      lastError = e;
    }
    await sleep(everyMs);
  }
  const why = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for ${what}${why}`);
}

/**
 * Remove everything still running.
 *
 * By label, through docker, rather than by walking a list this process happens
 * to hold: a grader killed with SIGKILL remembers nothing, and the next run
 * must still start from a clean machine rather than grading a container left
 * over from the last one.
 */
export async function stopAll(): Promise<void> {
  running.length = 0;
  await dk.removeRun();
}

/** Remove everything one scenario started, and nothing else, so scenarios
 *  running beside it under `--jobs` are untouched. */
export async function stopScenario(prefix: string): Promise<void> {
  for (let i = running.length - 1; i >= 0; i--) {
    if (running[i].container.startsWith(`${prefix}-`)) running.splice(i, 1);
  }
  await dk.removeScenario(prefix);
}

/** Clear leftovers from EARLIER runs, at startup only. They hold the names and
 *  host ports this run needs. Never mid-run: a concurrent grader's containers
 *  carry the same all-runs label. */
export async function clearPreviousRuns(): Promise<void> {
  await dk.removeAllRuns();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void stopAll().then(() => process.exit(130));
  });
}
