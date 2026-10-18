// The engineer's part: approvals, feedback, rulings and the other decisions
// only they can make, each of which needs a message recorded from them.

import * as path from "node:path";
import { ACTIVE, capital, HelixError, now, oneLine } from "../lib/core.mjs";
import { loadConfig } from "../lib/config.mjs";
import { describeFinding, isStuck, rulingQuestion, sortFindings } from "../lib/findings.mjs";
import { appendLearning, LEARNING_SAVED } from "../lib/learnings.mjs";
import { NO_HOOK_HINT, nextAction, relayHint } from "../lib/next-action.mjs";
import { dirtyFiles, fingerprint, head, repoRoot, runDir, sessionId } from "../lib/repo.mjs";
import { advance, cpById, lastReply, logAttempt, recordReply, requiredGates } from "../lib/state.mjs";
import { loadRun, requireCurrent, transaction } from "../lib/store.mjs";
import { gateLine } from "./commit.mjs";
import { ensurePriorGates } from "./gates.mjs";

/** @import { Args, Awaiting, Checkpoint, Feedback, GateRecord, Ruling, Run } from "../lib/types.js" */

/** @param {Run} run @param {Awaiting["kind"][]} kinds @returns {Awaiting} */
function requireHumanReply(run, kinds) {
  const awaiting = run.awaiting;
  if (!awaiting || !kinds.includes(awaiting.kind)) {
    throw new HelixError(`Run '${run.id}' is not waiting for the engineer (${run.status}).`);
  }
  if (!awaiting.replies.length) {
    throw new HelixError(
      "No engineer reply has been recorded since approval was requested. Only the engineer can approve: " +
      `stop and wait for their message. ${NO_HOOK_HINT(run.id)}`);
  }
  return awaiting;
}

/** @param {Args} args */
export function cmdApprove(args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    const awaiting = requireHumanReply(run, ["plan", "checkpoint", "final"]);
    const { text: reply, via } = lastReply(awaiting);
    if (awaiting.kind === "final") {
      run.awaiting = null;
      run.accepted_at = now();
      run.history.push({ at: now(), event: "the engineer accepted the feature", reply });
    } else if (awaiting.kind === "plan") {
      const dirty = dirtyFiles(root);
      if (dirty.length) {
        throw new HelixError("Working tree has uncommitted changes. Each checkpoint commits " +
          `everything, so ask the engineer to commit or stash first:\n${dirty.slice(0, 20).join("\n")}`);
      }
      if (!head(root)) throw new HelixError("The repository has no commits yet. Make an initial commit first.");
      run.awaiting = null;
      run.plan_approval = reply;
      run.history.push({ at: now(), event: "plan approved", reply });
      advance(root, run);
    } else {
      const cp = cpById(run, /** @type {string} */ (awaiting.cp));
      const fp = fingerprint(root);
      if (fp !== awaiting.fingerprint) {
        throw new HelixError("The code changed after approval was requested, so the engineer approved a " +
          "different tree. Rerun the gates and request approval again.");
      }
      cp.gates.human = { status: "passed", fingerprint: fp, at: now(), mode: "engineer", reply, via };
      logAttempt(cp, "human", "passed");
      run.status = "building";
      run.awaiting = null;
      run.history.push({ at: now(), event: `${cp.id} approved`, reply });
    }
  });
  console.log(run.accepted_at && !run.awaiting && run.status === "done" ? "The feature is accepted. The run is finished."
    : "Approved.");
  console.log("Next:", nextAction(run, root));
}

/** @param {Args} args */
export function cmdFeedback(args) {
  const root = repoRoot();
  const { run, result: { kind, target } } = transaction(root, args._[0], (run) => {
    const awaiting = requireHumanReply(run, ["plan", "checkpoint", "final"]);
    const reply = lastReply(awaiting).text;
    /** @type {Feedback} */
    const entry = { at: now(), text: args.text, reply };
    let target;
    if (awaiting.kind === "plan") {
      run.plan_feedback = [...(run.plan_feedback ?? []), entry];
      run.status = "planning";
      run.awaiting = null;
      target = "plan";
    } else if (awaiting.kind === "checkpoint") {
      const cp = cpById(run, /** @type {string} */ (awaiting.cp));
      cp.feedback.push(entry);
      cp.feedback_fingerprint = fingerprint(root);
      delete cp.gates.human;
      logAttempt(cp, "human", "changes_requested");
      run.status = "building";
      run.awaiting = null;
      target = cp.id;
    } else {
      run.final_feedback = [...(run.final_feedback ?? []), entry];
      awaiting.replies = [];
      target = "final review";
    }
    if (args.learning) appendLearning(root, args.learning, `${run.id} ${target}`);
    run.history.push({ at: now(), event: `feedback on ${target}`, reply });
    return { kind: awaiting.kind, target };
  });
  console.log(`Feedback recorded on ${target}.${args.learning ? ` ${LEARNING_SAVED}` : ""}`);
  if (kind === "final") console.log(`Turn it into checkpoints with \`helix add ${run.id} --file <checkpoints.json>\`.`);
  else console.log("Next:", nextAction(run, root));
}

