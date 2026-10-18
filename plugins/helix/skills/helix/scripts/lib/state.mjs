// The run model: checkpoints, their gates, and the engineer's replies. These
// functions change a run in memory; store.mjs loads and saves it.

import { GATES, HelixError, now } from "./core.mjs";
import { head } from "./repo.mjs";

/** @import { Attempt, Awaiting, Checkpoint, Config, Gate, GateState, ReplyChannel, Run } from "./types.js" */

/** @param {Run} run @param {string} cpId @returns {Checkpoint} */
export function cpById(run, cpId) {
  const cp = run.checkpoints.find((c) => c.id === cpId);
  if (!cp) throw new HelixError(`Run '${run.id}' has no checkpoint '${cpId}'.`);
  return cp;
}

/** @param {Run} run */
export const currentCp = (run) => (run.current ? cpById(run, run.current) : null);

/** @param {Checkpoint} cp @param {Config} config @returns {Gate[]} */
export function requiredGates(cp, config) {
  const ui = cp.ui && config.ui.enabled !== false;
  return GATES.filter((g) => g !== "ui" || ui);
}

/**
 * passed | stale | failed | invalid | error | pending, relative to tree fp.
 * @param {Checkpoint} cp
 * @param {Gate} gate
 * @param {string | null} fp
 * @returns {GateState}
 */
export function gateState(cp, gate, fp) {
  const record = cp.gates[gate];
  if (!record) return "pending";
  if (record.mode === "waived") return "passed";
  if (record.status === "passed") return fp === null || record.fingerprint === fp ? "passed" : "stale";
  return record.status;
}

/**
 * @param {Checkpoint} cp
 * @param {Gate} gate
 * @param {Attempt["status"]} status
 * @param {number} [attempt]
 */
export function logAttempt(cp, gate, status, attempt) {
  cp.log ??= [];
  const n = attempt ?? cp.log.filter((a) => a.gate === gate).length + 1;
  cp.log.push({ gate, attempt: n, status, at: now() });
}

/** @param {Checkpoint} cp @param {Gate} gate @returns {number} */
export function nextAttempt(cp, gate) {
  cp.attempts ??= {};
  const attempt = (cp.attempts[gate] ?? 0) + 1;
  cp.attempts[gate] = attempt;
  return attempt;
}

/** @param {string} root @param {Run} run @param {Checkpoint} cp */
function startCheckpoint(root, run, cp) {
  cp.status = "in_progress";
  cp.base = head(root);
  cp.started_at = now();
  run.current = cp.id;
}

/** @param {string} root @param {Run} run */
export function advance(root, run) {
  const pending = run.checkpoints.find((cp) => cp.status === "pending");
  if (pending) {
    startCheckpoint(root, run, pending);
    run.status = "building";
  } else {
    run.current = null;
    run.status = "done";
    run.awaiting = { kind: "final", since: now(), replies: [] };
  }
}

/**
 * The engineer's message reached Helix: through the prompt hook, or relayed by the agent.
 * @param {Run} run
 * @param {string} text
 * @param {ReplyChannel} via
 */
export function recordReply(run, text, via) {
  const reply = { at: now(), text, via };
  run.last_prompt = reply;
  const awaiting = run.awaiting;
  if (awaiting) {
    awaiting.replies.push(reply);
    if (awaiting.kind === "input") {
      run.status = awaiting.resume ?? "building";
      run.awaiting = null;
      run.history.push({ at: now(), event: "the engineer answered", reply: text });
    }
  }
  run.stop_guard = null;
}

/** @param {Awaiting} awaiting */
export const lastReply = (awaiting) => {
  const reply = awaiting.replies.at(-1);
  if (!reply) throw new HelixError("No engineer reply has been recorded.");
  return reply;
};

/** @param {Checkpoint} cp */
export function formatTests(cp) {
  return cp.tests
    .map((t) => `- [${t.id}] (${t.kind ?? "happy"}) ${t.name}: given ${t.given}; when ${t.when}; then ${t.then}`)
    .join("\n") || "(none)";
}
