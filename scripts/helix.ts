#!/usr/bin/env bun
/**
 * Helix: a checkpoint-and-gate state machine for agent-driven development.
 *
 * The orchestrating agent drives the work; this CLI is the part it cannot argue
 * with. Every gate verdict is produced here (tests are run here, reviewers are
 * launched here as isolated processes), every verdict is bound to a fingerprint
 * of the working tree, and a checkpoint can only be committed when all of its
 * gates passed against the exact tree being committed.
 *
 * Run `bun helix.ts help` for commands. No dependencies beyond Bun.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SKILL_DIR = path.resolve(import.meta.dir, "..");
const PROMPTS_DIR = path.join(SKILL_DIR, "prompts");

// Run statuses. The Stop hook keeps the agent working while a run it owns is
// in an ACTIVE status; every other status is a legitimate place to stop.
type Status =
  | "planning" | "building" | "awaiting_plan_approval" | "awaiting_approval" | "awaiting_input"
  | "paused" | "stalled" | "done";
const ACTIVE: ReadonlySet<Status> = new Set<Status>(["planning", "building"]);
const GATES = ["behavior", "ui", "review", "human"] as const;
type Gate = (typeof GATES)[number];
type GateState = "passed" | "stale" | "failed" | "invalid" | "error" | "pending";
const MAX_IDENTICAL_STOPS = 3;

// ---------------------------------------------------------------- types

interface ReviewerSpec {
  backend?: "claude" | "codex" | "exec";
  model?: string;
  lens?: string;
  command?: string | string[];
}

interface Config {
  test_command: string;
  test_timeout_seconds: number;
  guidelines: string[];
  design: string[];
  ui: { enabled: boolean; capture_notes: string };
  reviewers: { ui: ReviewerSpec; code: ReviewerSpec[]; timeout_seconds: number };
}

interface GateRecord {
  status: "passed" | "failed" | "invalid" | "error";
  fingerprint: string;
  at: string;
  attempt?: number;
  evidence?: string;
  mode?: "engineer" | "autonomous" | "waived";
  reply?: string;
  [key: string]: unknown;
}

interface TestCase { id: string; kind: "happy" | "edge" | "error"; name: string; given: string; when: string; then: string }
interface Feedback { at: string; text: string; reply: string }

interface CheckpointSpec {
  title: string;
  summary: string;
  done_when: string[];
  ui: boolean;
  ui_scope: string;
  reference: string[];
  test_command: string;
}

interface Checkpoint extends CheckpointSpec {
  id: string;
  status: "pending" | "in_progress" | "committed";
  tests: TestCase[];
  gates: Partial<Record<Gate, GateRecord>>;
  attempts: Partial<Record<Gate, number>>;
  feedback: Feedback[];
  /** Tree when the engineer last gave feedback; while unchanged, it is unaddressed. */
  feedback_fingerprint?: string;
  base?: string | null;
  started_at?: string;
  committed_at?: string;
  tree?: string;
  commit?: string | null;
}

interface Reply { at: string; text: string }
interface Awaiting {
  kind: "plan" | "checkpoint" | "input" | "final";
  since: string;
  replies: Reply[];
  fingerprint?: string | null;
  cp?: string;
  resume?: Status;
  question?: string;
}

interface Run {
  id: string;
  title: string;
  goal: string;
  reference: string;
  target: string;
  status: Status;
  owner_session: string | null;
  created_at: string;
  updated_at?: string;
  checkpoints: Checkpoint[];
  current: string | null;
  autonomy: { remaining: number | null; granted_by: string };
  awaiting: Awaiting | null;
  last_prompt: Reply | null;
  stop_guard: { signature: string; count: number } | null;
  history: { at: string; event: string; reply?: string | null }[];
  paused_from?: Status;
  stalled_from?: Status;
  plan_feedback?: Feedback[];
  final_feedback?: Feedback[];
}

const DEFAULT_CONFIG: Config = {
  test_command: "",
  test_timeout_seconds: 1800,
  guidelines: [],
  design: [],
  ui: { enabled: true, capture_notes: "" },
  reviewers: {
    ui: { backend: "claude", model: "opus" },
    code: [
      { backend: "claude", model: "opus", lens: "architecture" },
      { backend: "claude", model: "opus", lens: "correctness" },
    ],
    timeout_seconds: 1200,
  },
};

/** A user-facing error: printed without a stack trace, exit code 1. */
class HelixError extends Error {}

/** A gate ran and did not pass: exit with the given code after printing. */
class GateExit extends Error {
  constructor(readonly code: number) {
    super(`gate exit ${code}`);
  }
}

// ---------------------------------------------------------------- utilities

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const bullet = (items: string[], empty = "(none)") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);
const pad3 = (n: number) => String(n).padStart(3, "0");

function sh(args: string[], cwd: string, opts: { env?: NodeJS.ProcessEnv; check?: boolean } = {}) {
  const proc = spawnSync(args[0], args.slice(1), { cwd, env: opts.env, encoding: "utf8", maxBuffer: 256 << 20 });
  if (proc.error) throw new HelixError(`\`${args.join(" ")}\` could not run: ${proc.error.message}`);
  if ((opts.check ?? true) && proc.status !== 0) {
    throw new HelixError(`\`${args.join(" ")}\` failed:\n${(proc.stderr || proc.stdout).trim()}`);
  }
  return proc;
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return sh(["git", ...args], root, { env }).stdout.trim();
}

function repoRoot(start = process.cwd()): string {
  const proc = sh(["git", "rev-parse", "--show-toplevel"], start, { check: false });
  if (proc.status !== 0) {
    throw new HelixError("Helix needs a git repository (every checkpoint ends in a commit). Run `git init` first.");
  }
  return proc.stdout.trim();
}

/**
 * Helix keeps its files inside git's own directory, never in the working tree,
 * so formatters, linters and test runners never see them and they can never
 * dirty the tree. Runs (state, evidence, viewer) live in the per-worktree git
 * dir so parallel runs in separate worktrees stay isolated; config and
 * learnings live in the common git dir so every worktree shares them.
 */
function gitPath(root: string, flag: "--absolute-git-dir" | "--git-common-dir"): string {
  return path.join(path.resolve(root, git(root, ["rev-parse", flag])), "helix");
}
const runsDir = (root: string) => path.join(gitPath(root, "--absolute-git-dir"), "runs");
const sharedDir = (root: string) => gitPath(root, "--git-common-dir");
const configPath = (root: string) => path.join(sharedDir(root), "config.json");

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const readJson = <T = any>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));

function readJsonInput<T = any>(file: string): T {
  try {
    return readJson<T>(file);
  } catch (error) {
    throw new HelixError(`Cannot read JSON from ${file}: ${(error as Error).message}`);
  }
}

/**
 * The calling agent session, so hooks guard the right session. Claude Code and
 * Codex both export theirs to commands they run. When one agent runs inside the
 * other both are set, and the nearest agent in the process tree is the caller.
 */
function sessionId(): string | null {
  const claude = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const codex = process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || null;
  if (!claude || !codex) return claude ?? codex;
  const claudePid = Number(process.env.CLAUDE_PID);
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    if (pid === claudePid) return claude;
    const [ppid, ...command] = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" })
      .stdout.trim().split(/\s+/);
    if (/codex/i.test(command.join(" "))) return codex;
    pid = Number(ppid);
  }
  return claude;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

function humanize(slug: string): string {
  const text = slug.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** [width, height] for PNG/JPEG, else null. Lets reviewers judge proportionally. */
function imageSize(file: string): [number, number] | null {
  const data = fs.readFileSync(file);
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = data[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
      i += 2 + data.readUInt16BE(i + 2);
    }
  }
  return null;
}

