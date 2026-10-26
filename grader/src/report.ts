/**
 * The result table.
 *
 * One thing here is a decision rather than formatting. The grader ships no
 * reference prover, so a Gateway that rejects valid proofs and a prover that
 * cannot build them fail identically. The report says so out loud instead of
 * pretending to diagnose which it was.
 */
export interface Result {
  id: number;
  task: number;
  title: string;
  checks: string;
  passed: boolean;
  skipped?: string;
  ms: number;
  error?: string;
  notes: string[];
  /** Earned and available. All or nothing per scenario. */
  points: number;
  maxPoints: number;
  /** Timestamped record of what the grader did, sent and received. */
  transcript: string;
  /** On failure, the tail of what each of the submission's processes printed. */
  logs: { name: string; lines: string[] }[];
}

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const GREY = "\x1b[90m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

export function printResult(r: Result): void {
  const mark = r.skipped ? `${YELLOW}skip${OFF}` : r.passed ? `${GREEN}pass${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  ${mark}  ${String(r.id).padStart(2)}. ${r.title} ${GREY}(${(r.ms / 1000).toFixed(1)}s)${OFF}`);
  for (const n of r.notes) console.log(`        ${GREY}${n}${OFF}`);
  if (r.skipped) console.log(`        ${YELLOW}${r.skipped}${OFF}`);
  if (!r.passed && r.error) {
    console.log(`        ${GREY}checks: ${r.checks}${OFF}`);
    for (const line of r.error.split("\n")) console.log(`        ${RED}${line}${OFF}`);
  }
}

export function printSummary(results: Result[]): boolean {
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.passed).length;
  const failed = ran.length - passed;
  const skipped = results.length - ran.length;

  console.log("");
  console.log(`${BOLD}Summary${OFF}`);
  for (const task of [1, 2, 3]) {
    const mine = results.filter((r) => r.task === task);
    if (mine.length === 0) continue;
    const okCount = mine.filter((r) => r.passed && !r.skipped).length;
    const total = mine.filter((r) => !r.skipped).length;
    const colour = okCount === total ? GREEN : RED;
    console.log(`  Task ${task}: ${colour}${okCount}/${total}${OFF}`);
  }
  const clean = failed === 0 && skipped === 0;
  console.log(
    `  Overall: ${clean ? GREEN : RED}${passed}/${ran.length}${OFF}` +
      (skipped ? ` ${RED}(${skipped} skipped, which is not a pass)${OFF}` : ""),
  );

  if (failed > 0) {
    console.log("");
    console.log(`${BOLD}Reading a Task 3 failure${OFF}`);
    console.log(
      `  ${GREY}No reference prover ships with this grader, on purpose. A Gateway that`,
    );
    console.log(`  rejects a valid proof and a prover that never builds one fail the same`);
    console.log(`  way here, and this table cannot tell you which it was. Start from the`);
    console.log(`  prover's own log: if it reported the fraud and the L1 call reverted, the`);
    console.log(`  Gateway is where to look. If it reported nothing, the prover is.${OFF}`);
  }
  // A skipped scenario is not a passed one. Omitting "prover" from a manifest
  // used to print 0/0 in green and exit 0, so any automation reading the exit
  // code recorded a full pass for a submission with no prover in it at all.
  return failed === 0 && skipped === 0;
}

/** How much of each process's output a failure report carries. */
const LOG_TAIL = 60;

/**
 * Write the feedback for one grading run: `transcript.txt`, which is what a
 * student reads, and `result.json`, which is what the grading session reads.
 *
 * The transcript says, for every scenario, what it checks, everything the
 * grader sent and received with a timestamp, whether it passed and what it was
 * worth, and for a failure what was expected and what the submission's own
 * processes printed. A running total follows each scenario, so the score is
 * never a number the student has to reconstruct.
 */
