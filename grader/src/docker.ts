/**
 * Containers, because a lecturer must not run student code on their laptop.
 *
 * That is the whole reason this file exists. A submission that assumes a
 * different node version, writes outside its directory, or leaves a process
 * behind is the student's problem inside a container and the lecturer's problem
 * outside one.
 *
 * Compose is deliberately not used here. A compose file is a static topology,
 * and the grader needs a different committee composition per scenario: seven
 * honest, or five honest and two equivocating, or a split committee. Expressing
 * that in compose means templating a compose file per scenario, which is
 * strictly more machinery than calling docker directly.
 *
 * Three invariants everything else depends on:
 *
 *   - every container and network carries this run's label, so teardown is one
 *     command and does not depend on the grader exiting cleanly.
 *   - the label is unique per run, so two graders running at once cannot delete
 *     each other's containers. A shared label made concurrent runs report
 *     readiness timeouts against correct submissions.
 *   - every container joins a per-scenario network, so a leftover from an
 *     earlier scenario cannot be reached by name.
 */
import { spawn } from "node:child_process";

/** Marks anything this grader has ever started, across all runs. Teardown at
 *  startup uses this, because a run killed with SIGKILL remembers nothing. */
export const LABEL_ALL = "atbt.grader";

/** Marks this run only. Teardown DURING a run uses this, so a concurrent
 *  grader's containers survive. */
export const LABEL_RUN = "atbt.grader.run";
const RUN_ID = `${process.pid}`;

export const RUN_LABELS = [`${LABEL_ALL}=1`, `${LABEL_RUN}=${RUN_ID}`];

/**
 * Run docker and return its streams separately.
 *
 * No shell, and no merging. An earlier version went through `bash -lc` and
 * concatenated stdout with stderr, which two callers then PARSED: a login
 * shell that echoes anything, or a docker warning about a malformed config
 * file, became a container id or an exit code. `exitCode` turned such a line
 * into NaN, which is not null, which reads as "the container exited" and would
 * have reported every validator as crashing on startup.
 *
 * So stdout is data, stderr is diagnostics, and they are never mixed. Passing
 * argv directly also removes the quoting problem rather than solving it.
 */
function docker(args: string[], cwd = process.cwd()): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const child = spawn("docker", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => res({ code: -1, out, err: `${err}${e.message}` }));
    child.on("close", (code: number | null) => res({ code: code ?? -1, out, err }));
  });
}

/** Both streams, for an error message. Anything that PARSES output uses `out`
 *  alone; this is only ever for something a human reads. */
function said(r: { out: string; err: string }, lines = 5): string {
  return `${r.out}${r.err}`
    .trim()
    .split("\n")
    .slice(-lines)
    .join(" ");
}

/** Ids from a `-q` listing: from stdout only, and only if id-shaped. Anything
 *  else is a diagnostic in the wrong stream, and feeding it back to `docker rm`
 *  used to be how teardown silently stopped working. */
function ids(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{12,64}$/.test(l));
}

export async function requireDocker(): Promise<void> {
  const r = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (r.code !== 0) {
    throw new Error(
      "docker is not usable, and the grader only runs containers.\n" +
        "  Student code must not run on the host, so there is no fallback.\n" +
        `  docker said: ${said(r, 3)}`,
    );
  }
}

/**
 * Is this a rootless daemon?
 *
 * It changes who a bind mount belongs to. Under rootless docker the host uid
 * maps to container uid 0, so passing `--user 1000:1000` for the deploy step
 * gives forge an unprivileged subuid that cannot write into the mount, and the
 * failure surfaces as "deployment did not print ATBT_TOKEN=", which points a
 * lecturer at the student's Deploy.s.sol instead of at the daemon.
 */
let rootless: boolean | undefined;
export async function isRootless(): Promise<boolean> {
  if (rootless === undefined) {
    const r = await docker(["info", "--format", "{{.SecurityOptions}}"]);
    rootless = r.code === 0 && r.out.includes("rootless");
  }
  return rootless;
}

/**
 * Build an image, or accept one that already exists.
 *
 * A manifest names either a dockerfile to build or an image to use. Building is
 * the normal path for a source submission; naming an image is for a solution
 * that ships one, and for re-running without a rebuild.
 */
/** Whether an image is present locally. Never pulls. */
export async function imageExists(tag: string): Promise<boolean> {
  return (await docker(["image", "inspect", tag])).code === 0;
}

