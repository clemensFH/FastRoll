#!/usr/bin/env tsx
/**
 * The grader.
 *
 * Usage:
 *   tsx grader/src/index.ts --task 1
 *   tsx grader/src/index.ts --task 3 --scenario 15 --verbose
 *   tsx grader/src/index.ts --manifest path/to/solution.json
 *   tsx grader/src/index.ts --jobs 4        four scenarios at a time
 *   tsx grader/src/index.ts --byzantine ts  byzantine validators from packages/malicious
 *   tsx grader/src/index.ts --check-setup   only: does it build, start and answer?
 *
 * It never imports a solution. It starts processes and talks to them over the
 * two frozen JSON-RPC interfaces, which is the only way one grader can score
 * seven different languages.
 */
import { loadManifest } from "./manifest.js";
import { clearPreviousRuns, stopAll, stopScenario } from "./proc.js";
import { printResult, printSummary, writeReport, type Result } from "./report.js";
import { Trace, withTrace } from "./trace.js";
import { makeWorld, scenarioPrefix, setByzantineSource, type World } from "./world.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import { SETUP_CHECKS } from "./setup.js";
import { Failed } from "./assert.js";
import { GraderError, setOffline } from "./docker.js";
import type { Ctx, Scenario } from "./scenarios/types.js";

/**
 * One flag, by long name or short.
 *
 * The short forms are here because three documents advertised `-v` and nothing
 * parsed it, so the one flag a person reaches for when a scenario fails did
 * nothing at all.
 */
const SHORT: Record<string, string> = { verbose: "v", task: "t", scenario: "s", jobs: "j" };

function arg(name: string, fallback?: string): string | undefined {
  const forms = [`--${name}`, ...(SHORT[name] ? [`-${SHORT[name]}`] : [])];
  for (const f of forms) {
    const i = process.argv.indexOf(f);
    if (i < 0) continue;
    const next = process.argv[i + 1];
    if (next && !next.startsWith("-")) return next;
    return "true";
  }
  return fallback;
}

