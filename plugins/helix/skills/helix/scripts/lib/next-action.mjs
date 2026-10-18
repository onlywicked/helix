// The single next step the orchestrator must take, printed after every command
// and fed back to the agent by the Stop hook.

import * as fs from "node:fs";
import * as path from "node:path";
import { capital, DEFAULT_CONFIG, MAX_IDENTICAL_STOPS } from "./core.mjs";
import { loadConfig } from "./config.mjs";
import { isStuck, needsRuling, openFindings, responsePath, unanswered } from "./findings.mjs";
import { revisingPlan } from "./plan.mjs";
import { fingerprint, workDir } from "./repo.mjs";
import { currentCp, gateState, requiredGates } from "./state.mjs";

/** @import { Config, Run } from "./types.js" */

/**
 * For agents without a prompt hook: how the engineer's next message reaches Helix.
 * @param {Run} run
 */
export const relayHint = (run) => run.hooked ? "" : (" No prompt hook has recorded the engineer's messages for this " +
  `run, so relay their reply word for word first: \`helix reply ${run.id} --text '<their exact words>'\`.`);

/**
 * What to do when an engineer message did not reach Helix.
 * @param {string} rid
 */
export const NO_HOOK_HINT = (rid) =>
  "If they already replied, no prompt hook recorded it: arm the hooks (see the skill's \"Hooks\" section), or " +
  `relay their message word for word with \`helix reply ${rid} --text "<their exact words>"\`.`;

/**
 * The single next step the orchestrator must take. The Stop hook feeds this
 * back to the agent, so it has to be concrete.
 * @param {Run} run
 * @param {string | null} [root]
 * @param {Config | null} [config]
 * @returns {string}
 */