export function writeReport(
  dir: string,
  results: Result[],
  meta: { manifest: string; name: string; graderErrors: string[] },
): void {
  mkdirSync(dir, { recursive: true });
  const sorted = [...results].sort((a, b) => a.id - b.id);
  const total = sorted.reduce((n, r) => n + r.points, 0);
  const max = sorted.reduce((n, r) => n + r.maxPoints, 0);
  const commit = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();

  const out: string[] = [];
  const rule = "=".repeat(78);
  out.push(rule);
  out.push(`Grading report for ${meta.name}`);
  out.push(rule);
  out.push(`  manifest   ${meta.manifest}`);
  out.push(`  grader     ${commit}`);
  out.push(`  finished   ${new Date().toISOString()}`);
  out.push(`  score      ${total} / ${max} points`);
  out.push("");
  out.push("How to read this: every line is stamped with the seconds since its scenario");
  out.push("started. '->' is a request the grader sent, '<-' the answer, '<!' an error");
  out.push("answer, 'L1' an action on the chain, 'ok' a check that held, 'XX' the check");
  out.push("that failed. Byzantine validators are the lecture team's and marked as such.");
  if (meta.graderErrors.length > 0) {
    out.push("");
    out.push("THE GRADER ITSELF FAILED during this run, so this is not a grade:");
    for (const e of meta.graderErrors) out.push(`  ${e}`);
  }

  let running = 0;
  let runningMax = 0;
  for (const r of sorted) {
    running += r.points;
    runningMax += r.maxPoints;
    out.push("");
    out.push(rule);
    out.push(`Scenario ${r.id} (task ${r.task}): ${r.title}`);
    out.push(`  worth    ${r.maxPoints} points`);
    out.push(`  checks   ${r.checks}`);
    out.push(rule);
    if (r.transcript) out.push(r.transcript);
    out.push("");
    if (r.skipped) {
      out.push(`SKIPPED: 0 / ${r.maxPoints} points. ${r.skipped}`);
    } else if (r.passed) {
      out.push(`PASSED: ${r.points} / ${r.maxPoints} points`);
    } else {
      out.push(`FAILED: 0 / ${r.maxPoints} points`);
      out.push("  Why it failed:");
      for (const line of (r.error ?? "no reason recorded").split("\n")) out.push(`    ${line.trim()}`);
    }
    for (const n of r.notes) out.push(`  note: ${n}`);
    for (const l of r.logs) {
      out.push("");
      out.push(`  Last ${LOG_TAIL} lines your ${l.name} printed:`);
      for (const line of l.lines.slice(-LOG_TAIL)) out.push(`    | ${line}`);
    }
    out.push(`  running total: ${running} / ${runningMax} points`);
  }

  out.push("");
  out.push(rule);
  out.push("Score");
  out.push(rule);
  for (const task of [...new Set(sorted.map((r) => r.task))]) {
    const mine = sorted.filter((r) => r.task === task);
    out.push(`  Task ${task}: ${mine.reduce((n, r) => n + r.points, 0)} / ${mine.reduce((n, r) => n + r.maxPoints, 0)}`);
    for (const r of mine) {
      const mark = r.skipped ? "skip" : r.passed ? "pass" : "FAIL";
      out.push(`    ${mark}  ${String(r.id).padStart(2)}. ${r.title.padEnd(66)} ${String(r.points).padStart(3)} / ${r.maxPoints}`);
    }
  }
  out.push(`  Total: ${total} / ${max} points`);
  out.push("");

  writeFileSync(join(dir, "transcript.txt"), out.join("\n"));
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify(
      {
        manifest: meta.manifest,
        name: meta.name,
        grader: commit,
        finished: new Date().toISOString(),
        points: total,
        maxPoints: max,
        graderErrors: meta.graderErrors,
        scenarios: sorted.map((r) => ({
          id: r.id,
          task: r.task,
          title: r.title,
          passed: r.passed,
          skipped: r.skipped ?? null,
          points: r.points,
          maxPoints: r.maxPoints,
          ms: r.ms,
          error: r.error ?? null,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}