function relTo(root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

// ---------------------------------------------------------------- git state

/**
 * Hash of the working tree (tracked + untracked, minus ignored files).
 * Computed through a throwaway index so the user's real index is untouched.
 * Any edit to code or tests changes it, which invalidates earlier gates.
 */
function fingerprint(root: string): string {
  let realIndex = git(root, ["rev-parse", "--git-path", "index"]);
  if (!path.isAbsolute(realIndex)) realIndex = path.join(root, realIndex);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-"));
  try {
    const index = path.join(tmp, "index");
    if (fs.existsSync(realIndex)) {
      // Keep the index's mtime: git re-hashes "racily clean" files (edited in
      // the same second the index was written) only when their mtime is not
      // older than the index file's. A fresh mtime would hide such edits.
      fs.copyFileSync(realIndex, index);
      const { atime, mtime } = fs.statSync(realIndex);
      fs.utimesSync(index, atime, mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(root, ["add", "-A"], env);
    return git(root, ["write-tree"], env);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function head(root: string): string | null {
  return sh(["git", "rev-parse", "--verify", "-q", "HEAD"], root, { check: false }).stdout.trim() || null;
}

function dirtyFiles(root: string): string[] {
  return git(root, ["status", "--porcelain"]).split("\n").filter((l) => l.trim());
}

// ---------------------------------------------------------------- config & runs

function loadConfig(root: string): Config {
  const file = configPath(root);
  if (!fs.existsSync(file)) throw new HelixError("Helix is not initialized in this repository. Run `helix init` first.");
  const merged: any = clone(DEFAULT_CONFIG);
  for (const [key, value] of Object.entries(readJson(file))) {
    const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    merged[key] = isObject(value) && isObject(merged[key]) ? { ...merged[key], ...(value as object) } : value;
  }
  return merged as Config;
}

const runDir = (root: string, runId: string) => path.join(runsDir(root), runId);
const workDir = (root: string, runId: string) => path.join(runDir(root, runId), "work");

function allRunIds(root: string): string[] {
  const runs = runsDir(root);
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs).filter((name) => fs.existsSync(path.join(runs, name, "state.json"))).sort();
}

/** Cross-process mutex (mkdir is atomic). Held only for short read-modify-write sections. */
function withLock<T>(root: string, runId: string, fn: () => T): T {
  const dir = runDir(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const age = Date.now() - fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs!;
      if (age > 30_000) fs.rmSync(lock, { recursive: true, force: true }); // holder died
      else if (Date.now() > deadline) throw new HelixError(`Timed out waiting for the lock on run '${runId}'.`);
      else Bun.sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function loadRun(root: string, runId: string): Run {
  const file = path.join(runDir(root, runId), "state.json");
  if (!fs.existsSync(file)) {
    throw new HelixError(`No Helix run named '${runId}'. Known runs: ${allRunIds(root).join(", ") || "none"}.`);
  }
  return readJson<Run>(file);
}

function saveRun(root: string, run: Run) {
  run.updated_at = now();
  writeJson(path.join(runDir(root, run.id), "state.json"), run);
  renderViewer(root, run);
}

/**
 * Locked read-modify-write of a run. Mutating commands claim the run for the
 * calling session so the hooks know whose Stop to guard.
 */
function transaction<T>(root: string, runId: string, fn: (run: Run) => T, claim = true): { run: Run; result: T } {
  return withLock(root, runId, () => {
    const run = loadRun(root, runId);
    if (claim && sessionId()) run.owner_session = sessionId();
    const result = fn(run);
    saveRun(root, run);
    return { run, result };
  });
}

function cpById(run: Run, cpId: string): Checkpoint {
  const cp = run.checkpoints.find((c) => c.id === cpId);
  if (!cp) throw new HelixError(`Run '${run.id}' has no checkpoint '${cpId}'.`);
  return cp;
}

const currentCp = (run: Run) => (run.current ? cpById(run, run.current) : null);

function requireCurrent(run: Run): Checkpoint {
  const cp = currentCp(run);
  if (run.status !== "building" || !cp) {
    throw new HelixError(`Run '${run.id}' is '${run.status}', not building a checkpoint.\n${nextAction(run)}`);
  }
  return cp;
}

function requiredGates(cp: Checkpoint, config: Config): Gate[] {
  const ui = cp.ui && config.ui.enabled !== false;
  return GATES.filter((g) => g !== "ui" || ui);
}

/** passed | stale | failed | invalid | error | pending, relative to tree fp. */
function gateState(cp: Checkpoint, gate: Gate, fp: string | null): GateState {
  const record = cp.gates[gate];
  if (!record) return "pending";
  if (record.mode === "waived") return "passed";
  if (record.status === "passed") return fp === null || record.fingerprint === fp ? "passed" : "stale";
  return record.status;
}

function evidenceDir(root: string, run: Run, cp: Checkpoint): string {
  const dir = path.join(runDir(root, run.id), "evidence", cp.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nextAttempt(cp: Checkpoint, gate: Gate): number {
  cp.attempts ??= {};
  cp.attempts[gate] = (cp.attempts[gate] ?? 0) + 1;
  return cp.attempts[gate]!;
}

function startCheckpoint(root: string, run: Run, cp: Checkpoint) {
  cp.status = "in_progress";
  cp.base = head(root);
  cp.started_at = now();
  run.current = cp.id;
}

function advance(root: string, run: Run) {
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

const learningsPath = (root: string) => path.join(sharedDir(root), "learnings.md");

function readLearnings(root: string): string {
  const file = learningsPath(root);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

function appendLearning(root: string, text: string, source: string) {
  const file = learningsPath(root);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "# Helix learnings\n\nEngineer feedback that every Helix agent and reviewer applies.\n\n");
  }
  fs.appendFileSync(file, `- ${text.trim()} _(from ${source}, ${now().slice(0, 10)})_\n`);
}

// ---------------------------------------------------------------- next action

/**
 * The single next step the orchestrator must take. The Stop hook feeds this
 * back to the agent, so it has to be concrete.
 */
function nextAction(run: Run, root: string | null = null, config: Config | null = null): string {
  const rid = run.id;
  switch (run.status) {
    case "planning": {
      if (!run.checkpoints.length) {
        return (`Dispatch the checkpoint planner subagent (prompts/checkpoint-planner.md), then load its output ` +
          `with \`helix plan ${rid} --file <checkpoints.json>\`.`);
      }
      const missing = run.checkpoints.filter((cp) => !cp.tests.length).map((cp) => cp.id);
      if (missing.length) {
        return (`Dispatch the test planner subagent (prompts/test-planner.md) for ${missing.join(", ")}, then ` +
          `\`helix tests ${rid} --file <tests.json>\`.`);
      }
      return `Plan and test cases are ready: run \`helix submit-plan ${rid}\` and stop for the engineer's approval.`;
    }
    case "awaiting_plan_approval":
      return ("STOP. The engineer is reviewing the checkpoint plan in the viewer. On their reply run " +
        `\`helix approve ${rid}\` (approval) or \`helix feedback ${rid} --text ...\` (changes).`);
    case "awaiting_approval":
      return ("STOP. The engineer is reviewing this checkpoint. On their reply run " +
        `\`helix approve ${rid}\` or \`helix feedback ${rid} --text ...\`.`);
    case "awaiting_input":
      return "STOP. Waiting for the engineer to answer your question.";
    case "paused":
      return `Run is paused. Resume with \`helix resume ${rid}\` when the engineer asks.`;
    case "stalled":
      return (`Run stalled (no progress across ${MAX_IDENTICAL_STOPS} stop attempts). Tell the engineer what is ` +
        `blocking you. Resume with \`helix resume ${rid}\`.`);
    case "done":
      return ("All checkpoints are committed. Ask the engineer to test the whole feature. Turn their feedback into " +
        `new checkpoints with \`helix add ${rid} --file <checkpoints.json>\` (it re-opens the run).`);
  }
  const cp = currentCp(run);
  if (!cp) return `No current checkpoint. Run \`helix status ${rid}\`.`;
  if (!cp.tests.length) {
    return (`${cp.id} has no planned test cases: dispatch the test planner (prompts/test-planner.md) for it, ` +
      `then \`helix tests ${rid} --file <tests.json>\`.`);
  }
  const fp = root ? fingerprint(root) : null;
  if (fp && cp.feedback_fingerprint === fp) {
    return (`${cp.id}: the engineer's feedback is not addressed yet: dispatch the fixer (prompts/fixer.md) with it ` +
      `(latest: "${cp.feedback.at(-1)?.text}"), then rerun the gates from \`helix gate behavior ${rid}\`.`);
  }
  const cfg = config ?? (root ? loadConfig(root) : DEFAULT_CONFIG);
  for (const gate of requiredGates(cp, cfg)) {
    const state = gateState(cp, gate, fp);
    if (state === "passed") continue;
    const last = cp.gates[gate];
    const where = last?.evidence ? ` Evidence: ${last.evidence}.` : "";
    if (gate === "behavior") {
      if (state === "pending") {
        return (`${cp.id}: dispatch the test writer (prompts/test-writer.md) to turn the planned test cases ` +
          `into failing tests, then the implementer (prompts/implementer.md), then ` +
          `\`helix gate behavior ${rid}\`.`);
      }
      return (`${cp.id}: behavior gate is ${state}.${where} Dispatch the fixer (prompts/fixer.md) if it failed, ` +
        `then rerun \`helix gate behavior ${rid}\`.`);
    }
    if (gate === "ui") {
      return (`${cp.id}: capture reference and implementation screenshots in the same state ` +
        `(scope: ${cp.ui_scope || "whole screen"}), then \`helix gate ui ${rid} --pair REF IMPL ` +
        `STATE\`. Last result: ${state}.${where}`);
    }
    if (gate === "review") {
      if ((state === "failed" || state === "error") && last?.fingerprint !== fp) {
        return `${cp.id}: the code changed since the last review ${state}; run \`helix gate review ${rid}\` again.`;
      }
      if (state === "failed" || state === "error") {
        return (`${cp.id}: adversarial review ${state}.${where} Dispatch the fixer with the findings, then ` +
          `rerun the behavior gate (and UI gate if anything visible changed) before ` +
          `\`helix gate review ${rid}\` again.`);
      }
      return `${cp.id}: run \`helix gate review ${rid}\`.`;
    }
    return `${cp.id}: automated gates passed. Run \`helix request-approval ${rid}\`.`;
  }
  return `${cp.id}: all gates passed. Run \`helix commit ${rid}\`.`;
}

// ---------------------------------------------------------------- validation

function validateCheckpoints(input: any): CheckpointSpec[] {
  const items = Array.isArray(input) ? input : input?.checkpoints;
  if (!Array.isArray(items) || !items.length) {
    throw new HelixError('Expected {"checkpoints": [ ... ]} with at least one checkpoint.');
  }
  const problems: string[] = [];
  const clean: CheckpointSpec[] = [];
  items.forEach((item: any, index: number) => {
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
      done_when: Array.isArray(doneWhen) ? doneWhen.map((d: unknown) => String(d).trim()) : [],
      ui: Boolean(item.ui),
      ui_scope: String(item.ui_scope ?? "").trim(),
      reference: (item.reference ?? []).map(String),
      test_command: String(item.test_command ?? "").trim(),
    });
  });
  if (problems.length) throw new HelixError(`Checkpoint plan rejected:\n  - ${problems.join("\n  - ")}`);
  return clean;
}

function newCheckpoint(run: Run, spec: CheckpointSpec): Checkpoint {
  return {
    id: `cp-${run.checkpoints.length + 1}`, status: "pending", tests: [], gates: {}, attempts: {}, feedback: [], ...spec,
  };
}

// ---------------------------------------------------------------- reviewers

const UI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "invalid_reason", "findings", "out_of_scope_notes"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL", "INVALID"] },
    invalid_reason: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "location", "element", "expected", "actual", "estimated_difference", "fixable_in_code"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          location: { type: "string" },
          element: { type: "string" },
          expected: { type: "string" },
          actual: { type: "string" },
          estimated_difference: { type: "string" },
          fixable_in_code: { type: "boolean" },
        },
      },
    },
    out_of_scope_notes: { type: "array", items: { type: "string" } },
  },
};

const CODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes_requested"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "rule", "problem", "required_fix"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: "string" },
          line: { type: "integer" },
          rule: { type: "string" },
          problem: { type: "string" },
          required_fix: { type: "string" },
        },
      },
    },
  },
};