export function nextAction(run, root = null, config = null) {
  const rid = run.id;
  /** @param {string} name */
  const work = (name) => (root ? path.join(workDir(root, rid), name) : `<work>/${name}`);
  const awaiting = run.awaiting;
  const replied = awaiting?.replies.at(-1);
  if (awaiting && replied && awaiting.kind !== "input") {
    const subject = { plan: "the plan", checkpoint: `checkpoint ${awaiting.cp}`, final: "the finished feature" }[awaiting.kind];
    const approve = awaiting.kind === "final" ? `helix approve ${rid} --message '<subject>'` : `helix approve ${rid}`;
    return (`The engineer replied about ${subject}: "${replied.text.slice(0, 300)}". If they approve it, run ` +
      `\`${approve}\`; if they ask for changes, \`helix feedback ${rid} --text '<their words>'\` ` +
      "(add --learning for a lasting rule). Then carry out anything else they asked for, such as autonomy.");
  }
  const relay = relayHint(run);
  switch (run.status) {
    case "planning": {
      if (!run.checkpoints.length || revisingPlan(run)) {
        return (`Dispatch a subagent with the brief from \`helix brief ${rid} planner\`, then load its output ` +
          `with \`helix plan ${rid} --file ${work("checkpoints.json")}\`.`);
      }
      const missing = run.checkpoints.filter((cp) => !cp.tests.length).map((cp) => cp.id);
      if (missing.length) {
        return (`Dispatch a subagent with the brief from \`helix brief ${rid} test-planner\` (plans ` +
          `${missing.join(", ")}), then \`helix tests ${rid} --file ${work("tests.json")}\`.`);
      }
      return `Plan and test cases are ready: run \`helix submit-plan ${rid}\` and stop for the engineer's approval.`;
    }
    case "awaiting_plan_approval":
      return ("STOP. The engineer is reviewing the checkpoint plan in the viewer. On their reply run " +
        `\`helix approve ${rid}\` (approval) or \`helix feedback ${rid} --text ...\` (changes).${relay}`);
    case "awaiting_approval":
      return ("STOP. The engineer is reviewing this checkpoint. On their reply run " +
        `\`helix approve ${rid}\` or \`helix feedback ${rid} --text ...\`.${relay}`);
    case "awaiting_input":
      return `STOP. Waiting for the engineer to answer: "${run.awaiting?.question ?? ""}".${relay}`;
    case "paused":
      return `Run is paused. Resume with \`helix resume ${rid}\` when the engineer asks.`;
    case "stalled":
      return (`Run stalled (no progress across ${MAX_IDENTICAL_STOPS} stop attempts). Tell the engineer what is ` +
        `blocking you. Resume with \`helix resume ${rid}\`.`);
    case "done":
      if (!run.awaiting) return "The engineer accepted the feature. Nothing left to do.";
      if ((run.final_feedback?.at(-1)?.at ?? "") >= run.awaiting.since) {
        return (`Turn the engineer's final feedback into checkpoints: dispatch a subagent with the brief from ` +
          `\`helix brief ${rid} planner\`, then \`helix add ${rid} --file ${work("checkpoints.json")}\` ` +
          "(it re-opens the run).");
      }
      return ("STOP. All checkpoints are committed. Ask the engineer to test the whole feature. If they accept it, " +
        `run \`helix approve ${rid} --message '<subject>'\`; otherwise \`helix feedback ${rid} --text ...\`.${relay}`);
  }
  const cp = currentCp(run);
  if (!cp) return `No current checkpoint. Run \`helix status ${rid}\`.`;
  if (!cp.tests.length) {
    return (`${cp.id} has no planned test cases: dispatch a subagent with the brief from ` +
      `\`helix brief ${rid} test-planner\`, then \`helix tests ${rid} --file ${work("tests.json")}\`.`);
  }
  const fp = root ? fingerprint(root) : null;
  const fixer = `dispatch a subagent with the brief from \`helix brief ${rid} fixer\``;
  if (fp && cp.feedback_fingerprint === fp) {
    return (`${cp.id}: the engineer's feedback is not addressed yet ("${cp.feedback.at(-1)?.text}"): ${fixer}, ` +
      `then rerun the gates from \`helix gate behavior ${rid}\`.`);
  }
  const cfg = config ?? (root ? loadConfig(root) : DEFAULT_CONFIG);
  for (const gate of requiredGates(cp, cfg)) {
    const state = gateState(cp, gate, fp);
    if (state === "passed") continue;
    const last = cp.gates[gate];
    const where = last?.evidence ? ` Evidence: ${root ? path.resolve(root, last.evidence) : last.evidence}.` : "";
    const rerun = `\`helix gate ${gate} ${rid}\``;
    const changed = fp !== null && last !== undefined && last.fingerprint !== fp;
    if (gate === "behavior") {
      if (state === "pending") {
        return (`${cp.id}: build it with two subagents in turn. First \`helix brief ${rid} test-writer\` (failing ` +
          `tests); once it reports, \`helix brief ${rid} implementer\`. Then run ${rerun}. This step reads the same ` +
          "until the behavior gate runs.");
      }
      if (state === "failed" && !changed) return `${cp.id}: the behavior gate failed.${where} ${capital(fixer)}, then ${rerun}.`;
      return `${cp.id}: the code changed since the behavior gate last ran; run ${rerun}.`;
    }
    if (state === "error") {
      return (`${cp.id}: the ${gate} gate could not finish (a reviewer crashed, timed out or is not installed).` +
        `${where} Read the reviewer's *.raw.txt beside it. If setup is the cause (a missing CLI, auth), fix it or ` +
        `tell the engineer, then run ${rerun} again. Never dispatch the fixer for an error.`);
    }
    if (gate === "ui") {
      const capture = (`capture the reference and the implementation in the same state as PNGs under ` +
        `${work("shots")}/ (compare: ${cp.ui_scope || "the whole screen"}), then \`helix gate ui ${rid} ` +
        "--pair REF IMPL STATE`");
      if (state === "invalid") return `${cp.id}: the screenshots showed different states.${where} Re-${capture}.`;
      if (state === "failed" && !changed) {
        return `${cp.id}: the UI review failed.${where} ${capital(fixer)}, run the behavior gate again, then ${capture}.`;
      }
      return `${cp.id}: ${capture}.`;
    }
    if (gate === "review") {
      if (state !== "failed") return `${cp.id}: run ${rerun}.`;
      const stuck = openFindings(cp).filter(isStuck);
      const said = run.last_prompt;
      if (stuck.length && said && stuck.every((f) => said.at >= f.raised_at)) {
        return (`${cp.id}: the engineer replied: "${said.text.slice(0, 300)}". Record their ruling on ` +
          `${stuck.map((f) => f.id).join(", ")}: \`helix rule ${rid} <id> fix|drop --text '<their words>'\`.`);
      }
      if (stuck.length) return `${cp.id}: ${needsRuling(rid, stuck)}`;
      if (changed) return `${cp.id}: the code changed since the last review failed; run ${rerun}.`;
      const due = openFindings(cp).filter(unanswered);
      if (cp.findings && !due.length) return `${cp.id}: no review finding is left to fix; run ${rerun}.`;
      const answered = root && due.length && last?.attempt !== undefined &&
        fs.existsSync(responsePath(root, rid, cp, last.attempt));
      if (answered) {
        return (`${cp.id}: the fixer answered the review without changing code; run ${rerun} so the reviewers ` +
          "weigh its answers.");
      }
      return (`${cp.id}: the adversarial review failed.${where} ${capital(fixer)}, then run the behavior gate ` +
        `again (and the UI gate if anything visible changed) before ${rerun}.`);
    }
    return `${cp.id}: automated gates passed. Run \`helix request-approval ${rid}\`.`;
  }
  return `${cp.id}: all gates passed. Run \`helix commit ${rid} --message '<subject>'\`.`;
}
