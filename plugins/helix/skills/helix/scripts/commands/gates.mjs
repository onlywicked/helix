// The automated gates: behavior tests, UI review and adversarial code review.
// Each runs here, never in the orchestrator, and its verdict is bound to the
// tree fingerprint it ran on.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bullet, GATE_NAME, GateExit, git, HelixError, imageSize, now, oneLine, pad3, PROMPTS_DIR, relTo } from "../lib/core.mjs";
import { loadConfig } from "../lib/config.mjs";
import {
  applyMatches, describeFinding, earlierFindings, matchInputs, matchJob, sortFindings, takeFixerResponses, trackFindings,
} from "../lib/findings.mjs";
import { learningsForReview } from "../lib/learnings.mjs";
import { nextAction } from "../lib/next-action.mjs";
import { CODE, dirtyFiles, fingerprint, repoRoot, treeMayHaveChanged } from "../lib/repo.mjs";
import { CODE_SCHEMA, fill, MATCH_SCHEMA, ReviewerError, runReviewer, UI_SCHEMA } from "../lib/reviewers.mjs";
import { formatTests, gateState, logAttempt, nextAttempt, requiredGates } from "../lib/state.mjs";
import { evidenceDir, loadRun, requireCurrent, transaction } from "../lib/store.mjs";

/** @import { Args, Checkpoint, CodeVerdict, Config, Gate, GateRecord, MatchVerdict, ReviewResult, Run, UiVerdict } from "../lib/types.js" */

/**
 * @param {Run} run
 * @param {Checkpoint} cp
 * @param {Gate} gate
 * @param {string} fp
 * @param {Config} config
 */
export function ensurePriorGates(run, cp, gate, fp, config) {
  const order = requiredGates(cp, config);
  for (const prior of order.slice(0, order.indexOf(gate))) {
    const state = gateState(cp, prior, fp);
    if (state !== "passed") {
      throw new HelixError(`Gates run in order: the ${prior} gate is ${state} for the current tree. ` +
        `Pass it before the ${gate} gate.\nNext: ${nextAction(run, null, config)}`);
    }
  }
}

/** @param {Run} run @param {Checkpoint} cp @param {Gate} gate @param {GateRecord} record */
function noteGate(run, cp, gate, record) {
  cp.gates[gate] = record;
  logAttempt(cp, gate, record.status, record.attempt);
  const outcome = { passed: "passed", failed: "sent back", invalid: "screenshots mismatched", error: "reviewer error" };
  run.history.push({ at: now(), event: `${cp.id} ${GATE_NAME[gate]}: ${outcome[record.status]} (attempt ${record.attempt})` });
}

/** @param {string} root @param {string} runId @param {Gate} gate @param {GateRecord} record */
function recordGate(root, runId, gate, record) {
  return transaction(root, runId, (run) => noteGate(run, requireCurrent(run), gate, record)).run;
}

/** @param {string} root @param {string} runId @param {Gate} gate */
function beginAttempt(root, runId, gate) {
  const { run, result } = transaction(root, runId, (run) => nextAttempt(requireCurrent(run), gate));
  return { run, cp: requireCurrent(run), attempt: result };
}

