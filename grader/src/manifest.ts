/**
 * What the grader needs to know about a solution.
 *
 * The grader never imports a student's code, and never runs it on the host. It
 * builds an image, starts containers from it, and talks to them over the two
 * frozen JSON-RPC interfaces. That is the only way grading can be
 * language-agnostic, and the only way a lecturer can run twelve submissions
 * without any of them touching their machine.
 *
 * A manifest is therefore an image, four commands, and the promise that each
 * command takes a config file path as its last argument.
 *
 * The reference implementation ships a manifest of exactly this shape, so the
 * grader has no privileged path through its own code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ProcSpec {
  /** Argv, split on whitespace, run inside the image with the solution root as
   *  the working directory. The grader appends one argument: the path to this
   *  process's config file, mounted read-only at /config. */
  command: string;
  /** Extra environment, merged over what the grader supplies. */
  env?: Record<string, string>;
}

export interface ImageSpec {
  /** An image that already exists locally. Use this to grade a prebuilt
   *  submission, or to re-run without a rebuild. */
  image?: string;
  /** A Dockerfile to build, relative to `root`. The default builds the
   *  reference image, which is what a solution derived from the skeleton
   *  wants. */
  dockerfile?: string;
}

export interface Manifest {
  name: string;
  /** Solution root, relative to the manifest file. Also the build context. */
  root: string;
  /** How to get an image for this solution. Omitted means build
   *  `docker/Dockerfile` from the solution root. */
  image?: ImageSpec;
  /** Prints ATBT_REGISTRY=, ATBT_GATEWAY=, ATBT_ESCROW=, ATBT_TOKEN= on stdout. */
  deploy: ProcSpec;
  /** Serves fastpay_ and vapi_ on the ports its config names. */
  validator: ProcSpec;
  /** Serves the cast-compatible surface on the port its config names. */
  client: ProcSpec;
  /** Serves prover_ on the port its config names. Task 3 only. */
  prover?: ProcSpec;
  /** How long a process gets to answer its first RPC call. */
  readyTimeoutMs?: number;
}

const REQUIRED: (keyof Manifest)[] = ["name", "root", "deploy", "validator", "client"];

export function loadManifest(path: string): Manifest & { dir: string; rootDir: string } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  for (const k of REQUIRED) {
    if (raw[k] === undefined) throw new Error(`${path}: missing "${k}"`);
  }
  const dir = resolve(path, "..");
  return { ...raw, dir, rootDir: resolve(dir, raw.root) };
}

