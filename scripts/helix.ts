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
const GATE_NAME: Record<Gate, string> = { behavior: "behavior tests", ui: "UI review", review: "code review", human: "engineer" };
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
  /** How the engineer's reply reached Helix: a hook saw it, or the agent relayed it. */
  via?: ReplyChannel;
  /** Structured verdict for the viewer (reviewer findings, screenshot pairs). */
  details?: unknown;
  [key: string]: unknown;
}

/** One finished gate attempt, kept so the viewer can show each gate's history. */
interface Attempt { gate: Gate; attempt: number; status: GateRecord["status"] | "changes_requested" | "waived"; at: string }

/** The fixer's answer to one finding of one review attempt. */
interface FixerResponse { attempt: number; status: "fixed" | "disputed"; note: string }

/** The engineer settles a finding: it must be fixed, or it is wrong and never blocks again. */
interface Ruling { decision: "fix" | "drop"; text: string; at: string; attempt: number; via?: ReplyChannel }

/**
 * A code review finding, tracked under one id for the whole checkpoint so a
 * finding raised again keeps its id, and repeats and disputes are visible.
 */
interface TrackedFinding {
  id: string;
  reviewer: number;
  lens: string;
  severity: string;
  file: string;
  line: number;
  rule: string;
  problem: string;
  required_fix: string;
  /** Review attempts that raised it. */
  raised: number[];
  raised_at: string;
  status: "open" | "resolved" | "dropped";
  resolved_in?: number;
  responses: FixerResponse[];
  ruling?: Ruling;
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
  log?: Attempt[];
  /** Every code review finding raised during this checkpoint. */
  findings?: TrackedFinding[];
  /** Tree when the engineer last gave feedback; while unchanged, it is unaddressed. */
  feedback_fingerprint?: string;
  base?: string | null;
  started_at?: string;
  committed_at?: string;
  tree?: string;
  commit?: string | null;
}

type ReplyChannel = "hook" | "relay";
interface Reply { at: string; text: string; via?: ReplyChannel }
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
  /** Session whose prompt hook last recorded a message. */
  hook_session?: string | null;
  /** A prompt hook has recorded the engineer's messages for this run, so relaying is refused. */
  hooked?: boolean;
  stop_guard: { signature: string; count: number } | null;
  history: { at: string; event: string; reply?: string | null }[];
  paused_from?: Status;
  stalled_from?: Status;
  plan_feedback?: Feedback[];
  plan_loaded_at?: string;
  plan_decisions?: string[];
  /** The engineer's words when approving the plan; briefs carry them, since they may settle decisions. */
  plan_approval?: string;
  final_feedback?: Feedback[];
  accepted_at?: string;
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
const nested = (items: string[]) => (items.length ? items : ["(none)"]).map((i) => `  - ${i}`).join("\n");
const pad3 = (n: number) => String(n).padStart(3, "0");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

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

/** A run's JSON input: a path, or a file name in the run's work dir, where briefs tell subagents to write. */
function readRunInput<T = any>(root: string, runId: string, file: string): T {
  const inWork = path.join(workDir(root, runId), file);
  return readJsonInput<T>(!path.isAbsolute(file) && !fs.existsSync(file) && fs.existsSync(inWork) ? inWork : file);
}

/**
 * The calling agent session, so hooks guard the right session. Claude Code and
 * Codex export theirs to commands they run; another harness can export
 * HELIX_SESSION_ID. When one agent runs inside the other both are set, and the
 * nearest agent in the process tree is the caller.
 */
