// Starting a run and planning it: checkpoints, their test cases, and the plan
// the engineer approves.

import * as fs from "node:fs";
import * as path from "node:path";
import { bullet, HelixError, humanize, now, openFile, slugify } from "../lib/core.mjs";
import { loadConfig } from "../lib/config.mjs";
import { nextAction, relayHint } from "../lib/next-action.mjs";
import { newCheckpoint, validateCheckpoints, validateDecisions } from "../lib/plan.mjs";
import { repoRoot, runDir, sessionId, workDir } from "../lib/repo.mjs";
import { advance, cpById } from "../lib/state.mjs";
import { allRunIds, loadRun, readRunInput, saveRun, transaction, withLock } from "../lib/store.mjs";

/** @import { Args, Run, TestCase } from "../lib/types.js" */

/** @param {Args} args */
export function cmdNew(args) {
  const root = repoRoot();
  loadConfig(root);
  const runId = slugify(args._[0]);
  if (fs.existsSync(path.join(runDir(root, runId), "state.json"))) {
    throw new HelixError(`Run '${runId}' already exists. Use \`helix status ${runId}\`.`);
  }
  const busy = allRunIds(root).find((rid) => loadRun(root, rid).status !== "done");
  if (busy) {
    throw new HelixError(`Run '${busy}' is still in progress in this worktree. Gates fingerprint the whole working ` +
      "tree, so a second run here would mix its changes into the first. Start the new run in its own worktree " +
      `(\`git worktree add\`), or finish '${busy}' first.`);
  }
  /** @type {Run} */
  const run = {
    id: runId,
    title: args.title || humanize(args._[0]),
    goal: args.goal,
    reference: args.reference,
    target: args.target ?? "",
    status: "planning",
    owner_session: sessionId(),
    created_at: now(),
    checkpoints: [],
    current: null,
    autonomy: { remaining: 0, granted_by: "" },
    awaiting: null,
    last_prompt: null,
    stop_guard: null,
    history: [{ at: now(), event: "created" }],
  };
  withLock(root, runId, () => saveRun(root, run));
  fs.mkdirSync(workDir(root, runId), { recursive: true });
  console.log(`Created run '${runId}'.`);
  console.log(`Work dir (subagent plan files go here): ${workDir(root, runId)}`);
  console.log(`Viewer: ${path.join(runDir(root, runId), "viewer.html")}`);
  console.log("Next:", nextAction(run));
}

/** @param {Args} args */
export function cmdPlan(args) {
  const root = repoRoot();
  const input = readRunInput(root, args._[0], args.file);
  const specs = validateCheckpoints(input);
  const decisions = validateDecisions(input);
  const { run } = transaction(root, args._[0], (run) => {
    if (run.status !== "planning" && run.status !== "awaiting_plan_approval") {
      throw new HelixError(`The plan is locked once building starts (status '${run.status}'). ` +
        `Use \`helix add ${run.id} --file ...\` to append checkpoints.`);
    }
    run.checkpoints = [];
    for (const spec of specs) run.checkpoints.push(newCheckpoint(run, spec));
    run.plan_loaded_at = now();
    run.plan_decisions = decisions;
    run.status = "planning";
    run.awaiting = null;
    run.history.push({ at: now(), event: `plan loaded (${specs.length} checkpoints)` });
  });
  for (const cp of run.checkpoints) console.log(`${cp.id}: ${cp.title}${cp.ui ? "  [ui]" : ""}`);
  if (decisions.length) console.log(`Decisions for the engineer:\n${bullet(decisions)}`);
  console.log("Next:", nextAction(run));
}

