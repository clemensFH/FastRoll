import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // skeleton/out is a generated tree with its own workspace, so it must not
    // be collected from here. Nor rust/: skeletons generated into
    // rust/target carry whole copies of packages/, and so do the submissions
    // a grading session extracts under .grader/.
    exclude: ["**/node_modules/**", "skeleton/out/**", "lib/**", "rust/**", ".grader/**", "infra/**"],
    // Longer than the 5s default because a test that runs a committee drives seven real
    // HTTP servers while the rest of the suite runs in parallel.
    testTimeout: 30000,
  },
});