interface UiFinding {
  severity: string; location: string; element: string; expected: string; actual: string;
  estimated_difference: string; fixable_in_code: boolean;
}
interface UiVerdict { verdict: "PASS" | "FAIL" | "INVALID"; invalid_reason: string; findings: UiFinding[]; out_of_scope_notes: string[] }
interface CodeFinding { severity: string; file: string; line: number; rule: string; problem: string; required_fix: string }
interface CodeVerdict { verdict: "approve" | "changes_requested"; summary: string; findings: CodeFinding[] }

class ReviewerError extends Error {}

/** Minimal validator for the schemas above (objects, arrays, enums, scalars). */
function checkSchema(value: any, schema: any, where = "$") {
  const kind = schema.type;
  const ok: Record<string, (v: any) => boolean> = {
    object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === "string",
    boolean: (v) => typeof v === "boolean",
    integer: Number.isInteger,
  };
  if (kind in ok && !ok[kind](value)) throw new ReviewerError(`reviewer output ${where}: expected ${kind}`);
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ReviewerError(`reviewer output ${where}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (kind === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new ReviewerError(`reviewer output ${where}: missing '${key}'`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) checkSchema(value[key], sub, `${where}.${key}`);
    }
  }
  if (kind === "array") value.forEach((item: unknown, i: number) => checkSchema(item, schema.items ?? {}, `${where}[${i}]`));
}

async function runProcess(cmd: string[], opts: { cwd: string; env: Record<string, string | undefined>; input?: string; timeoutMs: number }) {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.input === undefined ? "ignore" : new Blob([opts.input]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { missing: true as const };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { missing: false as const, stdout, stderr, code, timedOut };
}

/**
 * Launch one context-isolated reviewer process and return its verdict.
 *
 * Backends: claude (headless Claude Code, read-only tools, no project
 * settings), codex (read-only sandbox), exec (any command: prompt on stdin,
 * HELIX_SCHEMA_FILE in env, verdict JSON on stdout; use it to wrap Gemini).
 */
async function runReviewer<T>(spec: ReviewerSpec, prompt: string, schema: object, images: string[], root: string,
  out: string, timeoutSeconds: number): Promise<T> {
  const backend = spec.backend ?? "claude";
  const stem = path.join(path.dirname(out), path.basename(out, ".json"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${stem}.prompt.md`, prompt);
  const schemaFile = `${stem}.schema.json`;
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE; // allow launching an independent headless session
  let cmd: string[];
  let input: string | undefined;
  const lastMessage = `${stem}.last.json`;
  if (backend === "claude") {
    cmd = ["claude", "-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob",
      "--no-session-persistence", "--setting-sources", ""];
    if (spec.model) cmd.push("--model", spec.model);
  } else if (backend === "codex") {
    cmd = ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
      "--output-schema", schemaFile, "-o", lastMessage, "-C", root];
    if (spec.model) cmd.push("-m", spec.model);
    for (const image of images) cmd.push("-i", image);
    cmd.push(prompt);
  } else if (backend === "exec") {
    if (!spec.command) throw new ReviewerError("exec reviewer needs a 'command' list");
    cmd = Array.isArray(spec.command) ? spec.command.map(String) : ["sh", "-c", spec.command];
    env.HELIX_SCHEMA_FILE = schemaFile;
    env.HELIX_IMAGES = images.join(path.delimiter);
    input = prompt;
  } else {
    throw new ReviewerError(`unknown reviewer backend '${backend}'`);
  }
  const result = await runProcess(cmd, { cwd: root, env, input, timeoutMs: timeoutSeconds * 1000 });
  if (result.missing) throw new ReviewerError(`reviewer backend '${backend}' is not installed (${cmd[0]} not found)`);
  fs.writeFileSync(`${stem}.raw.txt`, `$ exit ${result.code}\n${result.stdout}\n--- stderr\n${result.stderr}`);
  if (result.timedOut) throw new ReviewerError(`reviewer timed out after ${timeoutSeconds}s`);
  if (result.code !== 0) {
    throw new ReviewerError(`reviewer exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-800)}`);
  }
  let verdict: any;
  try {
    if (backend === "claude") {
      const envelope = JSON.parse(result.stdout);
      if (envelope.is_error) throw new ReviewerError(`reviewer error: ${envelope.result}`);
      verdict = envelope.structured_output ?? JSON.parse(envelope.result ?? "");
    } else if (backend === "codex") {
      verdict = readJson(lastMessage);
    } else {
      verdict = JSON.parse(result.stdout);
    }
  } catch (error) {
    if (error instanceof ReviewerError) throw error;
    throw new ReviewerError(`reviewer returned unparseable output: ${(error as Error).message}`);
  }
  checkSchema(verdict, schema);
  writeJson(out, verdict);
  return verdict as T;
}

