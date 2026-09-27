#!/usr/bin/env node
// Where the e2e minutes went, printed after a run.
//
// The gate on fixed waits (e2e/fixedWaits.test.ts) stops a sleep being added
// without a reason; it says nothing about a case that got slow honestly, by
// doing more work or waiting on something that got slower. This is the other
// half: the slowest cases, every run, in the CI job summary, where the next
// person sees them without having to go looking.
//
// Deliberately NOT a gate. Wall-clock on a shared runner flakes, and a flaky
// gate gets muted, which is the argument docs/perf-ci.md settles: counts gate,
// timings report.
//
// Reads `.e2e/timings.txt`, which wdio.conf.ts writes under
// TERMIC_E2E_TIMING=1 as "<ms>  <suite> > <title>" per case.

import { readFileSync, appendFileSync, existsSync } from "node:fs";

const LOG = ".e2e/timings.txt";
/** How many rows to print. Enough to see a pattern, short enough to read. */
const TOP = 15;
/** Cases at or above this are worth a second look, and are marked. */
const SLOW_MS = 5_000;

if (!existsSync(LOG)) {
  console.log(`[e2e-slowest] no ${LOG} (run with TERMIC_E2E_TIMING=1)`);
  process.exit(0);
}

const rows = readFileSync(LOG, "utf8")
  .split("\n")
  .map(line => line.match(/^\s*(\d+)\s\s(.*)$/))
  .filter(Boolean)
  .map(m => ({ ms: Number(m[1]), name: m[2] }))
  .sort((a, b) => b.ms - a.ms);

if (!rows.length) {
  console.log("[e2e-slowest] no timings recorded");
  process.exit(0);
}

const total = rows.reduce((n, r) => n + r.ms, 0);
const slow = rows.filter(r => r.ms >= SLOW_MS);
const secs = ms => (ms / 1000).toFixed(1).padStart(6);

const lines = [
  `${rows.length} cases, ${(total / 1000 / 60).toFixed(1)} min of test time.`,
  `${slow.length} at or over ${SLOW_MS / 1000}s account for `
  + `${Math.round((slow.reduce((n, r) => n + r.ms, 0) / total) * 100)}% of it.`,
  "",
  ...rows.slice(0, TOP).map(r => `${secs(r.ms)}s  ${r.name}`),
];
console.log(lines.join("\n"));

// GitHub renders this under the job. Plain text in a code block: a table
// would wrap the long case names into uselessness.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Slowest e2e cases\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`,
  );
}