function sessionId(): string | null {
  const claude = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const codex = process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || null;
  if (!claude || !codex) return claude ?? codex ?? (process.env.HELIX_SESSION_ID || null);
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

function logAttempt(cp: Checkpoint, gate: Gate, status: Attempt["status"], attempt?: number) {
  cp.log ??= [];
  const n = attempt ?? cp.log.filter((a) => a.gate === gate).length + 1;
  cp.log.push({ gate, attempt: n, status, at: now() });
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

// ---------------------------------------------------------------- review findings

/** Raised this many times since the engineer last ruled on it, a finding goes to the engineer. */
const STUCK_AFTER = 3;

const RESPONSE_FORMAT = '{"responses": [{"id": "F1", "status": "fixed", "note": "what you changed"}, ' +
  '{"id": "F2", "status": "disputed", "note": "why the finding is wrong, with evidence"}]}';

const openFindings = (cp: Checkpoint) => (cp.findings ?? []).filter((f) => f.status === "open");

/** The fixer has not answered the finding's latest raise yet. */
const unanswered = (f: TrackedFinding) => !f.responses.some((r) => r.attempt === f.raised.at(-1));

const sortFindings = (findings: TrackedFinding[]) =>
  [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id, "en", { numeric: true }));

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

/**
 * A finding the fixer and the reviewers are going in circles on: raised again
 * after the fixer disputed it, or raised STUCK_AFTER times since the engineer
 * last ruled on it. Only the engineer can settle it.
 */
function isStuck(f: TrackedFinding): boolean {
  if (f.status !== "open") return false;
  const since = f.ruling?.attempt ?? 0;
  const last = f.raised.at(-1)!;
  return f.responses.some((r) => r.status === "disputed" && r.attempt > since && r.attempt < last) ||
    f.raised.filter((a) => a > since).length >= STUCK_AFTER;
}

function stuckReason(f: TrackedFinding): string {
  const since = f.ruling?.attempt ?? 0;
  const disputed = f.responses.some((r) => r.status === "disputed" && r.attempt > since);
  return disputed ? `${f.id} (the fixer disputed it, the reviewer raised it again)`
    : `${f.id} (raised ${f.raised.filter((a) => a > since).length} times)`;
}

function needsRuling(rid: string, stuck: TrackedFinding[]): string {
  return (`the reviewers and the fixer are going in circles on ${stuck.map(stuckReason).join(", ")}. Do not ` +
    `dispatch the fixer again; the engineer settles it. Ask them with \`helix ask ${rid} ` +
    `${stuck.map((f) => `--finding ${f.id}`).join(" ")}\`, which quotes each finding and the fixer's answer. Then ` +
    `record each ruling with \`helix rule ${rid} <id> fix|drop --text '<their words>'\`.`);
}

function describeFinding(f: TrackedFinding): string {
  const history = f.raised.length > 1 ? `, raised in review attempts ${f.raised.join(", ")}` : "";
  const lines = [
    `- ${f.id} [${f.severity}] ${f.file}:${f.line} (${f.rule}), ${f.lens} reviewer${history}`,
    `  Problem: ${oneLine(f.problem)}`,
    `  Required fix: ${oneLine(f.required_fix)}`,
  ];
  for (const r of f.responses) {
    lines.push(`  Fixer's answer to attempt ${r.attempt}: ${r.status}${r.note ? ` - ${oneLine(r.note)}` : ""}`);
  }
  if (f.ruling) {
    const decision = f.ruling.decision === "fix" ? "it must be fixed" : "the finding is wrong; it is dropped";
    lines.push(`  Engineer's ruling: ${decision} - "${oneLine(f.ruling.text)}"`);
  }
  return lines.join("\n");
}

const responsePath = (root: string, rid: string, cp: Checkpoint, attempt: number) =>
  path.join(workDir(root, rid), "fixes", `${cp.id}-review-${pad3(attempt)}.json`);

function parseResponses(file: string): { id: string; status: FixerResponse["status"]; note: string }[] {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new HelixError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(data?.responses)) throw new HelixError(`${file} must look like ${RESPONSE_FORMAT}`);
  return data.responses.map((item: any, i: number) => {
    const id = String(item?.id ?? "").trim().toUpperCase();
    const note = String(item?.note ?? "").trim();
    if (!id || !["fixed", "disputed"].includes(item?.status)) {
      throw new HelixError(`${file}: responses[${i}] needs an "id" and a "status" of "fixed" or "disputed".`);
    }
    if (item.status === "disputed" && !note) {
      throw new HelixError(`${file}: ${id} is disputed without evidence. Its "note" must say why the finding is wrong.`);
    }
    return { id, status: item.status, note };
  });
}

/**
 * Before the review runs again, the fixer must have answered every open
 * finding of the review it fixed: fixed, or disputed with evidence. The
 * reviewers see those answers, and a finding they raise again after a dispute
 * goes to the engineer instead of another round.
 */
function takeFixerResponses(root: string, run: Run, cp: Checkpoint) {
  const stuck = openFindings(cp).filter(isStuck);
  if (stuck.length) throw new HelixError(`${cp.id}: ${needsRuling(run.id, stuck)}`);
  const due = openFindings(cp).filter(unanswered);
  const missing: string[] = [];
  for (const attempt of new Set(due.map((f) => f.raised.at(-1)!))) {
    const file = responsePath(root, run.id, cp, attempt);
    const raised = due.filter((f) => f.raised.at(-1) === attempt);
    for (const answer of fs.existsSync(file) ? parseResponses(file) : []) {
      const f = raised.find((x) => x.id === answer.id);
      if (!f || !unanswered(f)) {
        throw new HelixError(`${file}: ${answer.id} is not an unanswered finding of review attempt ${attempt} ` +
          `(those are ${raised.map((x) => x.id).join(", ")}).`);
      }
      if (answer.status === "disputed" && f.ruling?.decision === "fix") {
        throw new HelixError(`${file}: the engineer ruled that ${f.id} must be fixed, so it cannot be disputed.`);
      }
      f.responses.push({ attempt, ...answer });
    }
    const left = raised.filter(unanswered).map((f) => f.id);
    if (left.length) missing.push(`${left.join(", ")} in ${file}`);
  }
  if (missing.length) {
    throw new HelixError(`The fixer has not answered every review finding: ${missing.join("; ")}. Dispatch it ` +
      `with \`helix brief ${run.id} fixer\`, or complete the file, as ${RESPONSE_FORMAT}. Then rerun the review.`);
  }
}

type ReviewResult = { name: string; backend: string; lens: string; verdict: CodeVerdict | null; error: string | null };

/**
 * Folds one review attempt into the checkpoint's findings. A finding a
 * reviewer raises again keeps its id; a reviewer's open finding it does not
 * raise again is resolved; one the engineer dropped never blocks again. A
 * reviewer that errored leaves its findings as they were.
 */
function trackFindings(cp: Checkpoint, attempt: number, results: ReviewResult[]) {
  cp.findings ??= [];
  const all = cp.findings;
  const at = now();
  return results.map((result, index) => {
    const reviewer = index + 1;
    const raised: string[] = [];
    const ignored: string[] = [];
    if (!result.verdict) return { raised, ignored };
    const earlier = all.filter((f) => f.reviewer === reviewer && f.status !== "resolved");
    for (const finding of result.verdict.findings) {
      const { repeats, ...fields } = finding;
      const prior = earlier.find((f) => f.id === repeats.trim().toUpperCase() && !raised.includes(f.id));
      if (prior?.status === "dropped") {
        ignored.push(prior.id);
      } else if (prior) {
        Object.assign(prior, fields);
        prior.raised.push(attempt);
        prior.raised_at = at;
        raised.push(prior.id);
      } else {
        const id = `F${all.length + 1}`;
        all.push({ ...fields, id, reviewer, lens: result.lens, raised: [attempt], raised_at: at, status: "open", responses: [] });
        raised.push(id);
      }
    }
    for (const f of earlier) {
      if (f.status === "open" && !raised.includes(f.id)) {
        f.status = "resolved";
        f.resolved_in = attempt;
      }
    }
    return { raised, ignored };
  });
}