function fill(template: string, values: Record<string, string>): string {
  let text = template;
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, () => value);
  const leftover = text.match(/\{\{\w+\}\}/g);
  if (leftover) throw new HelixError(`Prompt template has unfilled placeholders: ${leftover.join(", ")}`);
  return text;
}

function formatTests(cp: Checkpoint): string {
  return cp.tests
    .map((t) => `- [${t.id}] (${t.kind ?? "happy"}) ${t.name}: given ${t.given}; when ${t.when}; then ${t.then}`)
    .join("\n") || "(none)";
}

// ---------------------------------------------------------------- commands

type Args = { _: string[]; [flag: string]: any };

/** Reviewers run on whichever agent CLI is installed, preferring Claude Code. */
function defaultConfig(): Config {
  const config = clone(DEFAULT_CONFIG);
  if (!Bun.which("claude") && Bun.which("codex")) {
    config.reviewers.ui = { backend: "codex" };
    config.reviewers.code = [{ backend: "codex", lens: "architecture" }, { backend: "codex", lens: "correctness" }];
  }
  return config;
}

function cmdInit(args: Args) {
  const root = repoRoot();
  const file = configPath(root);
  const config: Config = fs.existsSync(file) ? readJson(file) : defaultConfig();
  if (args["test-command"] !== undefined) config.test_command = args["test-command"];
  for (const [flag, key] of [["guideline", "guidelines"], ["design", "design"]] as const) {
    for (const item of (args[flag] as string[] | undefined) ?? []) {
      if (!fs.existsSync(path.join(root, item))) {
        throw new HelixError(`${key} file '${item}' does not exist (paths are relative to the repo root).`);
      }
      config[key] ??= [];
      if (!config[key].includes(item)) config[key].push(item);
    }
  }
  config.ui ??= clone(DEFAULT_CONFIG.ui);
  if (args["no-ui"]) config.ui.enabled = false;
  if (args["capture-notes"] !== undefined) config.ui.capture_notes = args["capture-notes"];
  writeJson(file, config);
  if (!fs.existsSync(learningsPath(root))) {
    appendLearning(root, "Keep checkpoints small; a reviewer should grasp each one at a glance.", "helix init");
  }
  console.log(`Helix config: ${file}`);
  console.log(JSON.stringify(config, null, 2));
  if (!config.test_command) {
    console.log("\nWARNING: no test_command yet. The behavior gate cannot run without one " +
      "(set it with `helix init --test-command ...`).");
  }
  if (!config.guidelines?.length) {
    console.log("\nWARNING: no guidelines documents. Adversarial reviewers need a written standard to enforce " +
      "(add with `helix init --guideline docs/architecture.md`).");
  }
}