/** @param {Args} args */
export function cmdRequestApproval(args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const fp = fingerprint(root);
  const { run, result: { cp, mode } } = transaction(root, args._[0], (run) => {
    const cp = requireCurrent(run);
    if (cp.feedback_fingerprint === fp) {
      throw new HelixError(`The code has not changed since the engineer's feedback ("${cp.feedback.at(-1)?.text}"). ` +
        "Address it, rerun the gates, then request approval.");
    }
    ensurePriorGates(run, cp, "human", fp, config);
    const autonomy = run.autonomy;
    if (autonomy.remaining === null || autonomy.remaining > 0) {
      if (autonomy.remaining !== null) autonomy.remaining -= 1;
      cp.gates.human = { status: "passed", fingerprint: fp, at: now(), mode: "autonomous", reply: autonomy.granted_by };
      logAttempt(cp, "human", "passed");
      run.history.push({ at: now(), event: `${cp.id} auto-approved (autonomous mode)` });
      return { cp, mode: /** @type {const} */ ("autonomous") };
    }
    run.status = "awaiting_approval";
    run.awaiting = { kind: "checkpoint", cp: cp.id, since: now(), replies: [], fingerprint: fp };
    run.history.push({ at: now(), event: `${cp.id} awaiting engineer approval` });
    return { cp, mode: /** @type {const} */ ("engineer") };
  });
  const recurring = recurringNote(cp);
  if (mode === "autonomous") {
    console.log(`${cp.id}: autonomous mode approved it (the automated gates all passed). ` +
      `Run \`helix commit ${run.id}\`.`);
    if (recurring) console.log(`\n${recurring} The engineer is not stopping here: raise them at their next stop.`);
    return;
  }
  const evidence = requiredGates(cp, config).filter((g) => g !== "human")
    .map((g) => gateLine(cp, g, /** @type {GateRecord} */ (cp.gates[g])));
  console.log(`${cp.id} is ready for the engineer. Viewer: ${path.join(runDir(root, run.id), "viewer.html")}`);
  console.log(`Evidence:\n${evidence.join("\n")}`);
  if (recurring) console.log(recurring);
  console.log("STOP now. Tell the engineer what the checkpoint does, where to see it running, and the evidence " +
    `above, including anything the subagents changed beyond what was asked. Wait for approval or feedback.${relayHint(run)}`);
}

/**
 * Findings that raised a problem fixed in an earlier checkpoint again: the
 * implementer keeps making it, so it may deserve a learning.
 * @param {Checkpoint} cp
 */
function recurringNote(cp) {
  const recurring = (cp.findings ?? []).filter((f) => f.recurs);
  if (!recurring.length) return "";
  return "Recurring problems: the reviewers raised these again after they were fixed in an earlier checkpoint:\n" +
    recurring.map((f) => `- ${f.id} (again ${f.recurs}) ${f.file}:${f.line}: ${oneLine(f.problem)}`).join("\n") +
    "\nPropose a one-line learning for each to the engineer. Save only the ones they agree to, with `helix learn '<rule>'`.";
}

/** @param {Args} args */
export function cmdAutonomy(args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    const grantedBy = run.last_prompt?.text ?? "";
    if (args.off) {
      run.autonomy = { remaining: 0, granted_by: "" };
    } else {
      if (!grantedBy) {
        throw new HelixError("Autonomy must come from the engineer, but no engineer message is recorded for this " +
          `run. ${NO_HOOK_HINT(run.id)}`);
      }
      const count = Number(args.checkpoints);
      if (!args.all && !(Number.isInteger(count) && count > 0)) {
        throw new HelixError("Use --checkpoints N (N >= 1), --all or --off.");
      }
      run.autonomy = { remaining: args.all ? null : count, granted_by: grantedBy };
    }
    run.history.push({ at: now(), event: `autonomy set to ${run.autonomy.remaining ?? "all"}` });
  });
  const remaining = run.autonomy.remaining;
  console.log("Autonomy:", remaining === 0 ? "off (engineer approves every checkpoint)"
    : remaining === null ? "all remaining checkpoints" : `next ${remaining} checkpoint(s)`);
}

