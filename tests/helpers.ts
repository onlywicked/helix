// Shared setup for the end-to-end tests of the Helix CLI: real git repos, real
// subprocesses, fake reviewers through the `exec` backend, and simulated hook
// events. Each test file runs in its own process (`node --test`).

import { expect } from "expect";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "node:test";
import { deflateSync } from "node:zlib";

export const HELIX = path.resolve(import.meta.dirname, "..", "scripts", "helix.mjs");
export const SESSION = "session-under-test";

export const FAKE_REVIEWER = `
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const kind = readFileSync(process.env.HELIX_SCHEMA_FILE, "utf8").includes("invalid_reason") ? "ui" : "code";
const verdicts = JSON.parse(readFileSync(process.env.FAKE_VERDICTS, "utf8"))[kind];
if (kind === "code") {
  const lens = prompt.split("## Lenses")[0].includes("**architecture**") ? "architecture" : "correctness";
  console.log(JSON.stringify(verdicts[lens]));
} else {
  console.log(JSON.stringify(verdicts));
}
`;

export const APPROVE = { verdict: "approve", summary: "Looks right.", findings: [] };
export const REJECT = {
  verdict: "changes_requested", summary: "Layering broken.", findings: [{
    severity: "major", file: "app.py", line: 1, rule: "architecture.md#layers",
    problem: "UI calls storage directly", required_fix: "go through the service", repeats: "",
  }],
};
export const UI_PASS = { verdict: "PASS", invalid_reason: "", findings: [], out_of_scope_notes: [] };
export const UI_FAIL = {
  verdict: "FAIL", invalid_reason: "", out_of_scope_notes: [], findings: [{
    severity: "major", location: "top", element: "title", expected: "20pt", actual: "16pt",
    estimated_difference: "20% smaller", fixable_in_code: true,
  }],
};
export const UI_INVALID = { verdict: "INVALID", invalid_reason: "reference shows a fulfilled order", findings: [], out_of_scope_notes: [] };

export function png(file: string, w: number, h: number) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xff)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

export let root: string;
export let scratch: string;
export let verdicts: string;

export function run(command: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return spawnSync(command[0], command.slice(1), { cwd: opts.cwd, env: opts.env, input: opts.input ?? "", encoding: "utf8" });
}

export function git(...args: string[]) {
  const proc = run(["git", ...args], { cwd: root });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`);
  return proc.stdout;
}

export function env(session = SESSION) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX)/.test(k)));
  return { ...clean, CLAUDE_CODE_SESSION_ID: session, FAKE_VERDICTS: verdicts, HELIX_NO_OPEN: "1" };
}

export function helix(args: string[], expectCode = 0, session = SESSION): string {
  const proc = run(["node", HELIX, ...args], { cwd: root, env: env(session) });
  if (proc.status !== expectCode) {
    throw new Error(`helix ${args.join(" ")} exited ${proc.status}, expected ${expectCode}\n` +
      `stdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  }
  return proc.stdout + proc.stderr;
}

export function hook(event: string, payload: unknown, cwd = root, input = JSON.stringify(payload)) {
  const proc = run(["node", HELIX, "hook", event], { cwd, input, env: env() });
  expect(proc.status).toBe(0);
  return proc.stdout.trim() ? JSON.parse(proc.stdout) : null;
}

export const reply = (text: string, session = SESSION) => hook("prompt", { session_id: session, cwd: root, prompt: text });
export const stop = (session = SESSION) => hook("stop", { session_id: session, cwd: root, stop_hook_active: false });

export function setVerdicts(update: { ui?: unknown; architecture?: unknown; correctness?: unknown }) {
  const current = fs.existsSync(verdicts) ? JSON.parse(fs.readFileSync(verdicts, "utf8")) : { ui: null, code: {} };
  if (update.ui) current.ui = update.ui;
  if (update.architecture) current.code.architecture = update.architecture;
  if (update.correctness) current.code.correctness = update.correctness;
  fs.writeFileSync(verdicts, JSON.stringify(current));
}

export const state = (run = "order") => JSON.parse(fs.readFileSync(path.join(root, ".git/helix/runs", run, "state.json"), "utf8"));
export const write = (file: string, text: string) => fs.writeFileSync(path.join(root, file), text);