function cmdNew(args: Args) {
  const root = repoRoot();
  loadConfig(root);
  const runId = slugify(args._[0]);
  if (fs.existsSync(path.join(runDir(root, runId), "state.json"))) {
    throw new HelixError(`Run '${runId}' already exists. Use \`helix status ${runId}\`.`);
  }
  const run: Run = {
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

function cmdPlan(args: Args) {
  const root = repoRoot();
  const specs = validateCheckpoints(readJsonInput(args.file));
  const { run } = transaction(root, args._[0], (run) => {
    if (run.status !== "planning" && run.status !== "awaiting_plan_approval") {
      throw new HelixError(`The plan is locked once building starts (status '${run.status}'). ` +
        `Use \`helix add ${run.id} --file ...\` to append checkpoints.`);
    }
    run.checkpoints = [];
    for (const spec of specs) run.checkpoints.push(newCheckpoint(run, spec));
    run.status = "planning";
    run.awaiting = null;
    run.history.push({ at: now(), event: `plan loaded (${specs.length} checkpoints)` });
  });
  for (const cp of run.checkpoints) console.log(`${cp.id}: ${cp.title}${cp.ui ? "  [ui]" : ""}`);
  console.log("Next:", nextAction(run));
}

function cmdTests(args: Args) {
  const root = repoRoot();
  let data = readJsonInput(args.file);
  if (data && typeof data === "object" && !Array.isArray(data) && "checkpoints" in data) data = data.checkpoints;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HelixError('Expected {"checkpoints": {"cp-1": [ {name, given, when, then, kind}, ... ]}}');
  }
  const ids = Object.keys(data);
  const { run } = transaction(root, args._[0], (run) => {
    const problems: string[] = [];
    for (const [cpId, cases] of Object.entries<any>(data)) {
      const cp = cpById(run, cpId);
      if (cp.status === "committed") {
        problems.push(`${cpId} is already committed`);
        continue;
      }
      if (!Array.isArray(cases) || !cases.length) {
        problems.push(`${cpId}: needs at least one test case`);
        continue;
      }
      const clean: TestCase[] = cases.map((c: any, i: number) => {
        const missing = ["name", "given", "when", "then"].filter((k) => !String(c?.[k] ?? "").trim());
        if (missing.length) problems.push(`${cpId} case ${i + 1}: missing ${missing.join(", ")}`);
        const kind = c?.kind ?? "happy";
        if (!["happy", "edge", "error"].includes(kind)) {
          problems.push(`${cpId} case ${i + 1}: kind must be happy, edge or error`);
        }
        const field = (k: string) => String(c?.[k] ?? "").trim();
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

function cmdSubmitPlan(args: Args) {
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
  console.log("STOP now and ask the engineer to review the plan in the viewer.");
}

function requireHumanReply(run: Run, kinds: Awaiting["kind"][]): Awaiting {
  const awaiting = run.awaiting;
  if (!awaiting || !kinds.includes(awaiting.kind)) {
    throw new HelixError(`Run '${run.id}' is not waiting for the engineer (${run.status}).`);
  }
  if (!awaiting.replies.length) {
    throw new HelixError(
      "No engineer reply has been recorded since approval was requested. Only the engineer can approve: " +
      "stop and wait for their message. (If they did reply, the Helix hooks are not armed in this " +
      "session: invoke the helix skill again to arm them, then ask the engineer to reply again.)");
  }
  return awaiting;
}

function cmdApprove(args: Args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    const awaiting = requireHumanReply(run, ["plan", "checkpoint"]);
    const reply = awaiting.replies.at(-1)!.text;
    if (awaiting.kind === "plan") {
      const dirty = dirtyFiles(root);
      if (dirty.length) {
        throw new HelixError("Working tree has uncommitted changes. Each checkpoint commits " +
          `everything, so ask the engineer to commit or stash first:\n${dirty.slice(0, 20).join("\n")}`);
      }
      if (!head(root)) throw new HelixError("The repository has no commits yet. Make an initial commit first.");
      run.awaiting = null;
      run.history.push({ at: now(), event: "plan approved", reply });
      advance(root, run);
    } else {
      const cp = cpById(run, awaiting.cp!);
      const fp = fingerprint(root);
      if (fp !== awaiting.fingerprint) {
        throw new HelixError("The code changed after approval was requested, so the engineer approved a " +
          "different tree. Rerun the gates and request approval again.");
      }
      cp.gates.human = { status: "passed", fingerprint: fp, at: now(), mode: "engineer", reply };
      run.status = "building";
      run.awaiting = null;
      run.history.push({ at: now(), event: `${cp.id} approved`, reply });
    }
  });
  console.log("Approved.");
  console.log("Next:", nextAction(run, root));
}

function cmdFeedback(args: Args) {
  const root = repoRoot();
  const { run, result: { kind, target } } = transaction(root, args._[0], (run) => {
    const awaiting = requireHumanReply(run, ["plan", "checkpoint", "final"]);
    const reply = awaiting.replies.at(-1)!.text;
    const entry: Feedback = { at: now(), text: args.text, reply };
    let target: string;
    if (awaiting.kind === "plan") {
      run.plan_feedback = [...(run.plan_feedback ?? []), entry];
      run.status = "planning";
      run.awaiting = null;
      target = "plan";
    } else if (awaiting.kind === "checkpoint") {
      const cp = cpById(run, awaiting.cp!);
      cp.feedback.push(entry);
      cp.feedback_fingerprint = fingerprint(root);
      delete cp.gates.human;
      run.status = "building";
      run.awaiting = null;
      target = cp.id;
    } else {
      run.final_feedback = [...(run.final_feedback ?? []), entry];
      target = "final review";
    }
    if (args.learning) appendLearning(root, args.learning, `${run.id} ${target}`);
    run.history.push({ at: now(), event: `feedback on ${target}`, reply });
    return { kind: awaiting.kind, target };
  });
  console.log(`Feedback recorded on ${target}.${args.learning ? ` Learning saved to ${learningsPath(root)}.` : ""}`);
  if (kind === "final") console.log(`Turn it into checkpoints with \`helix add ${run.id} --file <checkpoints.json>\`.`);
  else console.log("Next:", nextAction(run, root));
}

function ensurePriorGates(run: Run, cp: Checkpoint, gate: Gate, fp: string, config: Config) {
  const order = requiredGates(cp, config);
  for (const prior of order.slice(0, order.indexOf(gate))) {
    const state = gateState(cp, prior, fp);
    if (state !== "passed") {
      throw new HelixError(`Gates run in order: the ${prior} gate is ${state} for the current tree. ` +
        `Pass it before the ${gate} gate.\nNext: ${nextAction(run, null, config)}`);
    }
  }
}

function recordGate(root: string, runId: string, gate: Gate, record: GateRecord) {
  return transaction(root, runId, (run) => {
    const cp = requireCurrent(run);
    cp.gates[gate] = record;
    run.history.push({ at: now(), event: `${cp.id} ${gate} ${record.status} (attempt ${record.attempt})` });
  }).run;
}

function beginAttempt(root: string, runId: string, gate: Gate) {
  const { run, result } = transaction(root, runId, (run) => nextAttempt(requireCurrent(run), gate));
  return { run, cp: requireCurrent(run), attempt: result };
}

function gateBehavior(args: Args) {
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
  const timedOut = (proc.error as any)?.code === "ETIMEDOUT" || proc.signal === "SIGTERM";
  const code = timedOut ? 124 : (proc.status ?? 1);
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}${timedOut ? `\nTIMEOUT after ${config.test_timeout_seconds}s` : ""}`;
  fs.writeFileSync(log, `$ ${command}\n${output}\n$ exit ${code}\n`);
  const fpAfter = fingerprint(root);
  let status: GateRecord["status"] = "passed";
  let reason = "";
  if (code !== 0) [status, reason] = ["failed", `test command exited ${code}`];
  else if (fpAfter !== fpBefore) [status, reason] = ["failed", "the test run modified the working tree (gitignore generated files)"];
  const run = recordGate(root, runId, "behavior", {
    status, fingerprint: fpBefore, at: now(), attempt, command, exit: code, reason, evidence: relTo(root, log),
  });
  console.log(`Behavior gate ${status.toUpperCase()} for ${cp.id} (attempt ${attempt}). Log: ${relTo(root, log)}`);
  if (status !== "passed") {
    console.log(`Reason: ${reason}\n--- last lines ---`);
    console.log(output.trim().split("\n").slice(-40).join("\n"));
    throw new GateExit(2);
  }
  console.log("Next:", nextAction(run, root, config));
}

async function gateUi(args: Args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const runId = args._[0];
  const run0 = loadRun(root, runId);
  const cp0 = requireCurrent(run0);
  if (!requiredGates(cp0, config).includes("ui")) {
    throw new HelixError(`${cp0.id} is not a UI checkpoint; the UI gate does not apply.`);
  }
  const pairs: [string, string, string][] = args.pair ?? [];
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
  const learnings = readLearnings(root) || "(none yet)";
  const jobs = sources.map(({ ref, impl, state }, index) => {
    const n = index + 1;
    const copy = (src: string, kind: string) => {
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
      const verdict = await runReviewer<UiVerdict>(config.reviewers.ui, job.prompt, UI_SCHEMA, job.images, root, job.out,
        config.reviewers.timeout_seconds);
      return { ...job, verdict, error: null as string | null };
    } catch (error) {
      if (!(error instanceof ReviewerError)) throw error;
      return { ...job, verdict: null, error: error.message };
    }
  }));
  let status: GateRecord["status"] = "passed";
  const lines: string[] = [];
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
  const report = path.join(outDir, "report.md");
  fs.writeFileSync(report, `# UI review ${cp.id} attempt ${attempt}: ${status}\n\n${lines.join("\n")}\n`);
  if (fingerprint(root) !== fp) {
    status = "error";
    lines.push("The working tree changed while the UI review ran; rerun the gate.");
  }
  const run = recordGate(root, runId, "ui", { status, fingerprint: fp, at: now(), attempt, evidence: relTo(root, report) });
  console.log(`UI gate ${status.toUpperCase()} for ${cp.id} (attempt ${attempt}). Report: ${relTo(root, report)}`);
  console.log(lines.join("\n"));
  if (status === "invalid") {
    console.log("\nThe reviewer says the screenshots do not show the same state or section. Recapture both apps in " +
      "the same state and rerun the gate.");
  }
  if (status !== "passed") throw new GateExit(status === "invalid" ? 3 : 2);
  console.log("Next:", nextAction(run, root, config));
}

async function gateReview(args: Args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const runId = args._[0];
  const run0 = loadRun(root, runId);
  const cp0 = requireCurrent(run0);
  const fp = fingerprint(root);
  ensurePriorGates(run0, cp0, "review", fp, config);
  const diff = git(root, ["diff", "--no-color", cp0.base!, fp]);
  if (!diff.trim()) throw new HelixError(`${cp0.id} has no changes against its base commit; nothing to review.`);
  const reviewers = config.reviewers.code;
  if (reviewers.length < 2) {
    throw new HelixError("The adversarial gate needs at least two independent reviewers in config.reviewers.code.");
  }
  const { run: started, cp, attempt } = beginAttempt(root, runId, "review");
  const outDir = path.join(evidenceDir(root, started, cp), `review-${pad3(attempt)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const diffFile = path.join(outDir, "diff.patch");
  fs.writeFileSync(diffFile, `${diff}\n`);
  const changed = git(root, ["diff", "--name-only", cp.base!, fp]).split("\n").filter(Boolean);
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "code-reviewer.md"), "utf8");
  const results = await Promise.all(reviewers.map(async (spec, index) => {
    const n = index + 1;
    const prompt = fill(template, {
      LENS: spec.lens ?? "general",
      CHECKPOINT: `${cp.id}: ${cp.title} - ${cp.summary}`,
      DONE_WHEN: bullet(cp.done_when),
      TESTS: formatTests(cp),
      GUIDELINES: bullet(config.guidelines, "(no guidelines documents configured: apply general engineering " +
        "standards and the conventions visible in the existing code)"),
      LEARNINGS: readLearnings(root) || "(none yet)",
      DIFF: relTo(root, diffFile),
      CHANGED: bullet(changed),
      REFERENCE: bullet(cp.reference.length ? cp.reference : [started.reference || "(none)"]),
    });
    const name = `reviewer ${n} (${spec.backend ?? "claude"}, ${spec.lens ?? "general"})`;
    try {
      const verdict = await runReviewer<CodeVerdict>(spec, prompt, CODE_SCHEMA, [], root,
        path.join(outDir, `reviewer-${n}.json`), config.reviewers.timeout_seconds);
      return { name, verdict, error: null as string | null };
    } catch (error) {
      if (!(error instanceof ReviewerError)) throw error;
      return { name, verdict: null, error: error.message };
    }
  }));
  let status: GateRecord["status"] = "passed";
  const lines: string[] = [];
  for (const { name, verdict, error } of results) {
    if (error || !verdict) {
      if (status === "passed") status = "error";
      lines.push(`## ${name}: ERROR\n${error}`);
      continue;
    }
    const approved = verdict.verdict === "approve" && !verdict.findings.length;
    if (!approved) status = "failed";
    lines.push(`## ${name}: ${approved ? "APPROVE" : "CHANGES REQUESTED"}\n${verdict.summary}`);
    for (const f of verdict.findings) {
      lines.push(`- [${f.severity}] ${f.file}:${f.line} (${f.rule}): ${f.problem}\n  Required fix: ${f.required_fix}`);
    }
  }
  const report = path.join(outDir, "findings.md");
  fs.writeFileSync(report, `# Adversarial review ${cp.id} attempt ${attempt}: ${status}\n\n${lines.join("\n\n")}\n`);
  if (fingerprint(root) !== fp) {
    status = "error";
    lines.push("The working tree changed while reviewers ran; rerun the gate.");
  }
  const run = recordGate(root, runId, "review", { status, fingerprint: fp, at: now(), attempt, evidence: relTo(root, report) });
  console.log(`Adversarial review ${status.toUpperCase()} for ${cp.id} (attempt ${attempt}). Findings: ${relTo(root, report)}`);
  console.log(lines.join("\n\n"));
  if (status !== "passed") {
    console.log("\nEvery finding must be fixed. After fixing, rerun the behavior gate (and the UI gate if anything " +
      "visible changed), then this gate.");
    throw new GateExit(2);
  }
  console.log("Next:", nextAction(run, root, config));
}

function cmdRequestApproval(args: Args) {
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
      run.history.push({ at: now(), event: `${cp.id} auto-approved (autonomous mode)` });
      return { cp, mode: "autonomous" as const };
    }
    run.status = "awaiting_approval";
    run.awaiting = { kind: "checkpoint", cp: cp.id, since: now(), replies: [], fingerprint: fp };
    run.history.push({ at: now(), event: `${cp.id} awaiting engineer approval` });
    return { cp, mode: "engineer" as const };
  });
  if (mode === "autonomous") {
    console.log(`${cp.id}: autonomous mode approved it (the automated gates all passed). ` +
      `Run \`helix commit ${run.id}\`.`);
    return;
  }
  console.log(`${cp.id} is ready for the engineer. Viewer: ${path.join(runDir(root, run.id), "viewer.html")}`);
  console.log("STOP now. Tell the engineer what the checkpoint does, where to see it running, and the evidence " +
    "(tests, UI review, reviewer verdicts). Wait for approval or feedback.");
}

