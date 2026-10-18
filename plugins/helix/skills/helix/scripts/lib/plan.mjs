// The checkpoint plan: validating what the planner wrote, and whether the
// engineer asked for it to be revised.

import { HelixError, words } from "./core.mjs";

/** @import { Checkpoint, CheckpointSpec, Run } from "./types.js" */

/**
 * Decisions the planner raises for the engineer to settle when they review the plan.
 * @param {any} input
 * @returns {string[]}
 */
export function validateDecisions(input) {
  const decisions = input?.decisions ?? [];
  if (!Array.isArray(decisions) || decisions.some((d) => typeof d !== "string" || !d.trim())) {
    throw new HelixError("Checkpoint plan rejected: 'decisions' must be a list of non-empty strings.");
  }
  return decisions.map((d) => d.trim());
}

/** @param {any} input @returns {CheckpointSpec[]} */
export function validateCheckpoints(input) {
  const items = Array.isArray(input) ? input : input?.checkpoints;
  if (!Array.isArray(items) || !items.length) {
    throw new HelixError('Expected {"checkpoints": [ ... ]} with at least one checkpoint.');
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {CheckpointSpec[]} */
  const clean = [];
  items.forEach((item, index) => {
    const label = `checkpoint ${index + 1}`;
    if (!item || typeof item !== "object") {
      problems.push(`${label}: must be an object`);
      return;
    }
    const title = String(item.title ?? "").trim();
    const summary = String(item.summary ?? "").trim();
    const doneWhen = item.done_when ?? [];
    if (!title) problems.push(`${label}: missing title`);
    else if (words(title) > 8) {
      problems.push(`${label}: title '${title}' has ${words(title)} words (max 8, reviewable at a glance)`);
    }
    if (!summary) problems.push(`${label}: missing summary`);
    else if (words(summary) > 40) problems.push(`${label}: summary has ${words(summary)} words (max 40)`);
    if (!Array.isArray(doneWhen) || doneWhen.length < 1 || doneWhen.length > 6) {
      problems.push(`${label}: done_when must list 1-6 observable outcomes`);
    }
    if (typeof item.ui !== "boolean") {
      problems.push(`${label}: 'ui' must be true or false (does this checkpoint change what users see?)`);
    } else if (item.ui && !String(item.ui_scope ?? "").trim()) {
      problems.push(`${label}: ui checkpoints need ui_scope (which part of the screen to compare)`);
    }
    clean.push({
      title,
      summary,
      done_when: Array.isArray(doneWhen) ? doneWhen.map((d) => String(d).trim()) : [],
      ui: Boolean(item.ui),
      ui_scope: String(item.ui_scope ?? "").trim(),
      reference: (item.reference ?? []).map(String),
      test_command: String(item.test_command ?? "").trim(),
    });
  });
  if (problems.length) throw new HelixError(`Checkpoint plan rejected:\n  - ${problems.join("\n  - ")}`);
  return clean;
}

/**
 * When the current plan was loaded (runs from older versions only have it in their history).
 * @param {Run} run
 */
function planLoadedAt(run) {
  return run.plan_loaded_at ?? run.history.findLast((h) => h.event.startsWith("plan loaded"))?.at ?? "";
}

/**
 * Planning restarts when the engineer gave feedback on the plan after it was loaded.
 * @param {Run} run
 */
export const revisingPlan = (run) => (run.plan_feedback?.at(-1)?.at ?? "") > planLoadedAt(run);

/** @param {Run} run @param {CheckpointSpec} spec @returns {Checkpoint} */
export function newCheckpoint(run, spec) {
  return {
    id: `cp-${run.checkpoints.length + 1}`, status: "pending", tests: [], gates: {}, attempts: {}, feedback: [], ...spec,
  };
}
