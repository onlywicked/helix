// Briefs: the complete, self-contained instructions for one subagent role.

import * as fs from "node:fs";
import * as path from "node:path";
import { bullet, HelixError, nested, PROMPTS_DIR } from "../lib/core.mjs";
import { loadConfig } from "../lib/config.mjs";
import {
  describeFinding, describeFixed, fixedEarlier, isStuck, needsRuling, openFindings, RESPONSE_FORMAT, responsePath, sortFindings,
  unanswered,
} from "../lib/findings.mjs";
import { learningsPath, UNMERGED_LEARNINGS, unmergedLearnings } from "../lib/learnings.mjs";
import { nextAction } from "../lib/next-action.mjs";
import { revisingPlan } from "../lib/plan.mjs";
import { fingerprint, repoRoot, workDir } from "../lib/repo.mjs";
import { cpById, formatTests, gateState, requiredGates } from "../lib/state.mjs";
import { loadRun, requireCurrent } from "../lib/store.mjs";

/** @import { Args, Checkpoint, Config, Run } from "../lib/types.js" */

/** Each role's prompt in prompts/. */
const BRIEF_TEMPLATE = {
  planner: "checkpoint-planner.md", "test-planner": "test-planner.md", "test-writer": "test-writer.md",
  implementer: "implementer.md", fixer: "fixer.md",
};
/** @typedef {keyof typeof BRIEF_TEMPLATE} BriefRole */
export const BRIEF_ROLES = /** @type {BriefRole[]} */ (Object.keys(BRIEF_TEMPLATE));

/** @param {Checkpoint} cp */
function describeCheckpoint(cp) {
  return [
    `### ${cp.id}: ${cp.title}`,
    cp.summary,
    `Done when:\n${bullet(cp.done_when)}`,
    cp.ui ? `UI compared by the visual reviewer: ${cp.ui_scope}` : "Logic only (no UI review).",
    `Reference files:\n${bullet(cp.reference)}`,
  ].join("\n\n");
}

/**
 * What the fixer must resolve: unaddressed engineer feedback, else the first failed gate's evidence.
 * @param {string} root
 * @param {Run} run
 * @param {Checkpoint} cp
 * @param {Config} config
 */
function fixerEvidence(root, run, cp, config) {
  const fp = fingerprint(root);
  if (cp.feedback_fingerprint === fp) {
    return `Engineer feedback on this checkpoint (their words):\n\n> ${cp.feedback.at(-1)?.text}`;
  }
  for (const gate of requiredGates(cp, config)) {
    const state = gateState(cp, gate, fp);
    if (state === "passed") continue;
    const record = cp.gates[gate];
    if (state !== "failed" || !record?.evidence || record.fingerprint !== fp) break;
    const file = path.resolve(root, record.evidence);
    if (gate === "review" && cp.findings) return reviewEvidence(root, run, cp, file, /** @type {number} */ (record.attempt));
    const label = { behavior: "Behavior log", ui: "UI review report", review: "Adversarial review findings", human: "" }[gate];
    const extra = gate === "ui"
      ? "\n\nThe screenshots the reviewer compared are next to the report (pair-N-reference / pair-N-implementation)."
      : "";
    return `${label} (attempt ${record.attempt}): ${file}${extra}`;
  }
  throw new HelixError(`${cp.id} has nothing for the fixer to fix right now.\nNext: ${nextAction(run, root, config)}`);
}

/**
 * The open review findings, each to be fixed or disputed, and where the fixer answers them.
 * @param {string} root
 * @param {Run} run
 * @param {Checkpoint} cp
 * @param {string} report
 * @param {number} attempt
 */
function reviewEvidence(root, run, cp, report, attempt) {
  const stuck = openFindings(cp).filter(isStuck);
  if (stuck.length) throw new HelixError(`${cp.id}: ${needsRuling(run.id, stuck)}`);
  const due = sortFindings(openFindings(cp).filter(unanswered));
  if (!due.length) {
    throw new HelixError(`${cp.id}: every review finding is answered or dropped; rerun the review gate.`);
  }
  const attempts = new Set(due.map((f) => /** @type {number} */ (f.raised.at(-1))));
  const answers = [...attempts].map((a) => responsePath(root, run.id, cp, a));
  return [
    `Adversarial review findings (attempt ${attempt}): ${report}`,
    `Answer every finding below in ${answers.join(" and ")}, one entry per id:\n\n${RESPONSE_FORMAT}`,
    "- `fixed`: you changed the code as required. Say what you changed.\n" +
    "- `disputed`: the finding is factually wrong. Give the evidence (file and line, test, guideline). The " +
    "reviewer sees it; if they raise the finding again, the engineer decides. Never dispute a finding just to " +
    "avoid work, and never dispute one the engineer ruled must be fixed.\n" +
    "- Two reviewers may describe the same problem. Fix it once and answer both ids.\n" +
    "- A finding raised again after you answered `fixed` is not fixed yet. Read the new problem text closely.",
    `Findings:\n\n${due.map(describeFinding).join("\n\n")}`,
  ].join("\n\n");
}

/**
 * A complete, self-contained brief for one subagent role: the role's prompt
 * plus every input it needs, written to the run's work dir. Any agent can hand
 * a subagent "Read <file> and follow it", or follow it itself.
 * @param {Args} args
 */