function cmdCommit(args: Args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const fp = fingerprint(root);
  const { run, result: cp } = transaction(root, args._[0], (run) => {
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
      const { fingerprint: _, ...record } = cp.gates[g]!;
      return [g, record];
    }));
    const evidence = evidenceDir(root, run, cp);
    writeJson(path.join(evidence, "summary.json"), { checkpoint: cp.title, gates: summary });
    cp.status = "committed";
    cp.committed_at = now();
    cp.tree = fp;
    git(root, ["add", "-A"]);
    const gateLines = gates.map((g) => {
      const record = cp.gates[g]!;
      if (record.mode === "waived") return `- ${g}: waived by the engineer (${record.reply})`;
      return `- ${g}: passed (attempt ${record.attempt ?? 1}${g === "human" ? `, ${record.mode}` : ""})`;
    }).join("\n");
    const message = `helix(${run.id}): ${cp.id} ${cp.title}\n\n${cp.summary}\n\nGates:\n${gateLines}\n`;
    git(root, ["commit", "-q", "-m", message]);
    cp.commit = head(root);
    run.history.push({ at: now(), event: `${cp.id} committed ${cp.commit!.slice(0, 10)}` });
    advance(root, run);
    return cp;
  });
  console.log(`Committed ${cp.id} as ${cp.commit!.slice(0, 10)}.`);
  console.log("Next:", nextAction(run, root, config));
}

function cmdAdd(args: Args) {
  const root = repoRoot();
  const specs = validateCheckpoints(readJsonInput(args.file));
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
      advance(root, run);
    }
    run.history.push({ at: now(), event: `added ${added.join(", ")}` });
    return added;
  });
  console.log(`Added ${added.join(", ")}. Plan test cases for them with \`helix tests ${run.id} --file ...\`.`);
  console.log("Next:", nextAction(run, root));
}