export async function buildImage(
  spec: { image?: string; dockerfile?: string },
  contextDir: string,
  tag: string,
): Promise<string> {
  if (spec.image) {
    const r = await docker(["image", "inspect", spec.image]);
    if (r.code !== 0) throw new Error(`the manifest names image "${spec.image}", which does not exist locally`);
    return spec.image;
  }
  const dockerfile = spec.dockerfile ?? "docker/Dockerfile";
  const r = await docker(["build", "-q", "-f", dockerfile, "-t", tag, "."], contextDir);
  if (r.code !== 0) throw new Error(`building ${tag} from ${dockerfile} failed:\n    ${said(r, 20)}`);
  return tag;
}

/**
 * A failure of the grader's own machinery rather than of the submission.
 *
 * Reported as exit 2 and never as a failed scenario: a correct submission must
 * not lose marks because, say, docker ran out of address pools under --jobs.
 */
export class GraderError extends Error {}

// ------------------------------------------------------------------ offline

/**
 * Offline grading: no container the grader starts can reach the internet.
 *
 * Each scenario network is `--internal`, which drops all egress, and which also
 * stops ports published from it working at all, so the grader on the host could
 * no longer reach anything. So one relay per scenario sits on that network and
 * on an ordinary bridge, publishes the scenario's whole port block on
 * loopback, and forwards each port to whichever container `runDetached` said
 * should answer it. The relay is the only container with a route out, and it
 * runs nothing but the forwarding below.
 *
 * Done here rather than in the world, so every container, anvil and the
 * deploy included, is isolated without any caller knowing.
 */
let offline = false;
/** Per scenario network: the loopback port its relay answers on. */
const relays = new Map<string, number>();

export function setOffline(on: boolean): void {
  offline = on;
}

const RELAY_IMAGE = "node:22-alpine";

/**
 * A reverse proxy by path: `/<container>/<port>/rest` goes to
 * `http://<container>:<port>/rest` on the scenario network.
 *
 * One published port rather than one per process. Docker sets up forwarding
 * per published port, and publishing the scenario's forty took over thirty
 * seconds a scenario, which doubled a grading run. Everything the grader says
 * to a submission is HTTP, viem's JSON-RPC to anvil included, so routing by
 * path loses nothing, and it needs no table: the path says where to go.
 */
const RELAY_SCRIPT = `
const http = require("http");
http.createServer((req, res) => {
  const m = /^\\/([^/]+)\\/(\\d+)(\\/.*)?$/.exec(req.url);
  if (!m) { res.writeHead(404); return res.end(); }
  const up = http.request(
    { host: m[1], port: Number(m[2]), path: m[3] || "/", method: req.method, headers: { ...req.headers, host: m[1] + ":" + m[2] } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(Number(process.env.PORT), "0.0.0.0");
`;

async function startRelay(network: string, port: number): Promise<void> {
  const ext = `${network}-ext`;
  await docker(["network", "rm", ext]);
  const mk = ["network", "create"];
  for (const l of RUN_LABELS) mk.push("--label", l);
  const r1 = await docker([...mk, ext]);
  if (r1.code !== 0) throw new GraderError(`could not create network ${ext}: ${said(r1)}`);

  const relay = `${network}-relay`;
  const args = ["run", "-d", "--name", relay, "--network", ext];
  for (const l of RUN_LABELS) args.push("--label", l);
  args.push("-p", `127.0.0.1:${port}:${port}`, "-e", `PORT=${port}`, RELAY_IMAGE, "node", "-e", RELAY_SCRIPT);
  const r2 = await docker(args);
  if (r2.code !== 0) throw new GraderError(`could not start the offline relay for ${network}: ${said(r2)}`);
  const r3 = await docker(["network", "connect", network, relay]);
  if (r3.code !== 0) throw new GraderError(`could not join the relay to ${network}: ${said(r3)}`);

  for (let i = 0; i < 100; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    );
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  relays.set(network, port);
}

/**
 * Where the grader reaches `container`'s `containerPort`.
 *
 * Online, the port it was published on. Offline, nothing is published from the
 * internal network, so through the scenario's relay by path.
 */
export function loopbackUrl(network: string, container: string, containerPort: number, hostPort: number): string {
  if (!offline) return `http://127.0.0.1:${hostPort}`;
  const relay = relays.get(network);
  if (relay === undefined) throw new GraderError(`no offline relay for ${network}`);
  return `http://127.0.0.1:${relay}/${container}/${containerPort}`;
}