export function cmdBrief(args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const [runId, roleName] = args._;
  const role = BRIEF_ROLES.find((r) => r === roleName);
  if (!role) throw new HelixError(`Unknown role '${roleName}'. Use ${BRIEF_ROLES.join(", ")}.`);
  const run = loadRun(root, runId);
  const work = workDir(root, run.id);
  /** @param {Checkpoint} [cp] */
  const testCommand = (cp) => cp?.test_command || config.test_command || "(none configured: ask the engineer)";
  const common = [
    `- Repository root: ${root}`,
    `- Goal (the engineer's words): ${run.goal}`,
    `- Reference: ${run.reference}`,
    `- Target: ${run.target || "(not specified)"}`,
    `- Guidelines (the written standard):\n${nested(config.guidelines.map((g) => path.join(root, g)))}`,
    `- Design documents:\n${nested(config.design.map((d) => path.join(root, d)))}`,
    `- Learnings file (engineer rules, apply all of them): ${learningsPath(root)}`,
  ];
  const unmerged = unmergedLearnings(root);
  if (unmerged.length) common.push(`- ${UNMERGED_LEARNINGS}\n${nested(unmerged.map((l) => l.slice(2)))}`);
  if (run.plan_approval) {
    common.push(`- The engineer's words when approving the plan (where they differ from the goal, they win): ` +
      `"${run.plan_approval}"`);
  }
  /** @type {string[]} */
  const sections = [];
  let name;
  if (role === "planner") {
    name = "plan-planner";
    const output = path.join(work, "checkpoints.json");
    sections.push(common.join("\n"), `- Output path: ${output}`);
    if (run.status === "done" || run.checkpoints.some((cp) => cp.status !== "pending")) {
      const since = run.awaiting?.since ?? "";
      const open = (run.final_feedback ?? []).filter((f) => f.at >= since).map((f) => f.text);
      sections.push("## Final feedback on the finished work\n\nPlan only NEW checkpoints that address this " +
        `feedback. They are appended after the existing ones.\n\n${bullet(open)}`);
      sections.push(`## Existing checkpoints\n\n${run.checkpoints.map((cp) => `- ${cp.id} ${cp.title} (${cp.status})`).join("\n")}`);
    } else if (revisingPlan(run)) {
      sections.push("## Revise the current plan\n\nThe engineer asked for changes. Rewrite the whole plan to address " +
        `them.\n\nTheir feedback:\n${bullet((run.plan_feedback ?? []).map((f) => f.text))}\n\nCurrent plan:\n\n` +
        run.checkpoints.map(describeCheckpoint).join("\n\n"));
    }
  } else if (role === "test-planner") {
    const only = args.checkpoint ? cpById(run, args.checkpoint) : null;
    if (only?.status === "committed") throw new HelixError(`${only.id} is committed; its test cases are final.`);
    const targets = only ? [only] : run.checkpoints.filter((cp) => cp.status !== "committed" && !cp.tests.length);
    if (!targets.length) {
      throw new HelixError("Every open checkpoint already has test cases. To re-plan one after the engineer changed " +
        `what it should do, use \`helix brief ${run.id} test-planner --checkpoint <id>\`.`);
    }
    name = only ? `${only.id}-test-planner` : "plan-test-planner";
    sections.push(common.join("\n"), `- Test command: ${testCommand()}`, `- Output path: ${path.join(work, "tests.json")}`);
    const replanning = only && only.tests.length
      ? `\n\n## Re-plan ${only.id}\n\nThe engineer changed what this checkpoint should do. Rewrite its whole case ` +
        `list so it matches their feedback; the new list replaces the old one.\n\nTheir feedback:\n` +
        `${bullet(only.feedback.map((f) => f.text))}\n\nCurrent cases:\n${formatTests(only)}`
      : "";
    sections.push(`## Checkpoints to plan\n\n${targets.map(describeCheckpoint).join("\n\n")}${replanning}`);
    if (run.plan_decisions?.length && !run.plan_approval) {
      sections.push("## Decisions the engineer has not settled yet\n\nThey settle these when they review the plan. " +
        "Plan cases for the recommended option. In your report, name the case ids that depend on each decision, so " +
        `they can be re-planned if the engineer decides otherwise.\n\n${bullet(run.plan_decisions)}`);
    }
  } else {
    const cp = requireCurrent(run);
    name = `${cp.id}-${role}`;
    sections.push(common.join("\n"), `- Test command (run from the repository root): ${testCommand(cp)}`);
    sections.push(`## The checkpoint\n\n${describeCheckpoint(cp)}`);
    sections.push(`## Planned test cases\n\n${formatTests(cp)}`);
    if (role === "fixer") sections.push(`## Evidence to resolve\n\n${fixerEvidence(root, run, cp, config)}`);
    else {
      if (cp.feedback.length) {
        sections.push(`## Earlier engineer feedback on this checkpoint\n\n${bullet(cp.feedback.map((f) => f.text))}`);
      }
      const fixed = fixedEarlier(run);
      if (fixed.length) {
        sections.push("## Review findings fixed in earlier checkpoints\n\nReviewers sent these back in this run's " +
          `earlier checkpoints. Do not make the same mistakes:\n\n${fixed.map(describeFixed).join("\n")}`);
      }
    }
  }
  const template = fs.readFileSync(path.join(PROMPTS_DIR, BRIEF_TEMPLATE[role]), "utf8").trim();
  const file = path.join(work, "briefs", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${template}\n\n## Your inputs\n\n${sections.join("\n\n")}\n`);
  console.log(`Brief: ${file}`);
  console.log(`Give a fresh subagent this task: "Read ${file} and do exactly what it says." ` +
    "Without subagents, read and follow it yourself.");
}