/**
 * The engineer may waive the UI gate for a checkpoint whose visual comparison
 * cannot be made meaningful (no comparable reference or device). Behavior and
 * adversarial review can never be waived, and the waiver needs a message from
 * the engineer recorded during this checkpoint.
 * @param {Args} args
 */
export function cmdWaive(args) {
  const root = repoRoot();
  const gate = args._[1];
  if (gate !== "ui") throw new HelixError("Only the ui gate can be waived; behavior and review always run.");
  const reason = String(args.reason ?? "").trim();
  if (!reason) throw new HelixError("--reason is required: record the engineer's ruling in their words.");
  const { run, result: cp } = transaction(root, args._[0], (run) => {
    const cp = requireCurrent(run);
    if (!cp.ui) throw new HelixError(`${cp.id} has no UI gate to waive.`);
    const said = run.last_prompt;
    if (!said || said.at < (cp.started_at ?? "")) {
      throw new HelixError("Only the engineer can waive the UI gate, and no message from them is recorded during " +
        `${cp.id}. Ask them and stop; run waive after they agree. ${NO_HOOK_HINT(run.id)}`);
    }
    cp.gates.ui = { status: "passed", fingerprint: "", at: now(), mode: "waived", reply: reason, via: said.via };
    logAttempt(cp, "ui", "waived");
    run.history.push({ at: now(), event: `${cp.id} ui gate waived by the engineer`, reply: said.text });
    return cp;
  });
  console.log(`${cp.id}: UI gate waived (${reason}).`);
  console.log("Next:", nextAction(run, root));
}

/**
 * The engineer settles a review finding: `fix` (the reviewer is right; the
 * fixer cannot dispute it any more) or `drop` (the finding is wrong; reviewers
 * are told never to raise it again, and a repeat does not block). Needs a
 * message from the engineer recorded after the finding was last raised.
 * @param {Args} args
 */
export function cmdRule(args) {
  const root = repoRoot();
  const [runId, rawId, decision] = args._;
  if (decision !== "fix" && decision !== "drop") throw new HelixError("The ruling is `fix` or `drop`.");
  const text = String(args.text ?? "").trim();
  if (!text) throw new HelixError("--text is required: the engineer's ruling, in their words.");
  const id = rawId.trim().toUpperCase();
  const { run } = transaction(root, runId, (run) => {
    const cp = requireCurrent(run);
    const f = (cp.findings ?? []).find((x) => x.id === id);
    if (!f) throw new HelixError(`${cp.id} has no review finding ${id}. \`helix findings ${run.id}\` lists them.`);
    if (f.status !== "open") throw new HelixError(`${id} is ${f.status}; only an open finding can be ruled on.`);
    const said = run.last_prompt;
    if (!said || said.at < f.raised_at) {
      throw new HelixError(`Only the engineer can rule on ${id}, and no message from them is recorded since it was ` +
        `raised. Ask them and stop; record the ruling after they answer. ${NO_HOOK_HINT(run.id)}`);
    }
    /** @type {Ruling} */
    const ruling = { decision, text, at: now(), attempt: cp.attempts.review ?? 0, via: said.via };
    f.ruling = ruling;
    if (decision === "drop") f.status = "dropped";
    run.history.push({ at: now(), event: `${cp.id} ${id}: the engineer ruled it ${decision === "fix" ? "must be fixed" : "wrong"}`, reply: said.text });
  });
  if (args.learning) appendLearning(root, args.learning, `${run.id} ${id}`);
  console.log(`${id}: ${decision === "fix" ? "must be fixed" : "dropped"}.${args.learning ? ` ${LEARNING_SAVED}` : ""}`);
  console.log("Next:", nextAction(run, root));
}