/** @param {Args} args */
function gateBehavior(args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const runId = args._[0];
  const cp0 = requireCurrent(loadRun(root, runId));
  if (!cp0.tests.length) throw new HelixError(`${cp0.id} has no planned test cases; the behavior gate has nothing to prove.`);
  const command = cp0.test_command || config.test_command;
  if (!command) throw new HelixError("No test command configured. Set it with `helix init --test-command ...`.");
  const fpBefore = fingerprint(root);
  const { run: started, cp, attempt } = beginAttempt(root, runId, "behavior");
  const log = path.join(evidenceDir(root, started, cp), `behavior-${pad3(attempt)}.log`);
  const proc = spawnSync(command, {
    shell: true, cwd: root, encoding: "utf8", timeout: config.test_timeout_seconds * 1000,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20,
  });
  treeMayHaveChanged();
  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (proc.error)?.code === "ETIMEDOUT" || proc.signal === "SIGTERM";
  const code = timedOut ? 124 : (proc.status ?? 1);
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}${timedOut ? `\nTIMEOUT after ${config.test_timeout_seconds}s` : ""}`;
  const fpAfter = fingerprint(root);
  /** @type {GateRecord["status"]} */
  let status = "passed";
  let reason = "";
  if (code !== 0) [status, reason] = ["failed", `test command exited ${code}`];
  else if (fpAfter !== fpBefore) {
    status = "failed";
    reason = "the test run modified the working tree; gitignore what it generates. Changed files:\n" +
      dirtyFiles(root).join("\n");
  }
  fs.writeFileSync(log, `$ ${command}\n${output}\n$ exit ${code}\n${reason ? `\nGATE FAILED: ${reason}\n` : ""}`);
  // A run that dirtied the tree is judged on the tree it left behind, so the
  // fixer's brief and the next action point at that failure.
  const run = recordGate(root, runId, "behavior", {
    status, fingerprint: status === "passed" ? fpBefore : fpAfter, at: now(), attempt, command, exit: code, reason,
    evidence: relTo(root, log),
  });
  console.log(`Behavior gate ${status.toUpperCase()} for ${cp.id} (attempt ${attempt}). Log: ${log}`);
  if (status !== "passed") {
    console.log(`Reason: ${reason}\n--- last lines ---`);
    console.log(output.trim().split("\n").slice(-40).join("\n"));
    throw new GateExit(2);
  }
  console.log("Next:", nextAction(run, root, config));
}

/** @param {Args} args */
async function gateUi(args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const runId = args._[0];
  const run0 = loadRun(root, runId);
  const cp0 = requireCurrent(run0);
  if (!requiredGates(cp0, config).includes("ui")) {
    throw new HelixError(`${cp0.id} is not a UI checkpoint; the UI gate does not apply.`);
  }
  /** @type {[string, string, string][]} */
  const pairs = args.pair ?? [];
  if (!pairs.length) {
    throw new HelixError("Provide at least one --pair REFERENCE_IMAGE IMPLEMENTATION_IMAGE STATE_DESCRIPTION.");
  }
  const fp = fingerprint(root);
  ensurePriorGates(run0, cp0, "ui", fp, config);
  const sources = pairs.map(([ref, impl, state]) => {
    const files = [ref, impl].map((src) => {
      const file = path.resolve(src.replace(/^~(?=\/)/, os.homedir()));
      if (!fs.existsSync(file)) throw new HelixError(`Screenshot not found: ${src}`);
      const size = imageSize(file);
      if (!size) throw new HelixError(`${src} is not a PNG or JPEG image.`);
      return { file, size };
    });
    return { ref: files[0], impl: files[1], state };
  });
  const { run: started, cp, attempt } = beginAttempt(root, runId, "ui");
  const outDir = path.join(evidenceDir(root, started, cp), `ui-${pad3(attempt)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "ui-reviewer.md"), "utf8");
  const learnings = learningsForReview(root);
  const jobs = sources.map(({ ref, impl, state }, index) => {
    const n = index + 1;
    /** @param {string} src @param {string} kind */
    const copy = (src, kind) => {
      const dest = path.join(outDir, `pair-${n}-${kind}${path.extname(src).toLowerCase()}`);
      fs.copyFileSync(src, dest);
      return dest;
    };
    const refPath = copy(ref.file, "reference");
    const implPath = copy(impl.file, "implementation");
    const prompt = fill(template, {
      CHECKPOINT: `${cp.id}: ${cp.title} - ${cp.summary}`,
      SCOPE: cp.ui_scope || "the whole screen",
      STATE: state,
      REFERENCE: relTo(root, refPath),
      REFERENCE_SIZE: `${ref.size[0]}x${ref.size[1]}`,
      IMPLEMENTATION: relTo(root, implPath),
      IMPLEMENTATION_SIZE: `${impl.size[0]}x${impl.size[1]}`,
      DESIGN: bullet(config.design, "(no design documents: judge against the reference screenshot)"),
      LEARNINGS: learnings,
    });
    return { n, state, prompt, images: [refPath, implPath], out: path.join(outDir, `pair-${n}.json`) };
  });
  const results = await Promise.all(jobs.map(async (job) => {
    try {
      /** @type {UiVerdict} */
      const verdict = await runReviewer(config.reviewers.ui, job.prompt, UI_SCHEMA, job.images, root, job.out,
        config.reviewers.timeout_seconds);
      return { ...job, verdict, error: /** @type {string | null} */ (null) };
    } catch (error) {
      if (!(error instanceof ReviewerError)) throw error;
      return { ...job, verdict: null, error: error.message };
    }
  }));
  /** @type {GateRecord["status"]} */
  let status = "passed";
  /** @type {string[]} */
  const lines = [];
  const pairsDetail = results.map(({ n, state, images, verdict, error }) => ({
    n, state, reference: relTo(root, images[0]), implementation: relTo(root, images[1]),
    verdict: verdict?.verdict ?? "ERROR", invalid_reason: verdict?.invalid_reason ?? "", error,
    findings: verdict?.findings ?? [], out_of_scope_notes: verdict?.out_of_scope_notes ?? [],
  }));
  for (const { n, state, verdict, error } of results) {
    if (error || !verdict) {
      if (status === "passed") status = "error";
      lines.push(`pair ${n} (${state}): REVIEWER ERROR - ${error}`);
      continue;
    }
    const blocking = verdict.findings.filter((f) => f.fixable_in_code);
    if (verdict.verdict === "INVALID") {
      status = "invalid";
      lines.push(`pair ${n} (${state}): INVALID - ${verdict.invalid_reason}`);
    } else if (verdict.verdict !== "PASS" || blocking.length) {
      if (status === "passed" || status === "error") status = "failed";
      lines.push(`pair ${n} (${state}): FAIL - ${blocking.length} fixable difference(s)`);
    } else {
      lines.push(`pair ${n} (${state}): PASS`);
    }
    for (const f of verdict.findings) {
      const tag = f.fixable_in_code ? "BLOCKER" : "accepted (not fixable in code)";
      lines.push(`  - [${f.severity}/${tag}] ${f.location} / ${f.element}: expected ${f.expected}; ` +
        `actual ${f.actual} (~${f.estimated_difference})`);
    }
  }
  if (fingerprint(root) !== fp) {
    status = "error";
    lines.push("The working tree changed while the UI review ran; rerun the gate.");
  }
  const report = path.join(outDir, "report.md");
  fs.writeFileSync(report, `# UI review ${cp.id} attempt ${attempt}: ${status}\n\n${lines.join("\n")}\n`);
  const run = recordGate(root, runId, "ui", {
    status, fingerprint: fp, at: now(), attempt, evidence: relTo(root, report), details: { pairs: pairsDetail },
  });
  console.log(`UI gate ${status.toUpperCase()} for ${cp.id} (attempt ${attempt}). Report: ${report}`);
  console.log(lines.join("\n"));
  if (status === "invalid") {
    console.log("\nThe reviewer says the screenshots do not show the same state or section. Recapture both apps in " +
      "the same state and rerun the gate.");
  }
  if (status !== "passed") throw new GateExit(status === "invalid" ? 3 : 2);
  console.log("Next:", nextAction(run, root, config));
}