async function main(): Promise<void> {
  const manifestPath = arg("manifest", "grader/solution.json")!;
  const taskFilter = arg("task");
  const only = arg("scenario");
  const verbose = arg("verbose") === "true";
  /** Where to write transcript.txt and result.json, the feedback a student
   *  gets. Nothing is written without it, so a student's own runs stay quiet. */
  const reportDir = arg("report");
  /** No container may reach the internet. Every image must already be built,
   *  because a build inside an offline run cannot fetch anything either. */
  if (arg("offline") === "true") setOffline(true);
  /** Where the byzantine validators come from: the tag of an image already
   *  loaded (the default), "ts" for packages/malicious, or "build" where the
   *  source is in the tree. */
  const byzantine = arg("byzantine");
  if (byzantine && byzantine !== "true") setByzantineSource(byzantine);
  /**
   * How many scenarios run at once. One by default.
   *
   * Each running scenario holds a docker network, and docker's default address
   * pools run out at about fifteen to thirty of them, fewer if anything else on
   * the machine holds networks. So parallelism is opt-in, for a grading machine
   * whose pools the operator has raised, and not something a student's laptop
   * should meet by surprise.
   */
  const jobs = Number(arg("jobs", "1"));
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a positive integer, got ${arg("jobs")}`);
  const manifest = loadManifest(manifestPath);

  /** Instead of the scenarios, one start-up check per task: see setup.ts. */
  const checkSetup = arg("check-setup") === "true";
  const pool = checkSetup ? SETUP_CHECKS : ALL_SCENARIOS;

  let chosen = pool;
  if (taskFilter) chosen = chosen.filter((s) => String(s.task) === taskFilter);
  if (only) chosen = chosen.filter((s) => String(s.id) === only);
  if (!checkSetup && ALL_SCENARIOS.length === 0) {
    // The skeleton ships this list empty on purpose, so this is the first
    // thing a student sees from the grader. Say what to do, not "no match".
    console.error("grader/src/scenarios/index.ts exports an empty ALL_SCENARIOS.");
    console.error("Write your scenarios there. The ones that will be graded are");
    console.error("named in the task hand-outs (task1.pdf to task3.pdf), and the");
    console.error("file itself carries a worked example.");
    process.exit(2);
  }
  // Ids name each scenario's network, containers and port block, so two
  // scenarios with one id collide, and under --jobs one tears the other down.
  // The last id whose 40-port block still fits below 65536 is 1162.
  const ids = [...ALL_SCENARIOS, ...SETUP_CHECKS].map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    console.error(
      `scenario id ${dup} is used twice. Ids name each scenario's containers, network and ports, ` +
        `and ${SETUP_CHECKS.map((s) => s.id).join(", ")} are reserved for --check-setup.`,
    );
    process.exit(2);
  }
  const big = ids.find((id) => !Number.isInteger(id) || id < 0 || 19000 + id * 40 + 39 > 65535);
  if (big !== undefined) {
    console.error(`scenario id ${big} is out of range: ids must be integers from 0 to 1162.`);
    process.exit(2);
  }
  if (chosen.length === 0) {
    const have = pool.map((s) => s.id).join(", ");
    throw new Error(`no scenarios matched. Defined ids: ${have}`);
  }

  console.log(`\x1b[1mGrading ${manifest.name}\x1b[0m from ${manifestPath}`);
  // Containers from a run that was killed hold the deterministic names and
  // host ports this run needs. By the ALL-runs label, which is correct here
  // and only here: mid-run this would delete a concurrent grader's work.
  await clearPreviousRuns();

  console.log(`  ${chosen.length} scenarios${jobs > 1 ? `, ${jobs} at a time` : ""}\n`);

  const results: Result[] = [];

  // A shared cursor rather than pre-split chunks, so a slow scenario does not
  // hold back the ones queued behind it in the same chunk.
  /** Failures of the grader's own machinery, which make the run exit 2. */
  const graderErrors: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chosen.length) {
      const s = chosen[next++];
      const r = await runOne(s);
      results.push(r);
      printResult(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, chosen.length) }, worker));

  await stopAll();
  // In id order, whatever order they finished in, so two runs diff cleanly.
  results.sort((a, b) => a.id - b.id);
  const passed = printSummary(results);
  if (reportDir) {
    writeReport(reportDir, results, { manifest: manifestPath, name: manifest.name, graderErrors });
    console.log(`\n  report written to ${reportDir}/transcript.txt and result.json`);
  }
  if (graderErrors.length > 0) {
    console.error("\nThe grader itself failed, so the results above are not a grade:");
    for (const e of graderErrors) console.error(`  ${e}`);
    process.exit(2);
  }
  process.exit(passed ? 0 : 1);

  async function runOne(s: Scenario): Promise<Result> {
    const notes: string[] = [];
    const worlds: World[] = [];
    // Each scenario gets its own port block, so a leftover process from a
    // previous scenario cannot silently answer for this one.
    const basePort = 19000 + s.id * 40;
    const ctx: Ctx = {
      manifest,
      basePort,
      verbose,
      note: (m) => notes.push(m),
      async world(o) {
        // Task 3 submits fraud proofs, and a zero challenge window means there
        // are no fraud proofs at all. One place to get that right rather than
        // seven scenarios each remembering.
        const challengeWindow = o.challengeWindow ?? (s.task === 3 ? 5000 : 0);
        const w = await makeWorld({ ...o, challengeWindow, manifest, basePort, verbose });
        worlds.push(w);
        return w;
      },
    };

    const startedAt = Date.now();
    const tr = new Trace();
    const logs: { name: string; lines: string[] }[] = [];
    let passed = false;
    let error: string | undefined;
    let skipped: string | undefined;

    if (s.task === 3 && !manifest.prover) {
      skipped = 'the manifest declares no "prover", and Task 3 cannot be graded without one';
    } else {
      try {
        await withTrace(tr, () => s.run(ctx));
        passed = true;
      } catch (e) {
        if (e instanceof GraderError) graderErrors.push(`scenario ${s.id}: ${e.message}`);
        error =
          e instanceof Failed
            ? e.message
            : `${e instanceof Error ? e.message : String(e)}${
                e instanceof Failed ? "" : "\n      (this is an error, not a failed assertion)"
              }`;
      }
    }

    // Before teardown, while the containers still exist: on a failure, what the
    // submission's own processes printed is often the whole explanation.
    if (!passed && reportDir) {
      for (const w of worlds) logs.push(...(await w.ownLogs().catch(() => [])));
    }
    for (const w of worlds) await w.stop().catch(() => {});
    // Backstop, by this scenario's container names rather than by anything
    // the loop remembers. A world that threw while starting up was never pushed onto
    // `worlds`, so the containers it had already started used to survive for
    // the rest of the run: nine per scenario, until the machine was thrashing
    // and every later scenario failed on a readiness timeout that had nothing
    // to do with the code being graded. After this line, the invariant is that
    // no scenario ever inherits a container. Scoped to this scenario, so the
    // ones running beside it under --jobs keep theirs.
    await stopScenario(scenarioPrefix(basePort)).catch(() => {});
    return {
      id: s.id,
      task: s.task,
      title: s.title,
      checks: s.checks,
      passed,
      skipped,
      ms: Date.now() - startedAt,
      error,
      notes,
      points: passed ? (s.points ?? 1) : 0,
      maxPoints: s.points ?? 1,
      transcript: tr.render(),
      logs,
    };
  }
}

main().catch(async (e) => {
  console.error(e);
  await stopAll();
  process.exit(2);
});
