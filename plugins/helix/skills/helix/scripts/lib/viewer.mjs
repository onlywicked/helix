// The run's viewer: a static page in the run's dir that shows the plan, each
// checkpoint's gates and their evidence, and stays live while the run moves.

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, SKILL_DIR } from "./core.mjs";
import { loadConfig } from "./config.mjs";
import { isStuck, sortFindings } from "./findings.mjs";
import { nextAction } from "./next-action.mjs";
import { fingerprint, runDir } from "./repo.mjs";
import { gateState, requiredGates } from "./state.mjs";

/** @import { Gate, GateRecord, Run } from "./types.js" */

/** @type {Record<string, string>} */
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** @param {string} text */
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]);

/**
 * Last lines of a text file, for showing a log inline.
 * @param {string} file
 * @param {number} lines
 */
function tail(file, lines) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * The run as the viewer shows it: plain data, paths relative to the viewer.
 * @param {string} root
 * @param {Run} run
 */
function viewModel(root, run) {
  let config = DEFAULT_CONFIG;
  try {
    config = loadConfig(root);
  } catch {
    // render with defaults
  }
  /** @type {string | null} */
  let fp = null;
  try {
    fp = fingerprint(root);
  } catch {
    // outside a usable repo: show recorded gate states
  }
  const dir = runDir(root, run.id);
  /** @param {string} file */
  const rel = (file) => path.relative(dir, path.resolve(root, file));
  /** @param {Gate} gate @param {GateRecord | undefined} record @returns {unknown} */
  const detailsFor = (gate, record) => {
    if (!record) return null;
    if (gate === "behavior") {
      return { exit: record.exit ?? null, reason: record.reason ?? "", command: record.command ?? "",
        log: record.evidence ? tail(path.resolve(root, record.evidence), 24) : "" };
    }
    if (gate === "ui" && record.details) {
      const { pairs } = /** @type {{ pairs: { reference: string; implementation: string }[] }} */ (record.details);
      return { pairs: pairs.map((p) => ({ ...p, reference: rel(p.reference), implementation: rel(p.implementation) })) };
    }
    return record.details ?? null;
  };
  return {
    id: run.id, title: run.title, goal: run.goal ?? "", status: run.status,
    reference: run.reference ?? "", target: run.target ?? "",
    autonomy: run.autonomy.remaining, current: run.current, created: run.created_at, updated: run.updated_at ?? "",
    accepted: run.accepted_at ?? "",
    next: fp ? nextAction(run, root, config) : nextAction(run, null, config),
    waiting: run.awaiting ? {
      kind: run.awaiting.kind, since: run.awaiting.since, question: run.awaiting.question ?? "",
      replied: run.awaiting.replies.at(-1)?.text ?? null,
    } : null,
    plan_feedback: (run.plan_feedback ?? []).map((f) => ({ at: f.at, text: f.text })),
    decisions: run.plan_decisions ?? [],
    final_feedback: (run.final_feedback ?? []).map((f) => ({ at: f.at, text: f.text })),
    history: run.history.slice(-60),
    checkpoints: run.checkpoints.map((cp) => ({
      id: cp.id, title: cp.title, summary: cp.summary, done_when: cp.done_when, ui: cp.ui,
      ui_scope: cp.ui_scope ?? "", status: cp.status, tests: cp.tests,
      started: cp.started_at ?? "", committed: cp.committed_at ?? "",
      log: cp.log ?? [],
      gates: requiredGates(cp, config).map((g) => {
        const record = cp.gates[g];
        return {
          name: g,
          state: cp.status === "committed" ? "passed" : gateState(cp, g, fp),
          status: record?.status ?? null,
          attempt: record?.attempt ?? null,
          at: record?.at ?? "",
          mode: record?.mode ?? null,
          via: record?.via ?? null,
          reply: g === "human" || record?.mode === "waived" ? record?.reply ?? "" : "",
          evidence: record?.evidence ? rel(record.evidence) : "",
          details: detailsFor(g, record),
        };
      }),
      commit: (cp.commit ?? "").slice(0, 10),
      feedback: cp.feedback.map((f) => ({ at: f.at, text: f.text })),
      findings: sortFindings(cp.findings ?? []).map((f) => ({
        id: f.id, lens: f.lens, severity: f.severity, file: f.file, line: f.line, rule: f.rule, problem: f.problem,
        required_fix: f.required_fix, raised: f.raised, status: f.status, stuck: isStuck(f),
        answer: f.responses.at(-1) ?? null, ruling: f.ruling ? { decision: f.ruling.decision, text: f.ruling.text } : null,
      })),
    })),
  };
}

/**
 * The viewer is a static page plus a data script beside it. The page embeds
 * the data for its first paint, then polls the script (a <script> load works
 * from file:// where fetch does not), so it stays live in every state.
 * @param {string} root
 * @param {Run} run
 */
export function renderViewer(root, run) {
  const dir = runDir(root, run.id);
  const data = JSON.stringify(viewModel(root, run)).replaceAll("<", "\\u003c");
  fs.writeFileSync(path.join(dir, "viewer-data.js"), `window.helixUpdate(${data});\n`);
  const template = fs.readFileSync(path.join(SKILL_DIR, "scripts", "viewer.html"), "utf8");
  const page = template
    .replace("{{TITLE}}", () => escapeHtml(run.title))
    .replace("/*HELIX_DATA*/null", () => data);
  fs.writeFileSync(path.join(dir, "viewer.html"), page);
}