/** @param {Args} args */
export function cmdFindings(args) {
  const root = repoRoot();
  const run = loadRun(root, args._[0]);
  const cp = requireCurrent(run);
  const findings = cp.findings ?? [];
  if (!findings.length) {
    console.log(`${cp.id} has no tracked review findings.`);
    return;
  }
  for (const status of /** @type {const} */ (["open", "dropped", "resolved"])) {
    const group = sortFindings(findings.filter((f) => f.status === status));
    if (!group.length) continue;
    console.log(`${capital(status)}:\n${group.map((f) => (isStuck(f) ? `${describeFinding(f)}\n  Needs the engineer's ruling.` : describeFinding(f))).join("\n")}\n`);
  }
}

/**
 * For agents without a prompt hook: relay the engineer's message verbatim. It
 * is labelled as relayed wherever it is shown. Once a prompt hook has recorded
 * a message for the run, relaying is refused for good: the hook is the
 * trustworthy channel, and allowing both would let an agent answer for the
 * engineer before they reply.
 * @param {Args} args
 */
export function cmdReply(args) {
  const root = repoRoot();
  const text = String(args.text ?? "").trim();
  if (!text) throw new HelixError("--text is required: the engineer's message, word for word.");
  const { run } = transaction(root, args._[0], (run) => {
    if (run.hooked) {
      const latest = run.last_prompt ? ` It last recorded, at ${run.last_prompt.at}: "${run.last_prompt.text.slice(0, 200)}".` : "";
      throw new HelixError("A prompt hook records the engineer's messages for this run, so relaying is not " +
        `allowed.${latest} If that is their latest message, act on it (\`helix status ${run.id}\`); otherwise stop ` +
        "and wait for their reply. If the run moved to an agent without that hook, install it there " +
        "(`helix hooks <agent>`).");
    }
    recordReply(run, text.slice(0, 4000), "relay");
    run.history.push({ at: now(), event: "engineer message relayed by the agent", reply: text });
  });
  console.log("Recorded the engineer's message (relayed).");
  console.log("Next:", nextAction(run, root));
}

/**
 * Hands the run to whichever session's prompt hook fires next. For resuming in
 * an agent that does not expose its session id to commands.
 * @param {Args} args
 */
export function cmdClaim(args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    run.owner_session = sessionId();
    run.history.push({ at: now(), event: run.owner_session ? "claimed by a new session" : "released for the next session" });
  }, false);
  console.log(run.owner_session ? `Run claimed by session ${run.owner_session}.`
    : "Run released: the next message the engineer sends in this session claims it.");
  console.log("Next:", nextAction(run, root));
}

/** @param {Args} args */
export function cmdAsk(args) {
  const root = repoRoot();
  /** @type {string[]} */
  const findings = args.finding ?? [];
  const { run, result: question } = transaction(root, args._[0], (run) => {
    if (!ACTIVE.has(run.status)) throw new HelixError(`Run is '${run.status}'.`);
    const question = [args._[1], findings.length ? rulingQuestion(requireCurrent(run), findings) : ""]
      .filter(Boolean).join("\n\n");
    if (!question) throw new HelixError("Give the question, or --finding ID to ask for a ruling on a review finding.");
    run.awaiting = { kind: "input", since: now(), replies: [], resume: run.status, question };
    run.status = "awaiting_input";
    run.history.push({ at: now(), event: `asked the engineer: ${question}` });
    return question;
  });
  if (findings.length) console.log(`Question:\n${question}\n`);
  console.log(`Recorded. Ask the engineer your question now and stop; the run resumes on their reply.${relayHint(run)}`);
}

/** @param {Args} args */
export function cmdPause(args) {
  const root = repoRoot();
  transaction(root, args._[0], (run) => {
    if (run.status === "done" || run.status === "paused") throw new HelixError(`Run is already '${run.status}'.`);
    run.paused_from = run.status;
    run.status = "paused";
    run.history.push({ at: now(), event: "paused", reply: run.last_prompt?.text ?? null });
  });
  console.log("Paused. The Stop hook will not hold the session until `helix resume`.");
}

/** @param {Args} args */
export function cmdResume(args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    if (run.status !== "paused" && run.status !== "stalled") {
      throw new HelixError(`Run is '${run.status}', nothing to resume.`);
    }
    run.status = run.paused_from ?? run.stalled_from ?? "building";
    delete run.paused_from;
    delete run.stalled_from;
    run.stop_guard = null;
    run.history.push({ at: now(), event: "resumed" });
  });
  console.log("Resumed.");
  console.log("Next:", nextAction(run, root));
}