function cmdAutonomy(args: Args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    const grantedBy = run.last_prompt?.text ?? "";
    if (args.off) {
      run.autonomy = { remaining: 0, granted_by: "" };
    } else {
      if (!grantedBy) {
        throw new HelixError("Autonomy must come from the engineer, but no engineer prompt is recorded for this " +
          "run. Invoke the helix skill again so its hooks are armed, then ask again.");
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
 * adversarial review can never be waived.
 */
function cmdWaive(args: Args) {
  const root = repoRoot();
  const gate = args._[1];
  if (gate !== "ui") throw new HelixError("Only the ui gate can be waived; behavior and review always run.");
  const reason = String(args.reason ?? "").trim();
  if (!reason) throw new HelixError("--reason is required: record the engineer's ruling in their words.");
  const { run, result: cp } = transaction(root, args._[0], (run) => {
    const cp = requireCurrent(run);
    if (!cp.ui) throw new HelixError(`${cp.id} has no UI gate to waive.`);
    cp.gates.ui = { status: "passed", fingerprint: "", at: now(), mode: "waived", reply: reason };
    run.history.push({ at: now(), event: `${cp.id} ui gate waived by the engineer`, reply: reason });
    return cp;
  });
  console.log(`${cp.id}: UI gate waived (${reason}).`);
  console.log("Next:", nextAction(run, root));
}

function cmdAsk(args: Args) {
  const root = repoRoot();
  transaction(root, args._[0], (run) => {
    if (!ACTIVE.has(run.status)) throw new HelixError(`Run is '${run.status}'.`);
    run.awaiting = { kind: "input", since: now(), replies: [], resume: run.status, question: args._[1] };
    run.status = "awaiting_input";
  });
  console.log("Recorded. Ask the engineer your question now and stop; the run resumes on their reply.");
}

function cmdPause(args: Args) {
  const root = repoRoot();
  transaction(root, args._[0], (run) => {
    if (run.status === "done" || run.status === "paused") throw new HelixError(`Run is already '${run.status}'.`);
    run.paused_from = run.status;
    run.status = "paused";
    run.history.push({ at: now(), event: "paused", reply: run.last_prompt?.text ?? null });
  });
  console.log("Paused. The Stop hook will not hold the session until `helix resume`.");
}

function cmdResume(args: Args) {
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

function cmdLearn(args: Args) {
  const root = repoRoot();
  loadConfig(root);
  appendLearning(root, args._[0], args.source ?? "engineer");
  console.log(`Saved to ${relTo(root, learningsPath(root))}.`);
}

function cmdStatus(args: Args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const ids = args._[0] ? [args._[0]] : allRunIds(root);
  if (!ids.length) {
    console.log(`Config: ${configPath(root)}\nLearnings: ${learningsPath(root)}\n`);
    console.log("No Helix runs. Start one with `helix new`.");
    return;
  }
  console.log(`Config: ${configPath(root)}\nLearnings: ${learningsPath(root)}\n`);
  const fp = fingerprint(root);
  ids.forEach((rid, index) => {
    const run = loadRun(root, rid);
    const mode = run.autonomy.remaining;
    console.log(`Run ${rid}: ${run.title}  [${run.status}]  autonomy=${mode ?? "all"}  owner=${run.owner_session || "-"}`);
    for (const cp of run.checkpoints) {
      const marker = cp.id === run.current ? ">" : " ";
      const gates = requiredGates(cp, config)
        .map((g) => `${g}:${cp.status === "committed" ? "passed" : gateState(cp, g, fp)}`).join(" ");
      console.log(` ${marker} ${cp.id.padEnd(6)} ${cp.status.padEnd(11)} ${cp.title.padEnd(40)} ${gates}`);
    }
    console.log("Next:", nextAction(run, root, config));
    console.log(`Work dir: ${workDir(root, rid)}`);
    console.log(`Viewer: ${path.join(runDir(root, rid), "viewer.html")}`);
    if (ids.length > 1 && index < ids.length - 1) console.log();
  });
}

function cmdView(args: Args) {
  const root = repoRoot();
  const run = loadRun(root, args._[0]);
  renderViewer(root, run);
  const file = path.join(runDir(root, run.id), "viewer.html");
  if (!args["no-open"]) openFile(file);
  console.log(file);
}

/**
 * Codex reads hooks from ~/.codex/hooks.json (the same shape as Claude Code's).
 * Installing there, not in the repo, keeps the working tree untouched; the
 * hooks do nothing outside a Helix run the session owns.
 */
function cmdHooks(args: Args) {
  const agent = args._[0];
  if (agent !== "codex") {
    throw new HelixError("Only `helix hooks codex` is needed: Claude Code arms Helix's hooks from SKILL.md when the skill runs.");
  }
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json");
  const config = fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() ? readJson(file) : {};
  config.hooks ??= {};
  const script = path.join(SKILL_DIR, "scripts", "helix.ts");
  for (const [event, arg] of [["Stop", "stop"], ["UserPromptSubmit", "prompt"]] as const) {
    const command = `bun ${JSON.stringify(script)} hook ${arg} || true`;
    const groups: any[] = (config.hooks[event] ??= []);
    const isHelix = (hook: any) => typeof hook?.command === "string" && hook.command.includes(`helix.ts" hook ${arg}`);
    for (const group of groups) group.hooks = (group.hooks ?? []).filter((hook: any) => !isHelix(hook));
    config.hooks[event] = groups.filter((group) => group.hooks.length);
    config.hooks[event].push({ hooks: [{ type: "command", command, timeout: 30 }] });
  }
  writeJson(file, config);
  console.log(`Installed Helix Stop and UserPromptSubmit hooks in ${file}.`);
  console.log("Codex asks you to review and trust new hooks the next time it starts; approve them there.");
}

function openFile(file: string) {
  if (process.env.HELIX_NO_OPEN) return;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (Bun.which(opener)) spawnSync(opener, [file], { stdio: "ignore" });
}

// ---------------------------------------------------------------- hooks

/**
 * Entry point for Claude Code hooks. Never throws and never exits non-zero: a
 * crashing hook would block the engineer's prompt.
 */
async function hookMain(event: string) {
  try {
    const data = JSON.parse((await Bun.stdin.text()) || "{}");
    const root = repoRoot(data.cwd || process.cwd());
    if (!fs.existsSync(runsDir(root))) return;
    const sid = data.session_id ?? null;
    const mine = allRunIds(root).filter((rid) => {
      const owner = loadRun(root, rid).owner_session;
      return owner === sid || owner === null;
    });
    if (event === "prompt") hookPrompt(root, mine, data);
    else if (event === "stop") hookStop(root, mine);
  } catch (error) {
    try {
      fs.appendFileSync(path.join(sharedDir(repoRoot()), "hook-errors.log"), `${now()} ${event}: ${error}\n`);
    } catch {
      // hooks fail open
    }
  }
}

function hookPrompt(root: string, runIds: string[], data: any) {
  const text = String(data.prompt ?? "").slice(0, 4000);
  const notes: string[] = [];
  for (const rid of runIds) {
    const { run } = transaction(root, rid, (run) => {
      if (data.session_id) run.owner_session = data.session_id;
      run.last_prompt = { at: now(), text };
      const awaiting = run.awaiting;
      if (awaiting) {
        awaiting.replies.push({ at: now(), text });
        if (awaiting.kind === "input") {
          run.status = awaiting.resume ?? "building";
          run.awaiting = null;
        }
      }
      run.stop_guard = null;
    }, false);
    if (run.status !== "done" || run.awaiting) notes.push(`Helix run '${rid}' is ${run.status}. ${nextAction(run)}`);
  }
  if (notes.length) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${notes.join("\n")}\nRe-read the helix skill before acting if it is not loaded.`,
      },
    }));
  }
}

function hookStop(root: string, runIds: string[]) {
  for (const rid of runIds) {
    const snapshot = loadRun(root, rid);
    if (!ACTIVE.has(snapshot.status)) continue;
    const fp = fingerprint(root);
    const { stop_guard: _g, updated_at: _u, last_prompt: _p, ...essence } = snapshot;
    const signature = createHash("sha256").update(JSON.stringify([fp, essence])).digest("hex");
    const { run, result: stalled } = transaction(root, rid, (run) => {
      const guard = run.stop_guard;
      const count = guard?.signature === signature ? guard.count + 1 : 1;
      if (count > MAX_IDENTICAL_STOPS) {
        run.stalled_from = run.status;
        run.status = "stalled";
        run.stop_guard = null;
        run.history.push({ at: now(), event: "stalled: no progress across stop attempts" });
        return true;
      }
      run.stop_guard = { signature, count };
      return false;
    }, false);
    if (stalled) {
      console.log(JSON.stringify({
        systemMessage: `Helix run '${rid}' stalled: the agent made no progress across ${MAX_IDENTICAL_STOPS} ` +
          "attempts to stop. Reply to resume it.",
      }));
      return;
    }
    const reason = `Helix run '${rid}' is not finished and no gate lets you stop here. An attempt may be wrong; it ` +
      `may not stop until the gates pass. Next required action: ${nextAction(run, root)}`;
    console.log(JSON.stringify({ decision: "block", reason }));
    return;
  }
}

// ---------------------------------------------------------------- viewer

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Self-contained HTML page the engineer reviews the plan and progress in. */
function renderViewer(root: string, run: Run) {
  let config = DEFAULT_CONFIG;
  try {
    config = loadConfig(root);
  } catch {
    // render with defaults
  }
  let fp: string | null = null;
  try {
    fp = fingerprint(root);
  } catch {
    // outside a usable repo: show recorded gate states
  }
  const dir = runDir(root, run.id);
  const view = {
    id: run.id, title: run.title, goal: run.goal ?? "", status: run.status,
    reference: run.reference ?? "", target: run.target ?? "",
    autonomy: run.autonomy.remaining, current: run.current, updated: run.updated_at ?? "",
    next: run.status !== "building" ? nextAction(run, null, config) : "",
    history: run.history.slice(-12),
    checkpoints: run.checkpoints.map((cp) => ({
      id: cp.id, title: cp.title, summary: cp.summary, done_when: cp.done_when, ui: cp.ui,
      ui_scope: cp.ui_scope ?? "", status: cp.status, tests: cp.tests,
      gates: requiredGates(cp, config).map((g) => {
        const record = cp.gates[g];
        return {
          name: g,
          state: cp.status === "committed" ? "passed" : gateState(cp, g, fp),
          attempt: record?.attempt ?? null,
          evidence: record?.evidence ? path.relative(dir, path.resolve(root, record.evidence)) : "",
        };
      }),
      commit: (cp.commit ?? "").slice(0, 10),
      feedback: cp.feedback.map((f) => f.text),
    })),
  };
  const template = fs.readFileSync(path.join(SKILL_DIR, "scripts", "viewer.html"), "utf8");
  const data = JSON.stringify(view).replaceAll("</", "<\\/");
  const page = template
    .replace("{{TITLE}}", () => escapeHtml(run.title))
    .replace("{{REFRESH}}", ACTIVE.has(run.status) ? "4" : "0")
    .replace("/*HELIX_DATA*/null", () => data);
  fs.writeFileSync(path.join(dir, "viewer.html"), page);
}

// ---------------------------------------------------------------- cli

interface CommandSpec {
  help: string;
  usage: string;
  positionals: number;
  optionalPositionals?: number;
  flags?: Record<string, "string" | "boolean" | "repeat" | "triple">;
  required?: string[];
  run: (args: Args) => void | Promise<void>;
}

const RUN = "<run>";
const COMMANDS: Record<string, CommandSpec> = {
  init: {
    help: "create or update the Helix config (stored in the git dir, shared by all worktrees)",
    usage: "init [--test-command CMD] [--guideline FILE]... [--design FILE]... [--no-ui] [--capture-notes TEXT]",
    positionals: 0,
    flags: { "test-command": "string", guideline: "repeat", design: "repeat", "no-ui": "boolean", "capture-notes": "string" },
    run: cmdInit,
  },
  new: {
    help: "start a run", usage: "new <name> --goal TEXT --reference TEXT [--title TEXT] [--target TEXT]",
    positionals: 1, flags: { title: "string", goal: "string", reference: "string", target: "string" },
    required: ["goal", "reference"], run: cmdNew,
  },
  plan: {
    help: "load the checkpoint plan (replaces it while planning)", usage: `plan ${RUN} --file FILE`,
    positionals: 1, flags: { file: "string" }, required: ["file"], run: cmdPlan,
  },
  tests: {
    help: "attach planned test cases to checkpoints", usage: `tests ${RUN} --file FILE`,
    positionals: 1, flags: { file: "string" }, required: ["file"], run: cmdTests,
  },
  "submit-plan": {
    help: "send the plan to the engineer for approval", usage: `submit-plan ${RUN} [--no-open]`,
    positionals: 1, flags: { "no-open": "boolean" }, run: cmdSubmitPlan,
  },
  gate: {
    help: "run a gate for the current checkpoint",
    usage: `gate behavior|ui|review ${RUN} [--pair REF IMPL STATE]...`,
    positionals: 2, flags: { pair: "triple" },
    run: async (args) => {
      const [gate, ...rest] = args._;
      const next = { ...args, _: rest };
      if (gate === "behavior") gateBehavior(next);
      else if (gate === "ui") await gateUi(next);
      else if (gate === "review") await gateReview(next);
      else throw new HelixError(`Unknown gate '${gate}'. Use behavior, ui or review.`);
    },
  },
  "request-approval": {
    help: "hand a checkpoint whose automated gates passed to the engineer", usage: `request-approval ${RUN}`,
    positionals: 1, run: cmdRequestApproval,
  },
  approve: { help: "record the engineer's approval (plan or checkpoint)", usage: `approve ${RUN}`, positionals: 1, run: cmdApprove },
  feedback: {
    help: "record the engineer's feedback (plan, checkpoint or final review)",
    usage: `feedback ${RUN} --text TEXT [--learning TEXT]`,
    positionals: 1, flags: { text: "string", learning: "string" }, required: ["text"], run: cmdFeedback,
  },
  commit: {
    help: "commit the current checkpoint (all gates must pass on this exact tree)", usage: `commit ${RUN}`,
    positionals: 1, run: cmdCommit,
  },
  add: {
    help: "append checkpoints to an approved run (e.g. from engineer feedback)", usage: `add ${RUN} --file FILE`,
    positionals: 1, flags: { file: "string" }, required: ["file"], run: cmdAdd,
  },
  autonomy: {
    help: "let checkpoints skip engineer approval (engineer's request only)",
    usage: `autonomy ${RUN} --checkpoints N | --all | --off`,
    positionals: 1, flags: { checkpoints: "string", all: "boolean", off: "boolean" }, run: cmdAutonomy,
  },
  ask: { help: "stop to ask the engineer a question", usage: `ask ${RUN} QUESTION`, positionals: 2, run: cmdAsk },
  waive: {
    help: "waive the current checkpoint's UI gate (engineer's ruling only)", usage: `waive ${RUN} ui --reason TEXT`,
    positionals: 2, flags: { reason: "string" }, required: ["reason"], run: cmdWaive,
  },
  pause: { help: "pause the run (engineer's request)", usage: `pause ${RUN}`, positionals: 1, run: cmdPause },
  resume: { help: "resume a paused or stalled run", usage: `resume ${RUN}`, positionals: 1, run: cmdResume },
  learn: {
    help: "append a lesson to the shared learnings", usage: "learn TEXT [--source TEXT]",
    positionals: 1, flags: { source: "string" }, run: cmdLearn,
  },
  status: {
    help: "show runs, gates and the next required action", usage: `status [${RUN}]`,
    positionals: 0, optionalPositionals: 1, run: cmdStatus,
  },
  hooks: {
    help: "install Helix's hooks for an agent other than Claude Code", usage: "hooks codex",
    positionals: 1, run: cmdHooks,
  },
  view: {
    help: "render and open the viewer", usage: `view ${RUN} [--no-open]`,
    positionals: 1, flags: { "no-open": "boolean" }, run: cmdView,
  },
};

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(17)} ${spec.help}`);
  return `usage: helix <command> [args]  (helix <command> --help for details)\n\ncommands:\n${lines.join("\n")}\n` +
    "  hook stop|prompt  Claude Code hook entry point";
}

function parse(spec: CommandSpec, argv: string[]): Args {
  const args: Args = { _: [] };
  const flags = spec.flags ?? {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    const kind = flags[name];
    if (!kind) throw new HelixError(`Unknown option --${name}.\nusage: helix ${spec.usage}`);
    const take = () => {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new HelixError(`--${name} needs a value.\nusage: helix ${spec.usage}`);
      return value;
    };
    if (kind === "boolean") args[name] = true;
    else if (kind === "string") args[name] = take();
    else if (kind === "repeat") (args[name] ??= []).push(take());
    else {
      const triple = argv.slice(i + 1, i + 4);
      if (triple.length < 3) throw new HelixError(`--${name} needs 3 values.\nusage: helix ${spec.usage}`);
      (args[name] ??= []).push(triple);
      i += 3;
    }
  }
  const max = spec.positionals + (spec.optionalPositionals ?? 0);
  if (args._.length < spec.positionals || args._.length > max) {
    throw new HelixError(`Wrong number of arguments.\nusage: helix ${spec.usage}`);
  }
  for (const name of spec.required ?? []) {
    if (args[name] === undefined) throw new HelixError(`--${name} is required.\nusage: helix ${spec.usage}`);
  }
  return args;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === "hook") {
    await hookMain(rest[0]);
    return;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  const spec = COMMANDS[command];
  try {
    if (!spec) throw new HelixError(`Unknown command '${command}'.\n${usage()}`);
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(`usage: helix ${spec.usage}\n\n${spec.help}`);
      return;
    }
    await spec.run(parse(spec, rest));
  } catch (error) {
    if (error instanceof GateExit) process.exit(error.code);
    if (error instanceof HelixError) {
      console.error(`helix: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

await main(process.argv.slice(2));