/** What the reviewer raised on earlier attempts, for it to check again. */
function earlierFindings(cp: Checkpoint, reviewer: number): string {
  const mine = sortFindings((cp.findings ?? []).filter((f) => f.reviewer === reviewer && f.status !== "resolved"));
  const open = mine.filter((f) => f.status === "open");
  const dropped = mine.filter((f) => f.status === "dropped");
  if (!open.length && !dropped.length) return "None. Review the change from scratch.";
  const sections: string[] = [];
  if (open.length) sections.push(`Still open from your earlier reviews:\n\n${open.map(describeFinding).join("\n")}`);
  if (dropped.length) {
    sections.push("Dropped by the engineer. Their ruling is final: never raise these again, in any form:\n\n" +
      dropped.map(describeFinding).join("\n"));
  }
  return sections.join("\n\n");
}

// ---------------------------------------------------------------- next action

/** For agents without a prompt hook: how the engineer's next message reaches Helix. */
const relayHint = (run: Run) => run.hooked ? "" : (" No prompt hook has recorded the engineer's messages for this " +
  `run, so relay their reply word for word first: \`helix reply ${run.id} --text '<their exact words>'\`.`);

/**
 * The single next step the orchestrator must take. The Stop hook feeds this
 * back to the agent, so it has to be concrete.
 */