export function input(name: string, data: unknown) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

export function plan({ ui = true, count = 2 } = {}) {
  const checkpoints = Array.from({ length: count }, (_, i) => ({
    title: `Step ${i + 1}`, summary: `Build step ${i + 1}.`, done_when: [`step ${i + 1} works`],
    ui: ui && i === 0, ui_scope: ui && i === 0 ? "title only" : "",
  }));
  helix(["new", "order", "--goal", "Order screen", "--reference", "legacy/Order.tsx"]);
  helix(["plan", "order", "--file", input("cps.json", { checkpoints })]);
  const tests = Object.fromEntries(checkpoints.map((_, i) => [`cp-${i + 1}`, [{ name: "works", given: "a", when: "b", then: "c" }]]));
  helix(["tests", "order", "--file", input("tests.json", { checkpoints: tests })]);
}

export function approvedPlan(opts?: { ui?: boolean; count?: number }) {
  plan(opts);
  helix(["submit-plan", "order", "--no-open"]);
  reply("looks good, approve");
  helix(["approve", "order"]);
}

export function screenshots(): [string, string] {
  const ref = path.join(scratch, "ref.png");
  const impl = path.join(scratch, "impl.png");
  png(ref, 10, 20);
  png(impl, 20, 40);
  return [ref, impl];
}

/** The fixer's answers to one review attempt, written where its brief says. */
export function answer(attempt: number, responses: { id: string; status: string; note?: string }[]) {
  const file = path.join(root, `.git/helix/runs/order/work/fixes/cp-1-review-${String(attempt).padStart(3, "0")}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ responses }));
}

/** A reviewer verdict raising one finding; `repeats` names the earlier finding it raises again. */
export const finding = (problem: string, repeats = "", line = 1) => ({
  verdict: "changes_requested", summary: "Not yet.", findings: [{
    severity: "major", file: "app.py", line, rule: "architecture.md#layers", problem, required_fix: "go through the service", repeats,
  }],
});

/** Behavior and UI gates on the current tree, ready for a review. */
export function gatesBeforeReview() {
  helix(["gate", "behavior", "order"]);
  const [ref, impl] = screenshots();
  helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
}

export const reviewerPrompt = (attempt: number, reviewer: number) => fs.readFileSync(path.join(root,
  `.git/helix/runs/order/evidence/cp-1/review-${String(attempt).padStart(3, "0")}/reviewer-${reviewer}.prompt.md`), "utf8");

export const fixerBrief = () => fs.readFileSync(helix(["brief", "order", "fixer"]).match(/Brief: (.+)/)![1], "utf8");

export function passAllGates() {
  write("app.py", "VALUE = 2\n");
  helix(["gate", "behavior", "order"]);
  if (state().current === "cp-1") {
    const [ref, impl] = screenshots();
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded order"]);
  }
  helix(["gate", "review", "order"]);
}

/** Every test gets a fresh repository with Helix initialized and fake reviewers that approve. */
export function useRepo() {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-repo-"));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "helix-scratch-"));
    verdicts = path.join(scratch, "verdicts.json");
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Tester");
    fs.mkdirSync(path.join(root, "docs"));
    write("docs/architecture.md", "# Layers\nUI -> service -> storage\n");
    write("app.py", "VALUE = 1\n");
    write("test.sh", "#!/bin/sh\ngrep -q 'VALUE = 2' app.py\n");
    write("fake_reviewer.mjs", FAKE_REVIEWER);
    setVerdicts({ ui: UI_PASS, architecture: APPROVE, correctness: APPROVE });
    helix(["init", "--test-command", "sh test.sh", "--guideline", "docs/architecture.md"]);
    const configFile = path.join(root, ".helix/config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const fake = { backend: "exec", command: ["node", "fake_reviewer.mjs"] };
    config.reviewers = { ui: fake, code: [{ ...fake, lens: "architecture" }, { ...fake, lens: "correctness" }], timeout_seconds: 60 };
    fs.writeFileSync(configFile, JSON.stringify(config));
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
}

/** Points the helpers at another checkout, such as a teammate's clone. */
export function useRoot(dir: string) {
  root = dir;
}