/** @param {Args} args */
export function cmdTests(args) {
  const root = repoRoot();
  let data = readRunInput(root, args._[0], args.file);
  if (data && typeof data === "object" && !Array.isArray(data) && "checkpoints" in data) data = data.checkpoints;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HelixError('Expected {"checkpoints": {"cp-1": [ {name, given, when, then, kind}, ... ]}}');
  }
  const ids = Object.keys(data);
  const { run } = transaction(root, args._[0], (run) => {
    /** @type {string[]} */
    const problems = [];
    for (const [cpId, cases] of Object.entries(data)) {
      const cp = cpById(run, cpId);
      if (cp.status === "committed") {
        problems.push(`${cpId} is already committed`);
        continue;
      }
      if (!Array.isArray(cases) || !cases.length) {
        problems.push(`${cpId}: needs at least one test case`);
        continue;
      }
      /** @type {TestCase[]} */
      const clean = cases.map((c, i) => {
        const missing = ["name", "given", "when", "then"].filter((k) => !String(c?.[k] ?? "").trim());
        if (missing.length) problems.push(`${cpId} case ${i + 1}: missing ${missing.join(", ")}`);
        const kind = c?.kind ?? "happy";
        if (!["happy", "edge", "error"].includes(kind)) {
          problems.push(`${cpId} case ${i + 1}: kind must be happy, edge or error`);
        }
        /** @param {string} k */
        const field = (k) => String(c?.[k] ?? "").trim();
        return { id: `${cpId}.t${i + 1}`, kind, name: field("name"), given: field("given"), when: field("when"), then: field("then") };
      });
      if (clean.length > 2 && clean.every((c) => c.kind === "happy")) {
        problems.push(`${cpId}: only happy-path cases; dig for edge and error cases`);
      }
      cp.tests = clean;
    }
    if (problems.length) throw new HelixError(`Test cases rejected:\n  - ${problems.join("\n  - ")}`);
    run.history.push({ at: now(), event: `test cases for ${ids.join(", ")}` });
  });
  console.log(`Stored test cases for ${ids.join(", ")}.`);
  console.log("Next:", nextAction(run));
}

/** @param {Args} args */
export function cmdSubmitPlan(args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    if (run.status !== "planning") throw new HelixError(`Run is '${run.status}', not planning.`);
    if (!run.checkpoints.length) throw new HelixError("No checkpoints loaded.");
    const missing = run.checkpoints.filter((cp) => !cp.tests.length).map((cp) => cp.id);
    if (missing.length) throw new HelixError(`Checkpoints without test cases: ${missing.join(", ")}.`);
    run.status = "awaiting_plan_approval";
    run.awaiting = { kind: "plan", since: now(), replies: [], fingerprint: null };
    run.history.push({ at: now(), event: "plan submitted for approval" });
  });
  const viewer = path.join(runDir(root, run.id), "viewer.html");
  if (!args["no-open"]) openFile(viewer);
  console.log(`Plan submitted. Viewer: ${viewer}`);
  const decisions = run.plan_decisions ?? [];
  if (decisions.length) {
    console.log(`Ask the engineer to settle these decisions too:\n${bullet(decisions)}\nAn approval settles each ` +
      "one as recommended unless they say otherwise. If they decide otherwise, record it as plan feedback " +
      "(`helix feedback`), so the plan and its test cases follow.");
  }
  console.log(`STOP now and ask the engineer to review the plan in the viewer.${relayHint(run)}`);
}

/** @param {Args} args */
export function cmdAdd(args) {
  const root = repoRoot();
  const specs = validateCheckpoints(readRunInput(root, args._[0], args.file));
  const { run, result: added } = transaction(root, args._[0], (run) => {
    if (run.status === "planning" || run.status === "awaiting_plan_approval") {
      throw new HelixError("The plan is not approved yet; use `helix plan` to change it.");
    }
    const added = specs.map((spec) => {
      const cp = newCheckpoint(run, spec);
      run.checkpoints.push(cp);
      return cp.id;
    });
    if (run.status === "done") {
      run.awaiting = null;
      delete run.accepted_at;
      advance(root, run);
    }
    run.history.push({ at: now(), event: `added ${added.join(", ")}` });
    return added;
  });
  console.log(`Added ${added.join(", ")}. Plan test cases for them with \`helix tests ${run.id} --file ...\`.`);
  console.log("Next:", nextAction(run, root));
}