function nextAction(run: Run, root: string | null = null, config: Config | null = null): string {
  const rid = run.id;
  const work = (name: string) => (root ? path.join(workDir(root, rid), name) : `<work>/${name}`);
  const replied = run.awaiting?.replies.at(-1);
  if (replied && run.awaiting!.kind !== "input") {
    const subject = { plan: "the plan", checkpoint: `checkpoint ${run.awaiting!.cp}`, final: "the finished feature" }[run.awaiting!.kind];
    return (`The engineer replied about ${subject}: "${replied.text.slice(0, 300)}". If they approve it, run ` +
      `\`helix approve ${rid}\`; if they ask for changes, \`helix feedback ${rid} --text '<their words>'\` ` +
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
        `run \`helix approve ${rid}\`; otherwise \`helix feedback ${rid} --text ...\`.${relay}`);
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
  return `${cp.id}: all gates passed. Run \`helix commit ${rid}\`.`;
}

// ---------------------------------------------------------------- validation

/** Decisions the planner raises for the engineer to settle when they review the plan. */
function validateDecisions(input: any): string[] {
  const decisions = input?.decisions ?? [];
  if (!Array.isArray(decisions) || decisions.some((d) => typeof d !== "string" || !d.trim())) {
    throw new HelixError("Checkpoint plan rejected: 'decisions' must be a list of non-empty strings.");
  }
  return decisions.map((d: string) => d.trim());
}

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

/** When the current plan was loaded (runs from older versions only have it in their history). */
function planLoadedAt(run: Run): string {
  return run.plan_loaded_at ?? run.history.findLast((h) => h.event.startsWith("plan loaded"))?.at ?? "";
}

/** Planning restarts when the engineer gave feedback on the plan after it was loaded. */
const revisingPlan = (run: Run) => (run.plan_feedback?.at(-1)?.at ?? "") > planLoadedAt(run);

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
        required: ["severity", "file", "line", "rule", "problem", "required_fix", "repeats"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: "string" },
          line: { type: "integer" },
          rule: { type: "string" },
          problem: { type: "string" },
          required_fix: { type: "string" },
          repeats: { type: "string" },
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
interface CodeFinding {
  severity: string; file: string; line: number; rule: string; problem: string; required_fix: string;
  /** Id of the reviewer's earlier finding this one raises again, or "" for a new finding. */
  repeats: string;
}
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
    // The prompt goes on stdin: `-i` takes every following argument as an image.
    cmd = ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
      "--output-schema", schemaFile, "-o", lastMessage, "-C", root];
    if (spec.model) cmd.push("-m", spec.model);
    for (const image of images) cmd.push("-i", image);
    input = prompt;
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
  const missing = new Set<string>();
  const text = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key in values) return values[key];
    missing.add(match);
    return match;
  });
  if (missing.size) throw new HelixError(`Prompt template has unfilled placeholders: ${[...missing].join(", ")}`);
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
  const backends = new Set([config.reviewers?.ui, ...(config.reviewers?.code ?? [])].map((r) => r?.backend ?? "claude"));
  for (const backend of backends) {
    if (backend !== "exec" && !Bun.which(backend)) {
      console.log(`\nWARNING: reviewers use the '${backend}' CLI, which is not installed. The UI and review gates will ` +
        `error until it is, or until config.reviewers points at an installed backend (${configPath(root)}).`);
    }
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
  const busy = allRunIds(root).find((rid) => loadRun(root, rid).status !== "done");
  if (busy) {
    throw new HelixError(`Run '${busy}' is still in progress in this worktree. Gates fingerprint the whole working ` +
      "tree, so a second run here would mix its changes into the first. Start the new run in its own worktree " +
      `(\`git worktree add\`), or finish '${busy}' first.`);
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

function cmdTests(args: Args) {
  const root = repoRoot();
  let data = readRunInput(root, args._[0], args.file);
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
  const decisions = run.plan_decisions ?? [];
  if (decisions.length) {
    console.log(`Ask the engineer to settle these decisions too:\n${bullet(decisions)}\nAn approval settles each ` +
      "one as recommended unless they say otherwise. If they decide otherwise, record it as plan feedback " +
      "(`helix feedback`), so the plan and its test cases follow.");
  }
  console.log(`STOP now and ask the engineer to review the plan in the viewer.${relayHint(run)}`);
}

function requireHumanReply(run: Run, kinds: Awaiting["kind"][]): Awaiting {
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

/** What to do when an engineer message did not reach Helix. */
const NO_HOOK_HINT = (rid: string) =>
  "If they already replied, no prompt hook recorded it: arm the hooks (see the skill's \"Hooks\" section), or " +
  `relay their message word for word with \`helix reply ${rid} --text "<their exact words>"\`.`;

/** The engineer's message reached Helix: through the prompt hook, or relayed by the agent. */
function recordReply(run: Run, text: string, via: ReplyChannel) {
  const reply: Reply = { at: now(), text, via };
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

const lastReply = (awaiting: Awaiting) => awaiting.replies.at(-1)!;

function cmdApprove(args: Args) {
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
      const cp = cpById(run, awaiting.cp!);
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

function cmdFeedback(args: Args) {
  const root = repoRoot();
  const { run, result: { kind, target } } = transaction(root, args._[0], (run) => {
    const awaiting = requireHumanReply(run, ["plan", "checkpoint", "final"]);
    const reply = lastReply(awaiting).text;
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

function noteGate(run: Run, cp: Checkpoint, gate: Gate, record: GateRecord) {
  cp.gates[gate] = record;
  logAttempt(cp, gate, record.status, record.attempt);
  const outcome = { passed: "passed", failed: "sent back", invalid: "screenshots mismatched", error: "reviewer error" };
  run.history.push({ at: now(), event: `${cp.id} ${GATE_NAME[gate]}: ${outcome[record.status]} (attempt ${record.attempt})` });
}

function recordGate(root: string, runId: string, gate: Gate, record: GateRecord) {
  return transaction(root, runId, (run) => noteGate(run, requireCurrent(run), gate, record)).run;
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
  const fpAfter = fingerprint(root);
  let status: GateRecord["status"] = "passed";
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
  const changed = git(root, ["diff", "--name-only", cp.base!, fp]).split("\n").filter(Boolean);
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "code-reviewer.md"), "utf8");
  const results: ReviewResult[] = await Promise.all(reviewers.map(async (spec, index) => {
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
      EARLIER: earlierFindings(cp, n),
    });
    const name = `reviewer ${n} (${spec.backend ?? "claude"}, ${spec.lens ?? "general"})`;
    const who = { name, backend: spec.backend ?? "claude", lens: spec.lens ?? "general" };
    try {
      const verdict = await runReviewer<CodeVerdict>(spec, prompt, CODE_SCHEMA, [], root,
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
  const treeChanged = fingerprint(root) !== fp;
  const report = path.join(outDir, "findings.md");
  const { run, result: { status, text } } = transaction(root, runId, (run) => {
    const cp = requireCurrent(run);
    // Findings about a tree that changed under the reviewers say nothing about the current one.
    const outcome = treeChanged ? results.map(() => ({ raised: [] as string[], ignored: [] as string[] }))
      : trackFindings(cp, attempt, results);
    const blocking = outcome.some((o) => o.raised.length);
    const errored = treeChanged || results.some((r) => r.error);
    const status: GateRecord["status"] = blocking ? "failed" : errored ? "error" : "passed";
    const lines = results.map(({ name, verdict, error }, i) => {
      const verdictText = error ? "ERROR" : outcome[i].raised.length ? "CHANGES REQUESTED" : "APPROVE";
      return `### ${name}: ${verdictText}\n${error ?? verdict!.summary}`;
    });
    const sections = [`## Reviewers\n\n${lines.join("\n\n")}`];
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
      logAttempt(cp, "human", "passed");
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
  const evidence = requiredGates(cp, config).filter((g) => g !== "human").map((g) => gateLine(cp, g, cp.gates[g]!));
  console.log(`${cp.id} is ready for the engineer. Viewer: ${path.join(runDir(root, run.id), "viewer.html")}`);
  console.log(`Evidence:\n${evidence.join("\n")}`);
  console.log("STOP now. Tell the engineer what the checkpoint does, where to see it running, and the evidence " +
    `above, including anything the subagents changed beyond what was asked. Wait for approval or feedback.${relayHint(run)}`);
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
    writeJson(path.join(evidence, "summary.json"), { checkpoint: cp.title, gates: summary, findings: cp.findings ?? [] });
    cp.status = "committed";
    cp.committed_at = now();
    cp.tree = fp;
    const sections = [`helix(${run.id}): ${cp.id} ${cp.title}`, cp.summary,
      `Gates:\n${gates.map((g) => gateLine(cp, g, cp.gates[g]!)).join("\n")}`];
    if (cp.feedback.length) sections.push(`Engineer feedback:\n${bullet(cp.feedback.map((f) => `"${oneLine(f.text)}"`))}`);
    const rulings = (cp.findings ?? []).filter((f) => f.ruling);
    if (rulings.length) {
      sections.push(`Engineer rulings on review findings:\n${bullet(rulings.map((f) =>
        `${f.id} ${f.ruling!.decision === "fix" ? "must be fixed" : "dropped"} ("${oneLine(f.problem)}"): "${oneLine(f.ruling!.text)}"`))}`);
    }
    const message = `${sections.join("\n\n")}\n`;
    const parent = head(root);
    git(root, ["add", "-A"]);
    const trailers = ((args.trailer as string[] | undefined) ?? []).flatMap((t) => ["--trailer", t]);
    git(root, ["commit", "-q", "-m", message, ...trailers]);
    if (git(root, ["rev-parse", "HEAD^{tree}"]) !== fp) {
      git(root, ["reset", "-q", "--soft", parent!]);
      throw new HelixError("A git commit hook changed the files being committed, so the commit no longer matches " +
        "the tree the gates passed. The commit was undone and the hook's changes are kept in the working tree: " +
        "run the gates again on them, then commit.");
    }
    cp.commit = head(root);
    fs.cpSync(evidence, path.join(sharedDir(root), "evidence", cp.commit!), { recursive: true });
    run.history.push({ at: now(), event: `${cp.id} committed ${cp.commit!.slice(0, 10)}` });
    advance(root, run);
    return cp;
  });
  console.log(`Committed ${cp.id} as ${cp.commit!.slice(0, 10)}.`);
  console.log("Next:", nextAction(run, root, config));
}

/** A passed gate for the engineer and the commit message: how often it sent the work back, and what it proved. */
function gateLine(cp: Checkpoint, gate: Gate, record: GateRecord): string {
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

/** What a passed gate proved, in a few words. */
function gateEvidence(cp: Checkpoint, gate: Gate, record: GateRecord): string {
  if (gate === "behavior") return `: ${plural(cp.tests.length, "planned case")} via \`${record.command}\``;
  if (gate === "ui") {
    const pairs = (record.details as { pairs?: unknown[] } | undefined)?.pairs?.length ?? 0;
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

function cmdAdd(args: Args) {
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

function cmdAutonomy(args: Args) {
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
 */
function cmdRule(args: Args) {
  const root = repoRoot();
  const [runId, rawId, decision] = args._ as [string, string, Ruling["decision"]];
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
    f.ruling = { decision, text, at: now(), attempt: cp.attempts.review ?? 0, via: said.via };
    if (decision === "drop") f.status = "dropped";
    run.history.push({ at: now(), event: `${cp.id} ${id}: the engineer ruled it ${decision === "fix" ? "must be fixed" : "wrong"}`, reply: said.text });
  });
  if (args.learning) appendLearning(root, args.learning, `${run.id} ${id}`);
  console.log(`${id}: ${decision === "fix" ? "must be fixed" : "dropped"}.${args.learning ? " Learning saved." : ""}`);
  console.log("Next:", nextAction(run, root));
}

function cmdFindings(args: Args) {
  const root = repoRoot();
  const run = loadRun(root, args._[0]);
  const cp = requireCurrent(run);
  const findings = cp.findings ?? [];
  if (!findings.length) {
    console.log(`${cp.id} has no tracked review findings.`);
    return;
  }
  for (const status of ["open", "dropped", "resolved"] as const) {
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
 */
function cmdReply(args: Args) {
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
 */
function cmdClaim(args: Args) {
  const root = repoRoot();
  const { run } = transaction(root, args._[0], (run) => {
    run.owner_session = sessionId();
    run.history.push({ at: now(), event: run.owner_session ? "claimed by a new session" : "released for the next session" });
  }, false);
  console.log(run.owner_session ? `Run claimed by session ${run.owner_session}.`
    : "Run released: the next message the engineer sends in this session claims it.");
  console.log("Next:", nextAction(run, root));
}

/** A question asking the engineer to rule on review findings, quoting each one and the fixer's answer. */
function rulingQuestion(cp: Checkpoint, ids: string[]): string {
  const parts = ids.map((raw) => {
    const id = raw.trim().toUpperCase();
    const f = (cp.findings ?? []).find((x) => x.id === id && x.status === "open");
    if (!f) throw new HelixError(`${cp.id} has no open review finding ${id}.`);
    const answer = f.responses.at(-1);
    const fixer = answer
      ? ` The fixer ${answer.status === "disputed" ? "disputes it" : "says it fixed it"}${answer.note ? `: "${oneLine(answer.note)}"` : ""}.`
      : "";
    return `${f.id} (${f.lens} reviewer, ${f.file}:${f.line}, raised ${f.raised.length}x): "${oneLine(f.problem)}" ` +
      `Required fix: "${oneLine(f.required_fix)}".${fixer}`;
  });
  return `The code reviewers and the fixer disagree. ${parts.join(" ")} For each: is the finding right (fix it) ` +
    "or wrong (drop it)?";
}

function cmdAsk(args: Args) {
  const root = repoRoot();
  const findings = (args.finding as string[] | undefined) ?? [];
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

const BRIEF_ROLES = ["planner", "test-planner", "test-writer", "implementer", "fixer"] as const;
type BriefRole = (typeof BRIEF_ROLES)[number];
const BRIEF_TEMPLATE: Record<BriefRole, string> = {
  planner: "checkpoint-planner.md", "test-planner": "test-planner.md", "test-writer": "test-writer.md",
  implementer: "implementer.md", fixer: "fixer.md",
};

function describeCheckpoint(cp: Checkpoint): string {
  return [
    `### ${cp.id}: ${cp.title}`,
    cp.summary,
    `Done when:\n${bullet(cp.done_when)}`,
    cp.ui ? `UI compared by the visual reviewer: ${cp.ui_scope}` : "Logic only (no UI review).",
    `Reference files:\n${bullet(cp.reference)}`,
  ].join("\n\n");
}

/** What the fixer must resolve: unaddressed engineer feedback, else the first failed gate's evidence. */
function fixerEvidence(root: string, run: Run, cp: Checkpoint, config: Config): string {
  const fp = fingerprint(root);
  if (cp.feedback_fingerprint === fp) {
    return `Engineer feedback on this checkpoint (their words):\n\n> ${cp.feedback.at(-1)!.text}`;
  }
  for (const gate of requiredGates(cp, config)) {
    const state = gateState(cp, gate, fp);
    if (state === "passed") continue;
    const record = cp.gates[gate];
    if (state !== "failed" || !record?.evidence || record.fingerprint !== fp) break;
    const file = path.resolve(root, record.evidence);
    if (gate === "review" && cp.findings) return reviewEvidence(root, run, cp, file, record.attempt!);
    const label = { behavior: "Behavior log", ui: "UI review report", review: "Adversarial review findings", human: "" }[gate];
    const extra = gate === "ui"
      ? "\n\nThe screenshots the reviewer compared are next to the report (pair-N-reference / pair-N-implementation)."
      : "";
    return `${label} (attempt ${record.attempt}): ${file}${extra}`;
  }
  throw new HelixError(`${cp.id} has nothing for the fixer to fix right now.\nNext: ${nextAction(run, root, config)}`);
}

/** The open review findings, each to be fixed or disputed, and where the fixer answers them. */
function reviewEvidence(root: string, run: Run, cp: Checkpoint, report: string, attempt: number): string {
  const stuck = openFindings(cp).filter(isStuck);
  if (stuck.length) throw new HelixError(`${cp.id}: ${needsRuling(run.id, stuck)}`);
  const due = sortFindings(openFindings(cp).filter(unanswered));
  if (!due.length) {
    throw new HelixError(`${cp.id}: every review finding is answered or dropped; rerun the review gate.`);
  }
  const answers = [...new Set(due.map((f) => f.raised.at(-1)!))].map((a) => responsePath(root, run.id, cp, a));
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
 */
function cmdBrief(args: Args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const [runId, role] = args._ as [string, BriefRole];
  if (!BRIEF_ROLES.includes(role)) throw new HelixError(`Unknown role '${role}'. Use ${BRIEF_ROLES.join(", ")}.`);
  const run = loadRun(root, runId);
  const work = workDir(root, run.id);
  const testCommand = (cp?: Checkpoint) => cp?.test_command || config.test_command || "(none configured: ask the engineer)";
  const common = [
    `- Repository root: ${root}`,
    `- Goal (the engineer's words): ${run.goal}`,
    `- Reference: ${run.reference}`,
    `- Target: ${run.target || "(not specified)"}`,
    `- Guidelines (the written standard):\n${nested(config.guidelines.map((g) => path.join(root, g)))}`,
    `- Design documents:\n${nested(config.design.map((d) => path.join(root, d)))}`,
    `- Learnings file (engineer rules, apply all of them): ${learningsPath(root)}`,
  ];
  if (run.plan_approval) {
    common.push(`- The engineer's words when approving the plan (where they differ from the goal, they win): ` +
      `"${run.plan_approval}"`);
  }
  const sections: string[] = [];
  let name: string;
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
        `them.\n\nTheir feedback:\n${bullet(run.plan_feedback!.map((f) => f.text))}\n\nCurrent plan:\n\n` +
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
    else if (cp.feedback.length) {
      sections.push(`## Earlier engineer feedback on this checkpoint\n\n${bullet(cp.feedback.map((f) => f.text))}`);
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

function cmdLearn(args: Args) {
  const root = repoRoot();
  loadConfig(root);
  appendLearning(root, args._[0], args.source ?? "engineer");
  console.log(`Saved to ${learningsPath(root)}.`);
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
    console.log(`Run ${rid}: ${run.title}  [${run.accepted_at ? "accepted" : run.status}]  autonomy=${mode ?? "all"}  owner=${run.owner_session || "-"}`);
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

interface HookInstaller {
  file: () => string;
  /** Hook event names in this agent for Helix's stop and prompt hooks. */
  events: { stop: string; prompt: string };
  dialect: HookDialect;
  /** Writes Helix's hooks into the agent's existing config, replacing earlier Helix hooks. */
  merge: (config: any, commands: { stop: string; prompt: string }, events: { stop: string; prompt: string }) => any;
  note: string;
}

const isHelixHook = (command: unknown) => typeof command === "string" && /helix\.ts"? hook (stop|prompt)/.test(command);

/** Claude-style config: {hooks: {Event: [{hooks: [{type, command, ...}]}]}}. */
function mergeGrouped(extra: (kind: "stop" | "prompt") => object) {
  return (config: any, commands: { stop: string; prompt: string }, events: { stop: string; prompt: string }) => {
    config.hooks ??= {};
    for (const kind of ["stop", "prompt"] as const) {
      const groups: any[] = config.hooks[events[kind]] ?? [];
      for (const group of groups) group.hooks = (group.hooks ?? []).filter((hook: any) => !isHelixHook(hook?.command));
      config.hooks[events[kind]] = [
        ...groups.filter((group) => group.hooks.length),
        { hooks: [{ type: "command", command: commands[kind], ...extra(kind) }] },
      ];
    }
    return config;
  };
}

const HOOK_INSTALLERS: Record<string, HookInstaller> = {
  codex: {
    file: () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json"),
    events: { stop: "Stop", prompt: "UserPromptSubmit" },
    dialect: "standard",
    merge: mergeGrouped(() => ({ timeout: 30 })),
    note: "Codex asks you to review and trust new hooks (/hooks) the next time it starts; approve them there.",
  },
  gemini: {
    file: () => path.join(os.homedir(), ".gemini", "settings.json"),
    events: { stop: "AfterAgent", prompt: "BeforeAgent" },
    dialect: "standard",
    merge: mergeGrouped((kind) => ({ name: `helix-${kind}`, timeout: 30_000 })),
    note: "Gemini CLI runs them from its next session.",
  },
  cursor: {
    file: () => path.join(os.homedir(), ".cursor", "hooks.json"),
    events: { stop: "stop", prompt: "beforeSubmitPrompt" },
    dialect: "cursor",
    merge: (config, commands, events) => {
      config.version ??= 1;
      config.hooks ??= {};
      for (const kind of ["stop", "prompt"] as const) {
        const kept = (config.hooks[events[kind]] ?? []).filter((hook: any) => !isHelixHook(hook?.command));
        config.hooks[events[kind]] = [...kept, { command: commands[kind], ...(kind === "stop" ? { loop_limit: null } : {}) }];
      }
      return config;
    },
    note: "Cursor's agent picks them up in new chats. Cursor's prompt hook cannot add context, so the agent " +
      "learns the next action from `helix status` and the stop hook.",
  },
  copilot: {
    file: () => path.join(os.homedir(), ".copilot", "hooks", "helix.json"),
    events: { stop: "Stop", prompt: "UserPromptSubmit" },
    dialect: "standard",
    merge: (_config, commands, events) => ({
      version: 1,
      hooks: {
        [events.stop]: [{ type: "command", bash: commands.stop, timeoutSec: 30 }],
        [events.prompt]: [{ type: "command", bash: commands.prompt, timeoutSec: 30 }],
      },
    }),
    note: "Copilot CLI loads ~/.copilot/hooks/*.json at startup.",
  },
};

/**
 * Installs Helix's Stop and prompt hooks in an agent's user-level hook config,
 * never in the repository, so the working tree stays untouched. The hooks do
 * nothing outside a Helix run.
 */
function cmdHooks(args: Args) {
  const agent = args._[0];
  if (agent === "claude") {
    console.log("Claude Code arms Helix's hooks from SKILL.md whenever the skill runs. Nothing to install.");
    return;
  }
  const installer = HOOK_INSTALLERS[agent];
  if (!installer) {
    throw new HelixError(`No hook installer for '${agent}'. Supported: claude, ${Object.keys(HOOK_INSTALLERS).join(", ")}. ` +
      "Other agents: wire `helix hook stop` and `helix hook prompt` by hand (see the skill's Hooks section), or " +
      "relay the engineer's replies with `helix reply`.");
  }
  const file = installer.file();
  const script = path.join(SKILL_DIR, "scripts", "helix.ts");
  const suffix = installer.dialect === "cursor" ? " cursor" : "";
  const command = (kind: string) => `bun ${JSON.stringify(script)} hook ${kind}${suffix} || true`;
  const existing = fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() ? readJsonInput(file) : {};
  const config = installer.merge(existing, { stop: command("stop"), prompt: command("prompt") }, installer.events);
  writeJson(file, config);
  console.log(`Installed Helix's ${installer.events.stop} and ${installer.events.prompt} hooks in ${file}.`);
  console.log(installer.note);
}

function openFile(file: string) {
  if (process.env.HELIX_NO_OPEN) return;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (Bun.which(opener)) spawnSync(opener, [file], { stdio: "ignore" });
}

// ---------------------------------------------------------------- hooks

/**
 * Hook protocols. Claude Code, Codex, Gemini CLI (BeforeAgent/AfterAgent) and
 * Copilot CLI (Stop/UserPromptSubmit) share one: `session_id`, `cwd` and
 * `prompt` on stdin, `{"decision":"block","reason"}` to keep a turn going and
 * `hookSpecificOutput.additionalContext` to add context. Cursor names the
 * fields differently, continues a turn with `followup_message`, and cannot add
 * context to a prompt.
 */
type HookDialect = "standard" | "cursor";

interface HookEvent { sessionId: string | null; cwd: string; prompt: string; eventName: string }

function readHookEvent(data: any): HookEvent {
  return {
    sessionId: data.session_id ?? data.conversation_id ?? data.sessionId ?? null,
    cwd: data.cwd || data.workspace_roots?.[0] || process.cwd(),
    prompt: String(data.prompt ?? ""),
    eventName: String(data.hook_event_name ?? data.hookEventName ?? ""),
  };
}

function hookContinue(dialect: HookDialect, reason: string) {
  return dialect === "cursor" ? { followup_message: reason } : { decision: "block", reason };
}

/**
 * Entry point for every agent's hooks. Never throws and never exits non-zero:
 * a crashing hook would block the engineer's prompt.
 */
async function hookMain(event: string, dialect: HookDialect) {
  try {
    const hook = readHookEvent(JSON.parse((await Bun.stdin.text()) || "{}"));
    const root = repoRoot(hook.cwd);
    if (!fs.existsSync(runsDir(root))) return;
    const mine = allRunIds(root).filter((rid) => {
      const owner = loadRun(root, rid).owner_session;
      return owner === hook.sessionId || owner === null;
    });
    if (event === "prompt") hookPrompt(root, mine, hook, dialect);
    else if (event === "stop") hookStop(root, mine, dialect);
  } catch (error) {
    try {
      fs.appendFileSync(path.join(sharedDir(repoRoot()), "hook-errors.log"), `${now()} ${event}: ${error}\n`);
    } catch {
      // hooks fail open
    }
  }
}

function hookPrompt(root: string, runIds: string[], hook: HookEvent, dialect: HookDialect) {
  const text = hook.prompt.slice(0, 4000);
  const notes: string[] = [];
  for (const rid of runIds) {
    const { run } = transaction(root, rid, (run) => {
      if (hook.sessionId) run.owner_session = run.hook_session = hook.sessionId;
      run.hooked = true;
      recordReply(run, text, "hook");
    }, false);
    if (run.status !== "done" || run.awaiting) notes.push(`Helix run '${rid}' is ${run.status}. ${nextAction(run)}`);
  }
  if (notes.length && dialect === "standard") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hook.eventName || "UserPromptSubmit",
        additionalContext: `${notes.join("\n")}\nRe-read the helix skill before acting if it is not loaded.`,
      },
    }));
  }
}

function hookStop(root: string, runIds: string[], dialect: HookDialect) {
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
      if (dialect === "standard") {
        console.log(JSON.stringify({
          systemMessage: `Helix run '${rid}' stalled: the agent made no progress across ${MAX_IDENTICAL_STOPS} ` +
            "attempts to stop. Reply to resume it.",
        }));
      }
      return;
    }
    const reason = `Helix run '${rid}' is not finished and no gate lets you stop here. An attempt may be wrong; it ` +
      `may not stop until the gates pass. Next required action: ${nextAction(run, root)}`;
    console.log(JSON.stringify(hookContinue(dialect, reason)));
    return;
  }
}

// ---------------------------------------------------------------- viewer

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Last lines of a text file, for showing a log inline. */
function tail(file: string, lines: number): string {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** The run as the viewer shows it: plain data, paths relative to the viewer. */
function viewModel(root: string, run: Run) {
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
  const rel = (file: string) => path.relative(dir, path.resolve(root, file));
  const detailsFor = (gate: Gate, record: GateRecord | undefined): unknown => {
    if (!record) return null;
    if (gate === "behavior") {
      return { exit: record.exit ?? null, reason: record.reason ?? "", command: record.command ?? "",
        log: record.evidence ? tail(path.resolve(root, record.evidence), 24) : "" };
    }
    if (gate === "ui" && record.details) {
      const { pairs } = record.details as { pairs: { reference: string; implementation: string }[] };
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
 */
function renderViewer(root: string, run: Run) {
  const dir = runDir(root, run.id);
  const data = JSON.stringify(viewModel(root, run)).replaceAll("<", "\\u003c");
  fs.writeFileSync(path.join(dir, "viewer-data.js"), `window.helixUpdate(${data});\n`);
  const template = fs.readFileSync(path.join(SKILL_DIR, "scripts", "viewer.html"), "utf8");
  const page = template
    .replace("{{TITLE}}", () => escapeHtml(run.title))
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
    help: "commit the current checkpoint (all gates must pass on this exact tree)",
    usage: `commit ${RUN} [--trailer 'Key: value']...`,
    positionals: 1, flags: { trailer: "repeat" }, run: cmdCommit,
  },
  add: {
    help: "append checkpoints to an approved run (e.g. from engineer feedback)", usage: `add ${RUN} --file FILE`,
    positionals: 1, flags: { file: "string" }, required: ["file"], run: cmdAdd,
  },
  autonomy: {
    help: "let the next N checkpoints, counting the current one, skip engineer approval (engineer's request only)",
    usage: `autonomy ${RUN} --checkpoints N | --all | --off`,
    positionals: 1, flags: { checkpoints: "string", all: "boolean", off: "boolean" }, run: cmdAutonomy,
  },
  brief: {
    help: "write the complete brief for a subagent role",
    usage: `brief ${RUN} ${BRIEF_ROLES.join("|")} [--checkpoint ID]  (--checkpoint: re-plan one checkpoint's tests)`,
    positionals: 2, flags: { checkpoint: "string" }, run: cmdBrief,
  },
  reply: {
    help: "relay the engineer's message word for word (agents without a prompt hook)",
    usage: `reply ${RUN} --text TEXT`, positionals: 1, flags: { text: "string" }, required: ["text"], run: cmdReply,
  },
  ask: {
    help: "stop to ask the engineer a question (--finding: ask for a ruling on a review finding)",
    usage: `ask ${RUN} [QUESTION] [--finding ID]...`, positionals: 1, optionalPositionals: 1,
    flags: { finding: "repeat" }, run: cmdAsk,
  },
  waive: {
    help: "waive the current checkpoint's UI gate (engineer's ruling only)", usage: `waive ${RUN} ui --reason TEXT`,
    positionals: 2, flags: { reason: "string" }, required: ["reason"], run: cmdWaive,
  },
  findings: {
    help: "list the current checkpoint's review findings with the fixer's answers and rulings",
    usage: `findings ${RUN}`, positionals: 1, run: cmdFindings,
  },
  rule: {
    help: "record the engineer's ruling on a review finding (fix: it must be fixed, drop: it is wrong)",
    usage: `rule ${RUN} FINDING fix|drop --text TEXT [--learning TEXT]`,
    positionals: 3, flags: { text: "string", learning: "string" }, required: ["text"], run: cmdRule,
  },
  claim: {
    help: "take over a run after resuming in a new session", usage: `claim ${RUN}`, positionals: 1, run: cmdClaim,
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
    help: "install Helix's hooks for an agent (Claude Code needs none)",
    usage: `hooks claude|${Object.keys(HOOK_INSTALLERS).join("|")}`,
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
    "  hook stop|prompt [cursor]  hook entry point (stdin: the agent's hook event)";
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
    await hookMain(rest[0], rest[1] === "cursor" ? "cursor" : "standard");
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
