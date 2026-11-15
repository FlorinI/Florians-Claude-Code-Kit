// stub-probe.mjs — a stand-in for `open-dialogues.mjs --probe`, started by the status line when
// CLAUDE_SL_DIALOGUE_PROBE names this file (spec 261105 §4, "The test seam").
//
// It appends one JSON line to the file named by STUB_PROBE_LOG — its pid, its argv after the script
// path, and its start time in epoch milliseconds — then sleeps STUB_PROBE_SLEEP_MS (default 0) and
// exits. Like the real probe, it never touches the guard file. It inherits the status line's
// environment, which is how the two STUB_PROBE_* variables reach it.

import { appendFileSync } from 'node:fs';

const log = process.env.STUB_PROBE_LOG;
if (log) {
  appendFileSync(log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), startedMs: Date.now() }) + '\n');
}
const sleepMs = Number(process.env.STUB_PROBE_SLEEP_MS) || 0;
if (sleepMs > 0) setTimeout(() => process.exit(0), sleepMs);
