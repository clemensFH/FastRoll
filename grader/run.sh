#!/usr/bin/env bash
# Grade a solution against the scenario matrix.
#
#   grader/run.sh                       every scenario in grader/src/scenarios/index.ts
#   grader/run.sh --task 1              one task
#   grader/run.sh --scenario 15 -v      one scenario, with process output
#   grader/run.sh --manifest path.json  a different manifest
#   grader/run.sh --jobs 4              four scenarios at a time, for a grading
#                                       machine with raised docker address pools
#
# Exit codes: 0 all passed, 1 something failed, 2 the grader itself broke.
set -euo pipefail
cd "$(dirname "$0")/.."

# docker and npx only. anvil, forge and cast come from a container, so the
# machine running the grader needs neither foundry nor the solution's runtime.
for tool in docker npx; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH"; exit 2; }
done
docker version >/dev/null 2>&1 || { echo "docker is not usable; the grader only runs containers"; exit 2; }

# Leftovers from an interrupted run are cleared by the grader itself, which
# removes networks as well as containers and reports what it could not remove.
# Doing it here too would only duplicate that, and the shell version swept
# containers while leaving up to eighteen networks behind: docker hands out
# fifteen /16s before `network create` starts failing outright.

exec npx tsx grader/src/index.ts "$@"