/**
 * @param base the scenario's port block. Offline, its first port is the relay's.
 */
export async function createNetwork(name: string, base?: number): Promise<void> {
  await docker(["network", "rm", name]);
  const args = ["network", "create"];
  for (const l of RUN_LABELS) args.push("--label", l);
  if (offline) args.push("--internal");
  args.push(name);
  const r = await docker(args);
  if (r.code !== 0) throw new GraderError(`could not create network ${name}: ${said(r)}`);
  if (offline) {
    if (base === undefined) throw new GraderError(`offline grading needs a port block for ${name}`);
    await startRelay(name, base);
  }
}

/**
 * Remove a network, and say so if it will not go.
 *
 * "has active endpoints" means a container is still attached, which means the
 * teardown before this one did not finish. Swallowing that leaked a network per
 * scenario, and docker only has fifteen /16s to hand out before
 * `network create` starts failing outright.
 */
export async function removeNetwork(name: string): Promise<void> {
  // The relay is attached to the scenario network, so it goes first, and its
  // outside bridge after.
  const relayed = relays.delete(name);
  if (relayed) await docker(["rm", "-f", `${name}-relay`]);
  const r = await docker(["network", "rm", name]);
  if (r.code !== 0 && !/not found/i.test(`${r.out}${r.err}`)) {
    console.error(`warning: could not remove network ${name}: ${said(r, 2)}`);
  }
  if (relayed) await removeNetwork(`${name}-ext`);
}

export interface ContainerOptions {
  name: string;
  /** The name other containers address it by inside the network. Distinct from `name`,
   *  which is prefixed per scenario so two scenarios cannot collide. */
  alias?: string;
  network: string;
  image: string;
  /** Command and arguments, already split. */
  argv: string[];
  entrypoint?: string;
  /** hostPort -> containerPort, published on loopback only. */
  publish: { host: number; container: number }[];
  /** hostPath -> containerPath, read-only unless `ro` is false. */
  mounts?: { from: string; to: string; ro?: boolean }[];
  env?: Record<string, string>;
  workdir?: string;
  /**
   * The uid:gid to run as.
   *
   * The deploy step needs one. It bind-mounts the solution's own directory and
   * forge writes `broadcast/`, `cache/` and `out/` into it, so running as root
   * leaves root-owned files in somebody's checkout that they then need sudo to
   * delete. Running as the host user is what makes those files theirs. See
   * `isRootless`, where that reasoning inverts.
   */
  user?: string;
}

function common(o: ContainerOptions): string[] {
  const args: string[] = [];
  for (const l of RUN_LABELS) args.push("--label", l);
  for (const m of o.mounts ?? []) {
    args.push("-v", `${m.from}:${m.to}${m.ro === false ? "" : ":ro"}`);
  }
  for (const [k, v] of Object.entries(o.env ?? {})) args.push("-e", `${k}=${v}`);
  if (o.workdir) args.push("-w", o.workdir);
  if (o.user) args.push("--user", o.user);
  if (o.entrypoint) args.push("--entrypoint", o.entrypoint);
  return args;
}

export async function runDetached(o: ContainerOptions): Promise<void> {
  const args = ["run", "-d", "--name", o.name, "--network", o.network];
  // The network alias is how containers address each other. It is the short name
  // rather than the per-scenario container name, so a config written for
  // compose and one written by the grader can say the same thing.
  if (o.alias) args.push("--network-alias", o.alias);
  // Nothing can be published from an internal network; offline, the relay
  // reaches the container by name instead. See loopbackUrl.
  if (!offline) for (const p of o.publish) args.push("-p", `127.0.0.1:${p.host}:${p.container}`);
  args.push(...common(o), o.image, ...o.argv);

  const r = await docker(args);
  if (r.code !== 0) throw new Error(`docker run ${o.name} failed: ${said(r)}`);
}

/**
 * Run to completion and return the output.
 *
 * On timeout the container is removed before the error propagates. Without
 * that, a deploy step that overran kept running with the solution's repo
 * mounted read-write, writing into it long after the grader had declared the
 * deployment failed.
 */
export async function runToCompletion(
  o: ContainerOptions,
  timeoutMs = 180000,
): Promise<{ code: number; out: string; err: string }> {
  const args = ["run", "--rm", "--name", o.name, "--network", o.network];
  args.push(...common(o), o.image, ...o.argv);
  try {
    return await withTimeout(docker(args), timeoutMs, `container ${o.name}`);
  } catch (e) {
    await remove(o.name);
    throw e;
  }
}