/** @param {Args} args */
async function gateReview(args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const runId = args._[0];
  const run0 = loadRun(root, runId);
  const cp0 = requireCurrent(run0);
  const fp = fingerprint(root);
  ensurePriorGates(run0, cp0, "review", fp, config);
  const base = /** @type {string} */ (cp0.base);
  const diff = git(root, ["diff", "--no-color", base, fp, ...CODE]);
  if (!diff.trim()) throw new HelixError(`${cp0.id} has no changes against its base commit; nothing to review.`);
  const reviewers = config.reviewers.code;
  if (reviewers.length < 2) {
    throw new HelixError("The adversarial gate needs at least two independent reviewers in config.reviewers.code.");
  }
  const { run: started, result: attempt } = transaction(root, runId, (run) => {
    const cp = requireCurrent(run);
    takeFixerResponses(root, run, cp);
    return nextAttempt(cp, "review");
  });
  const cp = requireCurrent(started);
  const outDir = path.join(evidenceDir(root, started, cp), `review-${pad3(attempt)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const diffFile = path.join(outDir, "diff.patch");
  fs.writeFileSync(diffFile, `${diff}\n`);
  const changed = git(root, ["diff", "--name-only", base, fp, ...CODE]).split("\n").filter(Boolean);
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "code-reviewer.md"), "utf8");
  /** @type {ReviewResult[]} */
  const results = await Promise.all(reviewers.map(async (spec, index) => {
    const n = index + 1;
    const prompt = fill(template, {
      LENS: spec.lens ?? "general",
      CHECKPOINT: `${cp.id}: ${cp.title} - ${cp.summary}`,
      DONE_WHEN: bullet(cp.done_when),
      TESTS: formatTests(cp),
      GUIDELINES: bullet(config.guidelines, "(no guidelines documents configured: apply general engineering " +
        "standards and the conventions visible in the existing code)"),
      LEARNINGS: learningsForReview(root),
      DIFF: relTo(root, diffFile),
      CHANGED: bullet(changed),
      REFERENCE: bullet(cp.reference.length ? cp.reference : [started.reference || "(none)"]),
      EARLIER: earlierFindings(cp, n),
    });
    const name = `reviewer ${n} (${spec.backend ?? "claude"}, ${spec.lens ?? "general"})`;
    const who = { name, backend: spec.backend ?? "claude", lens: spec.lens ?? "general" };
    try {
      /** @type {CodeVerdict} */
      const verdict = await runReviewer(spec, prompt, CODE_SCHEMA, [], root,
        path.join(outDir, `reviewer-${n}.json`), config.reviewers.timeout_seconds);
      if (verdict.verdict === "changes_requested" && !verdict.findings.length) {
        throw new ReviewerError("the reviewer requested changes but reported no findings");
      }
      return { ...who, verdict, error: null };
    } catch (error) {
      if (!(error instanceof ReviewerError)) throw error;
      return { ...who, verdict: null, error: error.message };
    }
  }));
  const matchError = await matchFindings(root, config, started, cp, results, outDir);
  const treeChanged = fingerprint(root) !== fp;
  const report = path.join(outDir, "findings.md");
  const { run, result: { status, text } } = transaction(root, runId, (run) => {
    const cp = requireCurrent(run);
    // Findings about a tree that changed under the reviewers say nothing about the current one, and
    // findings the matcher could not match would lose their history.
    const outcome = treeChanged || matchError ? results.map(() => ({ raised: /** @type {string[]} */ ([]), ignored: /** @type {string[]} */ ([]) }))
      : trackFindings(cp, attempt, results);
    const blocking = outcome.some((o) => o.raised.length);
    const errored = treeChanged || matchError || results.some((r) => r.error);
    /** @type {GateRecord["status"]} */
    const status = blocking ? "failed" : errored ? "error" : "passed";
    const lines = results.map(({ name, verdict, error }, i) => {
      const verdictText = error ? "ERROR" : outcome[i].raised.length ? "CHANGES REQUESTED" : "APPROVE";
      return `### ${name}: ${verdictText}\n${error ?? verdict?.summary}`;
    });
    const sections = [`## Reviewers\n\n${lines.join("\n\n")}`];
    if (matchError) sections.push(`### Finding matcher: ERROR\n${matchError}`);
    if (treeChanged) sections.push("The working tree changed while reviewers ran; rerun the gate.");
    const findings = cp.findings ?? [];
    const raised = sortFindings(findings.filter((f) => f.status === "open" && f.raised.at(-1) === attempt));
    if (raised.length) {
      sections.push("## Findings to fix\n\nSorted by file and line. Two reviewers may describe the same problem: " +
        `fix it once and answer both ids.\n\n${raised.map(describeFinding).join("\n\n")}`);
    }
    const resolved = sortFindings(findings.filter((f) => f.resolved_in === attempt && !treeChanged));
    if (resolved.length) {
      sections.push(`## Resolved since the last review\n\n${resolved.map((f) => `- ${f.id} ${f.file}:${f.line}: ` +
        oneLine(f.problem)).join("\n")}`);
    }
    const ignored = outcome.flatMap((o) => o.ignored);
    if (ignored.length) {
      sections.push(`## Raised again after the engineer dropped them (not blocking)\n\n${ignored.join(", ")}`);
    }
    const text = sections.join("\n\n");
    fs.writeFileSync(report, `# Adversarial review ${cp.id} attempt ${attempt}: ${status}\n\n${text}\n`);
    const reviewersDetail = results.map(({ name, backend, lens, verdict, error }, i) => ({
      name, backend, lens, error, verdict: verdict?.verdict ?? "error", summary: verdict?.summary ?? "",
      findings: outcome[i].raised, ignored: outcome[i].ignored,
    }));
    noteGate(run, cp, "review", {
      status, fingerprint: fp, at: now(), attempt, evidence: relTo(root, report), details: { reviewers: reviewersDetail },
    });
    return { status, text };
  });
  console.log(`Adversarial review ${status.toUpperCase()} for ${cp.id} (attempt ${attempt}). Findings: ${report}`);
  console.log(text);
  console.log("\nNext:", nextAction(run, root, config));
  if (status !== "passed") throw new GateExit(2);
}

