// Types of Helix's state, config and reviewer verdicts. Only the type checker
// reads this file (`npm run typecheck`); the CLI itself is plain JavaScript and
// imports these through JSDoc: /** @import { Run } from "./types.js" */

// Run statuses. The Stop hook keeps the agent working while a run it owns is
// in an ACTIVE status; every other status is a legitimate place to stop.
export type Status =
  | "planning" | "building" | "awaiting_plan_approval" | "awaiting_approval" | "awaiting_input"
  | "paused" | "stalled" | "done";
export type Gate = "behavior" | "ui" | "review" | "human";
export type GateState = "passed" | "stale" | "failed" | "invalid" | "error" | "pending";

export interface ReviewerSpec {
  backend?: "claude" | "codex" | "exec";
  model?: string;
  lens?: string;
  command?: string | string[];
}

export interface Config {
  test_command: string;
  test_timeout_seconds: number;
  guidelines: string[];
  design: string[];
  ui: { enabled: boolean; capture_notes: string };
  /** `matcher` decides which new review findings repeat earlier ones. */
  reviewers: { ui: ReviewerSpec; code: ReviewerSpec[]; matcher: ReviewerSpec; timeout_seconds: number };
}

export interface GateRecord {
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
export interface Attempt { gate: Gate; attempt: number; status: GateRecord["status"] | "changes_requested" | "waived"; at: string }

/** The fixer's answer to one finding of one review attempt. */
export interface FixerResponse { attempt: number; status: "fixed" | "disputed"; note: string }

/** The engineer settles a finding: it must be fixed, or it is wrong and never blocks again. */
export interface Ruling { decision: "fix" | "drop"; text: string; at: string; attempt: number; via?: ReplyChannel }

/**
 * A code review finding, tracked under one id for the whole checkpoint so a
 * finding raised again keeps its id, and repeats and disputes are visible.
 */
export interface TrackedFinding {
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
  /** The problem fixed in an earlier checkpoint that this finding raises again, as "cp-1 F3". */
  recurs?: string;
  responses: FixerResponse[];
  ruling?: Ruling;
}

export interface TestCase { id: string; kind: "happy" | "edge" | "error"; name: string; given: string; when: string; then: string }
export interface Feedback { at: string; text: string; reply: string }

export interface CheckpointSpec {
  title: string;
  summary: string;
  done_when: string[];
  ui: boolean;
  ui_scope: string;
  reference: string[];
  test_command: string;
}

export interface Checkpoint extends CheckpointSpec {
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

export type ReplyChannel = "hook" | "relay";
export interface Reply { at: string; text: string; via?: ReplyChannel }
export interface Awaiting {
  kind: "plan" | "checkpoint" | "input" | "final";
  since: string;
  replies: Reply[];
  fingerprint?: string | null;
  cp?: string;
  resume?: Status;
  question?: string;
}

export interface Run {
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

export interface UiFinding {
  severity: string; location: string; element: string; expected: string; actual: string;
  estimated_difference: string; fixable_in_code: boolean;
}
export interface UiVerdict { verdict: "PASS" | "FAIL" | "INVALID"; invalid_reason: string; findings: UiFinding[]; out_of_scope_notes: string[] }
export interface CodeFinding {
  severity: string; file: string; line: number; rule: string; problem: string; required_fix: string;
  /** Id of the reviewer's earlier finding this one raises again, or "" for a new finding. */
  repeats: string;
  /** Set by the finding matcher: the problem fixed in an earlier checkpoint that this one raises again. */
  recurs?: string;
}
export interface CodeVerdict { verdict: "approve" | "changes_requested"; summary: string; findings: CodeFinding[] }
export interface MatchVerdict { matches: { finding: string; repeats: string; recurs: string }[] }
export interface ReviewResult { name: string; backend: string; lens: string; verdict: CodeVerdict | null; error: string | null }

export type ProcessResult =
  | { missing: true }
  | { missing: false; stdout: string; stderr: string; code: number | string | null; timedOut: boolean };

export interface Repo { root: string; gitDir: string; commonDir: string; index: string }

/** Parsed command line: positionals in `_`, then one key per flag. */
export interface Args { _: string[]; [flag: string]: any }

export interface CommandSpec {
  help: string;
  usage: string;
  positionals: number;
  optionalPositionals?: number;
  flags?: Record<string, "string" | "boolean" | "repeat" | "triple">;
  required?: string[];
  run: (args: Args) => void | Promise<void>;
}

/**
 * Hook protocols. Claude Code, Codex, Gemini CLI (BeforeAgent/AfterAgent) and
 * Copilot CLI (Stop/UserPromptSubmit) share one: `session_id`, `cwd` and
 * `prompt` on stdin, `{"decision":"block","reason"}` to keep a turn going and
 * `hookSpecificOutput.additionalContext` to add context. Cursor names the
 * fields differently, continues a turn with `followup_message`, and cannot add
 * context to a prompt.
 */
export type HookDialect = "standard" | "cursor";
export interface HookEvent { sessionId: string | null; cwd: string; prompt: string; eventName: string }
export interface HookCommands { stop: string; prompt: string }
export interface HookInstaller {
  file: () => string;
  /** Hook event names in this agent for Helix's stop and prompt hooks. */
  events: HookCommands;
  dialect: HookDialect;
  /** Writes Helix's hooks into the agent's existing config, replacing earlier Helix hooks. */
  merge: (config: any, commands: HookCommands, events: HookCommands) => any;
  note: string;
}