/**
 * Follow a container's output onto stdout, prefixed.
 *
 * Only under -v. The returned function detaches it: without that, an 18
 * scenario run accumulates a follower per container and prints output from
 * scenarios that finished ten minutes ago.
 */
export function follow(name: string, label: string): () => void {
  const child = spawn("docker", ["logs", "-f", "--tail", "0", name], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const emit = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.log(`    [${label}] ${line}`);
    }
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  child.on("error", () => {});
  return () => child.kill("SIGKILL");
}

export async function logs(name: string, tail = 200): Promise<string[]> {
  const r = await docker(["logs", "--tail", String(tail), name]);
  // Container output arrives on both streams, and a crash message is usually on
  // stderr. This one is for a human, so it takes both.
  return `${r.out}${r.err}`.split("\n").filter((l) => l.trim());
}

export type ContainerState = { kind: "running" } | { kind: "exited"; code: number } | { kind: "gone" };

/**
 * What is this container doing?
 *
 * Three states, not two. An earlier version returned null for both "still
 * running" and "docker could not tell me", so a container removed underneath
 * the readiness loop burned the full timeout and was then reported as having
 * never answered, rather than as having disappeared.
 */
export async function state(name: string): Promise<ContainerState> {
  const r = await docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name]);
  if (r.code !== 0) return { kind: "gone" };
  const [running, exit] = r.out.trim().split(/\s+/);
  if (running === "true") return { kind: "running" };
  const code = Number(exit);
  return { kind: "exited", code: Number.isFinite(code) ? code : -1 };
}

export async function remove(name: string): Promise<void> {
  await docker(["rm", "-f", name]);
}

/**
 * Remove what this run started.
 *
 * By label rather than by anything this process remembers, so it works after a
 * crash, but by THIS run's label, so a grader running beside it is untouched.
 */
export async function removeRun(): Promise<void> {
  await removeMatching(`${LABEL_RUN}=${RUN_ID}`);
}

/**
 * Remove what one scenario of this run started: its containers, by name
 * prefix, and its network.
 *
 * The per-scenario backstop. It used to remove everything this run had
 * started, which was right while scenarios ran one at a time and would delete
 * the scenarios running beside it under `--jobs`.
 */
export async function removeScenario(prefix: string): Promise<void> {
  const ps = await docker([
    "ps", "-aq",
    "--filter", `label=${LABEL_RUN}=${RUN_ID}`,
    "--filter", `name=^${prefix}-`,
  ]);
  const containers = ids(ps.out);
  if (containers.length > 0) {
    const r = await docker(["rm", "-f", ...containers]);
    if (r.code !== 0) console.error(`warning: could not remove containers: ${said(r, 2)}`);
  }
  // By exact name: `network ls` filters names by substring, so a filter would
  // also match another scenario whose prefix starts with this one. The network
  // is named after the prefix, so removing it by name is exact, and
  // removeNetwork warns if it will not go rather than leaking it silently.
  await removeNetwork(prefix);
  // Normally gone with the relay already; this catches a relay whose world
  // failed before registering it.
  if (offline) await removeNetwork(`${prefix}-ext`);
}

/**
 * Remove what any run started, ever.
 *
 * For startup only. A previous run killed with SIGKILL leaves containers that
 * hold the deterministic names and host ports this run needs, so they have to
 * go before anything starts. Never call this mid-run: it would delete a
 * concurrent grader's containers.
 */
export async function removeAllRuns(): Promise<void> {
  await removeMatching(`${LABEL_ALL}=1`);
}

async function removeMatching(filter: string): Promise<void> {
  const ps = await docker(["ps", "-aq", "--filter", `label=${filter}`]);
  const containers = ids(ps.out);
  if (containers.length > 0) {
    const r = await docker(["rm", "-f", ...containers]);
    if (r.code !== 0) console.error(`warning: could not remove containers: ${said(r, 2)}`);
  }
  // Networks after containers, never before: one with an endpoint still
  // attached refuses to go.
  const nets = await docker(["network", "ls", "-q", "--filter", `label=${filter}`]);
  const networks = ids(nets.out);
  if (networks.length > 0) {
    const r = await docker(["network", "rm", ...networks]);
    if (r.code !== 0) console.error(`warning: could not remove networks: ${said(r, 2)}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
}