/**
 * Asks the finding matcher which findings the reviewers did not mark repeat an
 * earlier one, and marks them. Returns the matcher's error, if it failed.
 * @param {string} root
 * @param {Config} config
 * @param {Run} run
 * @param {Checkpoint} cp
 * @param {ReviewResult[]} results
 * @param {string} outDir
 * @returns {Promise<string | null>}
 */
async function matchFindings(root, config, run, cp, results, outDir) {
  const job = matchJob(run, cp, results);
  if (!job) return null;
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "finding-matcher.md"), "utf8");
  try {
    /** @type {MatchVerdict} */
    const verdict = await runReviewer(config.reviewers.matcher, fill(template, matchInputs(job)), MATCH_SCHEMA, [], root,
      path.join(outDir, "matcher.json"), config.reviewers.timeout_seconds);
    applyMatches(job, verdict);
    return null;
  } catch (error) {
    if (!(error instanceof ReviewerError)) throw error;
    return error.message;
  }
}

/** @param {Args} args */
export async function cmdGate(args) {
  const [gate, ...rest] = args._;
  const next = { ...args, _: rest };
  if (gate === "behavior") gateBehavior(next);
  else if (gate === "ui") await gateUi(next);
  else if (gate === "review") await gateReview(next);
  else throw new HelixError(`Unknown gate '${gate}'. Use behavior, ui or review.`);
}
