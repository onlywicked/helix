// Committing a checkpoint whose gates all passed on the exact tree committed.

import * as fs from "node:fs";
import * as path from "node:path";
import { bullet, clone, git, HelixError, now, oneLine, plural, sh, writeJson } from "../lib/core.mjs";
import { loadConfig } from "../lib/config.mjs";
import { nextAction } from "../lib/next-action.mjs";
import { codeTree, fingerprint, head, repoRoot, sharedDir, sharedRunPath, treeMayHaveChanged } from "../lib/repo.mjs";
import { advance, gateState, requiredGates } from "../lib/state.mjs";
import { evidenceDir, requireCurrent, transaction, writeSharedRun } from "../lib/store.mjs";

/** @import { Args, Checkpoint, Gate, GateRecord } from "../lib/types.js" */

/** @param {Checkpoint} cp @param {Gate} gate */
const passedRecord = (cp, gate) => /** @type {GateRecord} */ (cp.gates[gate]);

/**
 * The commit's subject line, which the agent writes in the repository's commit style.
 * @param {Args} args
 */
export function subjectLine(args) {
  const subject = String(args.message ?? "").trim();
  if (!subject || subject.includes("\n")) {
    throw new HelixError("--message must be one line: the commit's subject, in the repository's commit style " +
      "(see `git log`). Helix writes the body.");
  }
  return subject;
}

/** @param {Args} args */
export function cmdCommit(args) {
  const subject = subjectLine(args);
  const root = repoRoot();
  const config = loadConfig(root);
  const fp = fingerprint(root);
  const { run, result: commit } = transaction(root, args._[0], (run) => {
    const cp = requireCurrent(run);
    const gates = requiredGates(cp, config);
    for (const gate of gates) {
      const state = gateState(cp, gate, fp);
      if (state !== "passed") {
        throw new HelixError(`Cannot commit ${cp.id}: the ${gate} gate is ${state} for the current tree.\n` +
          `Next: ${nextAction(run, root, config)}`);
      }
    }
    const summary = Object.fromEntries(gates.map((g) => {
      const { fingerprint: _, ...record } = passedRecord(cp, g);
      return [g, record];
    }));
    const evidence = evidenceDir(root, run, cp);
    writeJson(path.join(evidence, "summary.json"), { checkpoint: cp.title, gates: summary, findings: cp.findings ?? [] });
    cp.status = "committed";
    cp.committed_at = now();
    cp.tree = fp;
    const sections = [subject, `Helix run ${run.id}, ${cp.id}: ${cp.title}`, cp.summary,
      `Gates:\n${gates.map((g) => gateLine(cp, g, passedRecord(cp, g))).join("\n")}`];
    if (cp.feedback.length) sections.push(`Engineer feedback:\n${bullet(cp.feedback.map((f) => `"${oneLine(f.text)}"`))}`);
    const rulings = (cp.findings ?? []).flatMap((f) => (f.ruling ? [{ f, ruling: f.ruling }] : []));
    if (rulings.length) {
      sections.push(`Engineer rulings on review findings:\n${bullet(rulings.map(({ f, ruling }) =>
        `${f.id} ${ruling.decision === "fix" ? "must be fixed" : "dropped"} ("${oneLine(f.problem)}"): "${oneLine(ruling.text)}"`))}`);
    }
    const message = `${sections.join("\n\n")}\n`;
    const parent = /** @type {string} */ (head(root));
    // The commit carries the run as it stands once committed, so a teammate can pick it up from the branch.
    const after = clone(run);
    advance(root, after);
    writeSharedRun(root, after);
    git(root, ["add", "-A"]);
    const trailers = (/** @type {string[] | undefined} */ (args.trailer) ?? []).flatMap((t) => ["--trailer", t]);
    git(root, ["commit", "-q", "-m", message, ...trailers]);
    treeMayHaveChanged();
    if (codeTree(root, (env) => git(root, ["read-tree", "HEAD"], env)) !== fp) {
      git(root, ["reset", "-q", "--soft", parent]);
      restoreSharedRun(root, run.id, parent);
      throw new HelixError("A git commit hook changed the files being committed, so the commit no longer matches " +
        "the tree the gates passed. The commit was undone and the hook's changes are kept in the working tree: " +
        "run the gates again on them, then commit.");
    }
    const commit = /** @type {string} */ (head(root));
    cp.commit = commit;
    fs.cpSync(evidence, path.join(sharedDir(root), "evidence", commit), { recursive: true });
    run.history.push({ at: now(), event: `${cp.id} committed ${commit.slice(0, 10)}` });
    advance(root, run);
    return { id: cp.id, commit };
  });
  console.log(`Committed ${commit.id} as ${commit.commit.slice(0, 10)}.`);
  console.log("Next:", nextAction(run, root, config));
}

/**
 * Once the engineer accepts the feature, removes the run's file from the
 * branch in a commit of its own: the run is over, and history keeps the file.
 * Returns that commit, or null when the run file was never committed.
 * @param {string} root
 * @param {string} runId
 * @param {string} subject
 */
export function closeSharedRun(root, runId, subject) {
  const file = path.relative(root, sharedRunPath(root, runId));
  if (sh(["git", "ls-files", "--error-unmatch", "--", file], root, { check: false }).status !== 0) return null;
  git(root, ["rm", "-q", "--", file]);
  try {
    git(root, ["commit", "-q", "-m", `${subject}\n\nHelix run ${runId}: the engineer accepted the feature.\n`, "--", file]);
  } catch (error) {
    git(root, ["reset", "-q", "--", file]);
    git(root, ["checkout", "-q", "--", file]);
    throw error;
  }
  treeMayHaveChanged();
  return head(root);
}

/**
 * Puts the run file back as it was in `commit`, after a checkpoint commit was undone.
 * @param {string} root
 * @param {string} runId
 * @param {string} commit
 */
function restoreSharedRun(root, runId, commit) {
  const file = path.relative(root, sharedRunPath(root, runId));
  if (sh(["git", "cat-file", "-e", `${commit}:${file}`], root, { check: false }).status === 0) {
    git(root, ["checkout", "-q", commit, "--", file]);
  } else {
    git(root, ["rm", "-q", "-f", "--", file]);
  }
}

/**
 * A passed gate for the engineer and the commit message: how often it sent the work back, and what it proved.
 * @param {Checkpoint} cp
 * @param {Gate} gate
 * @param {GateRecord} record
 */
export function gateLine(cp, gate, record) {
  const relayed = record.via === "relay" ? ", relayed by the agent" : "";
  if (record.mode === "waived") return `- ${gate}: waived by the engineer (${record.reply}${relayed})`;
  if (gate === "human") {
    const how = record.mode === "autonomous" ? "approved under autonomy the engineer granted" : `approved by the engineer${relayed}`;
    return `- human: ${how}${cp.feedback.length ? ` after ${plural(cp.feedback.length, "round")} of feedback` : ""}`;
  }
  const runs = (cp.log ?? []).filter((a) => a.gate === gate);
  const sentBack = runs.filter((a) => a.status === "failed").length;
  const history = `${plural(Math.max(runs.length, 1), "run")}, ${sentBack ? `sent back ${plural(sentBack, "time")}` : "never sent back"}`;
  return `- ${gate}: passed (${history})${gateEvidence(cp, gate, record)}`;
}

/**
 * What a passed gate proved, in a few words.
 * @param {Checkpoint} cp
 * @param {Gate} gate
 * @param {GateRecord} record
 */
function gateEvidence(cp, gate, record) {
  if (gate === "behavior") return `: ${plural(cp.tests.length, "planned case")} via \`${record.command}\``;
  if (gate === "ui") {
    const pairs = /** @type {{ pairs?: unknown[] } | undefined} */ (record.details)?.pairs?.length ?? 0;
    return `: ${plural(pairs, "screen")} ${pairs === 1 ? "matches" : "match"} the reference`;
  }
  if (gate === "review") {
    const findings = cp.findings ?? [];
    const resolved = findings.filter((f) => f.status === "resolved").length;
    const dropped = findings.filter((f) => f.status === "dropped").length;
    const parts = [resolved ? `${plural(resolved, "finding")} fixed` : "", dropped ? `${dropped} dropped by the engineer` : ""];
    return `: every reviewer approved${parts.some(Boolean) ? ` (${parts.filter(Boolean).join(", ")})` : ""}`;
  }
  return "";
}
