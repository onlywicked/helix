// End-to-end tests for the Helix CLI: real git repos, real subprocesses, fake
// reviewers through the `exec` backend, and simulated hook events.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";

const HELIX = path.resolve(import.meta.dir, "..", "scripts", "helix.ts");
const SESSION = "session-under-test";

const FAKE_REVIEWER = `
const prompt = await Bun.stdin.text();
const kind = (await Bun.file(process.env.HELIX_SCHEMA_FILE).text()).includes("invalid_reason") ? "ui" : "code";
const verdicts = JSON.parse(await Bun.file(process.env.FAKE_VERDICTS).text())[kind];
if (kind === "code") {
  const lens = prompt.split("## Lenses")[0].includes("**architecture**") ? "architecture" : "correctness";
  console.log(JSON.stringify(verdicts[lens]));
} else {
  console.log(JSON.stringify(verdicts));
}
`;

const APPROVE = { verdict: "approve", summary: "Looks right.", findings: [] };
const REJECT = {
  verdict: "changes_requested", summary: "Layering broken.", findings: [{
    severity: "major", file: "app.py", line: 1, rule: "architecture.md#layers",
    problem: "UI calls storage directly", required_fix: "go through the service", repeats: "",
  }],
};
const UI_PASS = { verdict: "PASS", invalid_reason: "", findings: [], out_of_scope_notes: [] };
const UI_FAIL = {
  verdict: "FAIL", invalid_reason: "", out_of_scope_notes: [], findings: [{
    severity: "major", location: "top", element: "title", expected: "20pt", actual: "16pt",
    estimated_difference: "20% smaller", fixable_in_code: true,
  }],
};
const UI_INVALID = { verdict: "INVALID", invalid_reason: "reference shows a fulfilled order", findings: [], out_of_scope_notes: [] };

function png(file: string, w: number, h: number) {
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

let root: string;
let scratch: string;
let verdicts: string;

function git(...args: string[]) {
  const proc = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`);
  return proc.stdout;
}

function env(session = SESSION) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX)/.test(k)));
  return { ...clean, CLAUDE_CODE_SESSION_ID: session, FAKE_VERDICTS: verdicts, HELIX_NO_OPEN: "1" };
}

function helix(args: string[], expectCode = 0, session = SESSION): string {
  const proc = spawnSync("bun", [HELIX, ...args], { cwd: root, encoding: "utf8", env: env(session) });
  if (proc.status !== expectCode) {
    throw new Error(`helix ${args.join(" ")} exited ${proc.status}, expected ${expectCode}\n` +
      `stdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  }
  return proc.stdout + proc.stderr;
}

function hook(event: string, payload: unknown, cwd = root, input = JSON.stringify(payload)) {
  const proc = spawnSync("bun", [HELIX, "hook", event], { cwd, encoding: "utf8", input, env: env() });
  expect(proc.status).toBe(0);
  return proc.stdout.trim() ? JSON.parse(proc.stdout) : null;
}

const reply = (text: string, session = SESSION) => hook("prompt", { session_id: session, cwd: root, prompt: text });
const stop = (session = SESSION) => hook("stop", { session_id: session, cwd: root, stop_hook_active: false });

function setVerdicts(update: { ui?: unknown; architecture?: unknown; correctness?: unknown }) {
  const current = fs.existsSync(verdicts) ? JSON.parse(fs.readFileSync(verdicts, "utf8")) : { ui: null, code: {} };
  if (update.ui) current.ui = update.ui;
  if (update.architecture) current.code.architecture = update.architecture;
  if (update.correctness) current.code.correctness = update.correctness;
  fs.writeFileSync(verdicts, JSON.stringify(current));
}

const state = (run = "order") => JSON.parse(fs.readFileSync(path.join(root, ".git/helix/runs", run, "state.json"), "utf8"));
const write = (file: string, text: string) => fs.writeFileSync(path.join(root, file), text);

function input(name: string, data: unknown) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

function plan({ ui = true, count = 2 } = {}) {
  const checkpoints = Array.from({ length: count }, (_, i) => ({
    title: `Step ${i + 1}`, summary: `Build step ${i + 1}.`, done_when: [`step ${i + 1} works`],
    ui: ui && i === 0, ui_scope: ui && i === 0 ? "title only" : "",
  }));
  helix(["new", "order", "--goal", "Order screen", "--reference", "legacy/Order.tsx"]);
  helix(["plan", "order", "--file", input("cps.json", { checkpoints })]);
  const tests = Object.fromEntries(checkpoints.map((_, i) => [`cp-${i + 1}`, [{ name: "works", given: "a", when: "b", then: "c" }]]));
  helix(["tests", "order", "--file", input("tests.json", { checkpoints: tests })]);
}

function approvedPlan(opts?: { ui?: boolean; count?: number }) {
  plan(opts);
  helix(["submit-plan", "order", "--no-open"]);
  reply("looks good, approve");
  helix(["approve", "order"]);
}

function screenshots(): [string, string] {
  const ref = path.join(scratch, "ref.png");
  const impl = path.join(scratch, "impl.png");
  png(ref, 10, 20);
  png(impl, 20, 40);
  return [ref, impl];
}

/** The fixer's answers to one review attempt, written where its brief says. */
function answer(attempt: number, responses: { id: string; status: string; note?: string }[]) {
  const file = path.join(root, `.git/helix/runs/order/work/fixes/cp-1-review-${String(attempt).padStart(3, "0")}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ responses }));
}

/** A reviewer verdict raising one finding; `repeats` names the earlier finding it raises again. */
const finding = (problem: string, repeats = "", line = 1) => ({
  verdict: "changes_requested", summary: "Not yet.", findings: [{
    severity: "major", file: "app.py", line, rule: "architecture.md#layers", problem, required_fix: "go through the service", repeats,
  }],
});

/** Behavior and UI gates on the current tree, ready for a review. */
function gatesBeforeReview() {
  helix(["gate", "behavior", "order"]);
  const [ref, impl] = screenshots();
  helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
}

const reviewerPrompt = (attempt: number, reviewer: number) => fs.readFileSync(path.join(root,
  `.git/helix/runs/order/evidence/cp-1/review-${String(attempt).padStart(3, "0")}/reviewer-${reviewer}.prompt.md`), "utf8");

const fixerBrief = () => fs.readFileSync(helix(["brief", "order", "fixer"]).match(/Brief: (.+)/)![1], "utf8");

function passAllGates() {
  write("app.py", "VALUE = 2\n");
  helix(["gate", "behavior", "order"]);
  if (state().current === "cp-1") {
    const [ref, impl] = screenshots();
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded order"]);
  }
  helix(["gate", "review", "order"]);
}

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
  write("fake_reviewer.ts", FAKE_REVIEWER);
  setVerdicts({ ui: UI_PASS, architecture: APPROVE, correctness: APPROVE });
  helix(["init", "--test-command", "sh test.sh", "--guideline", "docs/architecture.md"]);
  const configFile = path.join(root, ".helix/config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const fake = { backend: "exec", command: ["bun", "fake_reviewer.ts"] };
  config.reviewers = { ui: fake, code: [{ ...fake, lens: "architecture" }, { ...fake, lens: "correctness" }], timeout_seconds: 60 };
  fs.writeFileSync(configFile, JSON.stringify(config));
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("planning", () => {
  test("rejects wordy checkpoint titles and missing ui_scope", () => {
    helix(["new", "order", "--goal", "g", "--reference", "r"]);
    const bad = { checkpoints: [{ title: "one two three four five six seven eight nine", summary: "s", done_when: ["x"], ui: true }] };
    const out = helix(["plan", "order", "--file", input("bad.json", bad)], 1);
    expect(out).toContain("max 8");
    expect(out).toContain("ui_scope");
  });

  test("rejects happy-path-only test plans", () => {
    helix(["new", "order", "--goal", "g", "--reference", "r"]);
    helix(["plan", "order", "--file", input("cps.json", { checkpoints: [{ title: "Skeleton", summary: "s", done_when: ["x"], ui: false }] })]);
    const cases = [0, 1, 2].map((i) => ({ name: `c${i}`, given: "a", when: "b", then: "c" }));
    expect(helix(["tests", "order", "--file", input("t.json", { checkpoints: { "cp-1": cases } })], 1)).toContain("edge and error");
  });

  test("the planner's decisions reach the engineer with the plan", () => {
    helix(["new", "order", "--goal", "g", "--reference", "r"]);
    const cps = { checkpoints: [{ title: "Skeleton", summary: "s", done_when: ["x"], ui: false }],
      decisions: ["The reference rounds half down; keep that?"] };
    expect(helix(["plan", "order", "--file", input("cps.json", cps)])).toContain("rounds half down");
    const brief = fs.readFileSync(helix(["brief", "order", "test-planner"]).match(/Brief: (.+)/)![1], "utf8");
    expect(brief).toContain("Decisions the engineer has not settled yet");
    expect(brief).toContain("rounds half down");
    // A bare file name is read from the run's work dir, where the brief told the subagent to write.
    fs.writeFileSync(path.join(root, ".git/helix/runs/order/work/tests.json"),
      JSON.stringify({ checkpoints: { "cp-1": [{ name: "a", given: "a", when: "b", then: "c" }] } }));
    helix(["tests", "order", "--file", "tests.json"]);
    expect(helix(["submit-plan", "order", "--no-open"])).toContain("rounds half down");
    expect(fs.readFileSync(path.join(root, ".git/helix/runs/order/viewer-data.js"), "utf8")).toContain("rounds half down");
    const bad = { ...cps, decisions: [""] };
    helix(["plan", "order", "--file", input("bad.json", bad)], 1);
  });

  test("plan cannot be submitted without test cases", () => {
    helix(["new", "order", "--goal", "g", "--reference", "r"]);
    helix(["plan", "order", "--file", input("cps.json", { checkpoints: [{ title: "Skeleton", summary: "s", done_when: ["x"], ui: false }] })]);
    expect(helix(["submit-plan", "order", "--no-open"], 1)).toContain("without test cases");
  });

  test("plan approval requires a real engineer reply", () => {
    plan();
    helix(["submit-plan", "order", "--no-open"]);
    expect(helix(["approve", "order"], 1)).toContain("No engineer reply");
    reply("approved");
    helix(["approve", "order"]);
    const s = state();
    expect([s.status, s.current]).toEqual(["building", "cp-1"]);
    expect(s.history.at(-1).reply).toBe("approved");
  });

  test("plan approval requires a clean tree", () => {
    plan();
    helix(["submit-plan", "order", "--no-open"]);
    write("stray.txt", "uncommitted");
    reply("approve");
    expect(helix(["approve", "order"], 1)).toContain("uncommitted changes");
  });

  test("a run from an older version is not mistaken for one still revising its plan", () => {
    plan();
    helix(["submit-plan", "order", "--no-open"]);
    reply("split step 1");
    helix(["feedback", "order", "--text", "split step 1"]);
    helix(["plan", "order", "--file", input("cps2.json", { checkpoints: [{ title: "Split", summary: "s", done_when: ["x"], ui: false }] })]);
    const file = path.join(root, ".git/helix/runs/order/state.json");
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    delete old.plan_loaded_at;
    fs.writeFileSync(file, JSON.stringify(old));
    expect(helix(["status", "order"])).toContain("helix brief order test-planner");
  });

  test("re-planning one checkpoint's tests after the engineer changes it", () => {
    approvedPlan();
    expect(helix(["brief", "order", "test-planner"], 1)).toContain("--checkpoint");
    const file = helix(["brief", "order", "test-planner", "--checkpoint", "cp-1"]).match(/Brief: (.+)/)![1];
    expect(fs.readFileSync(file, "utf8")).toContain("Re-plan cp-1");
  });

  test("plan feedback returns to planning and saves the learning", () => {
    plan();
    helix(["submit-plan", "order", "--no-open"]);
    reply("split step 1, and never mix fetch and render in one checkpoint");
    helix(["feedback", "order", "--text", "split step 1", "--learning", "Never mix fetch and render."]);
    expect(state().status).toBe("planning");
    const learnings = fs.readFileSync(path.join(root, ".helix/learnings.md"), "utf8");
    expect(learnings).toContain("Never mix fetch and render.");
    expect(learnings).not.toContain("_\n\n-"); // a tight list, one lesson per line
  });
});

describe("gates", () => {
  test("behavior gate runs the real test command", () => {
    approvedPlan();
    expect(helix(["gate", "behavior", "order"], 2)).toContain("FAILED");
    write("app.py", "VALUE = 2\n");
    expect(helix(["gate", "behavior", "order"])).toContain("PASSED");
    const gate = state().checkpoints[0].gates.behavior;
    expect([gate.status, gate.attempt]).toEqual(["passed", 2]);
    expect(fs.existsSync(path.join(root, gate.evidence))).toBe(true);
  });

  test("behavior gate fails when tests dirty the tree, and sends the fixer to it", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    write("test.sh", "#!/bin/sh\ndate > coverage.out\n");
    expect(helix(["gate", "behavior", "order"], 2)).toContain("modified the working tree");
    expect(helix(["status", "order"])).toContain("helix brief order fixer");
    const file = helix(["brief", "order", "fixer"]).match(/Brief: (.+)/)![1];
    const log = fs.readFileSync(file, "utf8").match(/Behavior log \(attempt 1\): (\S+)/)![1];
    expect(fs.readFileSync(log, "utf8")).toContain("GATE FAILED: the test run modified the working tree");
    expect(fs.readFileSync(log, "utf8")).toContain("coverage.out");
  });

  test("same-size edits right after a commit are fingerprinted (racy git)", () => {
    approvedPlan();
    for (let i = 0; i < 4; i++) {
      write("app.py", "VALUE = 1\n");
      git("commit", "-qam", `reset ${i}`, "--allow-empty");
      write("app.py", "VALUE = 2\n"); // same size, same second as the index write
      helix(["gate", "behavior", "order"]);
      expect(helix(["status", "order"])).toContain("behavior:passed");
    }
  });

  test("gates run in order", () => {
    approvedPlan();
    const [ref, impl] = screenshots();
    expect(helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"], 1)).toContain("behavior gate is pending");
    expect(helix(["gate", "review", "order"], 1)).toContain("behavior gate is pending");
  });

  test("a code change makes passed gates stale", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    write("app.py", "VALUE = 2  # tweak\n");
    expect(helix(["status", "order"])).toContain("behavior:stale");
    const [ref, impl] = screenshots();
    expect(helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"], 1)).toContain("stale");
  });

  test("ui gate blocks fixable differences and invalid pairs", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    const [ref, impl] = screenshots();
    setVerdicts({ ui: UI_FAIL });
    expect(helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"], 2)).toContain("20% smaller");
    setVerdicts({ ui: UI_INVALID });
    expect(helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"], 3)).toContain("Recapture");
    setVerdicts({ ui: UI_PASS });
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
    const evidence = path.join(root, ".git/helix/runs/order/evidence/cp-1/ui-003");
    expect(fs.existsSync(path.join(evidence, "pair-1-reference.png"))).toBe(true);
    expect(fs.readFileSync(path.join(evidence, "pair-1.prompt.md"), "utf8")).toContain("10x20 px");
  });

  test("a passing verdict with a fixable finding still fails", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    const [ref, impl] = screenshots();
    setVerdicts({ ui: { ...UI_FAIL, verdict: "PASS" } });
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"], 2);
  });

  test("review gate needs both reviewers to approve", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    const [ref, impl] = screenshots();
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
    setVerdicts({ architecture: REJECT });
    expect(helix(["gate", "review", "order"], 2)).toContain("UI calls storage directly");
    expect(helix(["status", "order"])).toContain("helix brief order fixer");
    write("app.py", "VALUE = 2  # fixed\n");
    helix(["gate", "behavior", "order"]);
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
    expect(helix(["status", "order"])).toContain("the code changed since the last review failed");
    answer(1, [{ id: "F1", status: "fixed", note: "went through the service" }]);
    setVerdicts({ architecture: { ...REJECT, verdict: "approve" } }); // "approve" with a finding still blocks
    helix(["gate", "review", "order"], 2);
    answer(2, [{ id: "F2", status: "fixed" }]);
    setVerdicts({ architecture: APPROVE });
    helix(["gate", "review", "order"]);
    const review = path.join(root, ".git/helix/runs/order/evidence/cp-1/review-003");
    expect(fs.readFileSync(path.join(review, "diff.patch"), "utf8")).toContain("VALUE = 2");
    expect(fs.readFileSync(path.join(review, "reviewer-1.prompt.md"), "utf8")).toContain("docs/architecture.md");
  });

  test("a finding raised again keeps its id until the reviewer is satisfied", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    gatesBeforeReview();
    setVerdicts({ architecture: finding("UI calls storage directly") });
    expect(helix(["gate", "review", "order"], 2)).toContain("F1 [major] app.py:1");
    write("app.py", "VALUE = 2  # tried\n");
    gatesBeforeReview();
    answer(1, [{ id: "F1", status: "fixed", note: "moved the call" }]);
    setVerdicts({ architecture: finding("UI still calls storage through a helper", "F1") });
    const second = helix(["gate", "review", "order"], 2);
    expect(second).toContain("F1 [major] app.py:1 (architecture.md#layers), architecture reviewer, raised in review attempts 1, 2");
    expect(second).toContain("Fixer's answer to attempt 1: fixed - moved the call");
    expect(state().checkpoints[0].findings).toHaveLength(1);
    expect(reviewerPrompt(2, 1)).toContain("Still open from your earlier reviews");
    expect(reviewerPrompt(2, 1)).toContain("- F1 [major]");
    expect(reviewerPrompt(2, 2)).toContain("None. Review the change from scratch."); // reviewers stay independent
    const brief = fixerBrief();
    expect(brief).toContain("UI still calls storage through a helper");
    expect(brief).toContain("cp-1-review-002.json");
    write("app.py", "VALUE = 2  # through the service\n");
    gatesBeforeReview();
    answer(2, [{ id: "F1", status: "fixed", note: "service now" }]);
    setVerdicts({ architecture: APPROVE });
    expect(helix(["gate", "review", "order"])).toContain("- F1 app.py:1: UI still calls storage through a helper");
    expect(state().checkpoints[0].findings[0]).toMatchObject({ status: "resolved", resolved_in: 3, raised: [1, 2] });
  });

  test("two reviewers reporting the same problem sit together for one fix", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    gatesBeforeReview();
    setVerdicts({ architecture: finding("storage access in the UI", "", 4), correctness: finding("UI reads storage", "", 3) });
    const out = helix(["gate", "review", "order"], 2);
    expect(out).toContain("fix it once and answer both ids");
    expect(out.indexOf("F2 [major] app.py:3")).toBeLessThan(out.indexOf("F1 [major] app.py:4"));
  });

  test("the review does not run again until the fixer has answered every finding", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    gatesBeforeReview();
    setVerdicts({ architecture: finding("UI calls storage directly"), correctness: finding("no error state", "", 2) });
    helix(["gate", "review", "order"], 2);
    write("app.py", "VALUE = 2  # fixed\n");
    gatesBeforeReview();
    expect(helix(["gate", "review", "order"], 1)).toContain("has not answered every review finding: F1, F2");
    answer(1, [{ id: "F1", status: "fixed" }]);
    expect(helix(["gate", "review", "order"], 1)).toContain("has not answered every review finding: F2");
    answer(1, [{ id: "F1", status: "fixed" }, { id: "F2", status: "disputed" }]);
    expect(helix(["gate", "review", "order"], 1)).toContain("disputed without evidence");
    answer(1, [{ id: "F1", status: "fixed" }, { id: "F9", status: "fixed" }]);
    expect(helix(["gate", "review", "order"], 1)).toContain("F9 is not an unanswered finding");
    expect(state().checkpoints[0].attempts.review).toBe(1); // refused before a new attempt began
  });

  test("a disputed finding raised again goes to the engineer, whose drop ruling ends it", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    gatesBeforeReview();
    setVerdicts({ architecture: finding("VALUE must come from the service") });
    helix(["gate", "review", "order"], 2);
    answer(1, [{ id: "F1", status: "disputed", note: "There is no service layer in this app; docs/architecture.md lists none for constants." }]);
    expect(helix(["status", "order"])).toContain("the fixer answered the review without changing code");
    setVerdicts({ architecture: finding("VALUE must still come from the service", "F1") });
    const out = helix(["gate", "review", "order"], 2);
    expect(reviewerPrompt(2, 1)).toContain("Fixer's answer to attempt 1: disputed - There is no service layer");
    expect(out).toContain("going in circles on F1 (the fixer disputed it, the reviewer raised it again)");
    expect(helix(["status", "order"])).toContain("helix rule order <id> fix|drop");
    expect(helix(["brief", "order", "fixer"], 1)).toContain("going in circles on F1");
    expect(helix(["gate", "review", "order"], 1)).toContain("going in circles on F1");
    expect(helix(["findings", "order"])).toContain("Needs the engineer's ruling.");
    // Only the engineer rules, after the finding was raised.
    expect(helix(["rule", "order", "F1", "drop", "--text", "fixer is right"], 1)).toContain("Only the engineer can rule on F1");
    const asked = helix(["ask", "order", "--finding", "F1"]);
    expect(asked).toContain(`F1 (architecture reviewer, app.py:1, raised 2x): "VALUE must still come from the service"`);
    expect(asked).toContain('The fixer disputes it: "There is no service layer');
    reply("the fixer is right, constants stay in app.py");
    expect(helix(["status", "order"])).toContain('the engineer replied: "the fixer is right, constants stay in app.py". Record their ruling on F1');
    helix(["rule", "order", "f1", "drop", "--text", "the fixer is right, constants stay in app.py",
      "--learning", "Constants live in app.py; no service layer for them."]);
    expect(fs.readFileSync(path.join(root, ".helix/learnings.md"), "utf8")).toContain("Constants live in app.py");
    expect(helix(["status", "order"])).toContain("no review finding is left to fix; run `helix gate review order`");
    // A reviewer that raises a dropped finding again does not block.
    expect(helix(["gate", "review", "order"])).toContain("Raised again after the engineer dropped them (not blocking)");
    expect(reviewerPrompt(3, 1)).toContain("Dropped by the engineer. Their ruling is final");
    expect(state().checkpoints[0].gates.review.status).toBe("passed");
  });

  test("a fix ruling cannot be disputed, and a finding raised three times goes to the engineer", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    gatesBeforeReview();
    setVerdicts({ architecture: finding("missing error state") });
    helix(["gate", "review", "order"], 2);
    for (const attempt of [1, 2]) {
      write("app.py", `VALUE = 2  # try ${attempt}\n`);
      gatesBeforeReview();
      answer(attempt, [{ id: "F1", status: "fixed" }]);
      setVerdicts({ architecture: finding("still no error state", "F1") });
      helix(["gate", "review", "order"], 2);
    }
    expect(helix(["status", "order"])).toContain("going in circles on F1 (raised 3 times)");
    helix(["ask", "order", "F1 keeps coming back. Is the error state required?"]);
    reply("yes, it is required: show the retry banner");
    helix(["rule", "order", "F1", "fix", "--text", "yes, it is required: show the retry banner"]);
    expect(fixerBrief()).toContain(`Engineer's ruling: it must be fixed - "yes, it is required: show the retry banner"`);
    write("app.py", "VALUE = 2  # banner\n");
    gatesBeforeReview();
    answer(3, [{ id: "F1", status: "disputed", note: "not needed" }]);
    expect(helix(["gate", "review", "order"], 1)).toContain("the engineer ruled that F1 must be fixed");
    answer(3, [{ id: "F1", status: "fixed", note: "retry banner" }]);
    setVerdicts({ architecture: APPROVE });
    helix(["gate", "review", "order"]);
  });

  test("a reviewer that requests changes without findings is an error, not a finding", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    gatesBeforeReview();
    setVerdicts({ architecture: { verdict: "changes_requested", summary: "Hmm.", findings: [] } });
    expect(helix(["gate", "review", "order"], 2)).toContain("requested changes but reported no findings");
    expect(state().checkpoints[0].gates.review.status).toBe("error");
    expect(helix(["status", "order"])).toContain("Never dispatch the fixer for an error");
  });

  test("the engineer can waive only the ui gate, and the waiver survives code changes", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    expect(helix(["waive", "order", "review", "--reason", "x"], 1)).toContain("Only the ui gate");
    expect(helix(["waive", "order", "ui", "--reason", "x"], 1)).toContain("Only the engineer can waive");
    reply("skip the visual check, there is no simulator here");
    helix(["waive", "order", "ui", "--reason", "no simulator available; Jest covers it"]);
    write("app.py", "VALUE = 2  # later fix\n");
    helix(["gate", "behavior", "order"]);
    expect(helix(["status", "order"])).toContain("ui:passed");
    helix(["gate", "review", "order"]);
    helix(["request-approval", "order"]);
    reply("ok");
    helix(["approve", "order"]);
    helix(["commit", "order"]);
    expect(git("log", "-1", "--format=%B")).toContain("ui: waived by the engineer (no simulator available; Jest covers it)");
  });

  test("a reviewer crash is an error, not a pass", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    const [ref, impl] = screenshots();
    fs.writeFileSync(verdicts, "not json");
    expect(helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"], 2)).toContain("ERROR");
    expect(state().checkpoints[0].gates.ui.status).toBe("error");
  });
});

describe("approval and commit", () => {
  test("full checkpoint cycle commits with evidence", () => {
    approvedPlan();
    passAllGates();
    expect(helix(["commit", "order"], 1)).toContain("human gate is pending");
    const requested = helix(["request-approval", "order"]);
    expect(requested).toContain("- behavior: passed (1 run, never sent back): 1 planned case via `sh test.sh`");
    expect(requested).toContain("- review: passed (1 run, never sent back): every reviewer approved");
    expect(state().status).toBe("awaiting_approval");
    expect(stop()).toBeNull(); // stopping is allowed while waiting for the engineer
    expect(helix(["approve", "order"], 1)).toContain("No engineer reply");
    reply("ship it");
    expect(helix(["status", "order"])).toContain('The engineer replied about checkpoint cp-1: "ship it"');
    helix(["approve", "order"]);
    helix(["commit", "order", "--trailer", "Reviewed-by: Engineer <e@example.com>"]);
    const message = git("log", "-1", "--format=%B");
    expect(message).toContain("Reviewed-by: Engineer <e@example.com>");
    expect(message).toContain("helix(order): cp-1 Step 1");
    expect(message).toContain("- human: approved by the engineer");
    expect(message).toContain("- behavior: passed (1 run, never sent back): 1 planned case via `sh test.sh`");
    expect(message).toContain("- ui: passed (1 run, never sent back): 1 screen matches the reference");
    expect(message).toContain("- review: passed (1 run, never sent back): every reviewer approved");
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("app.py"); // only the product change
    expect(git("status", "--porcelain")).toBe(""); // Helix's own writes never dirty the tree
    expect(fs.existsSync(path.join(root, ".git/helix/runs/order/evidence/cp-1/summary.json"))).toBe(true);
    // The evidence outlives the worktree: it is archived by commit in the shared git dir.
    const archive = path.join(root, ".git/helix/evidence", git("rev-parse", "HEAD").trim());
    expect(fs.existsSync(path.join(archive, "summary.json"))).toBe(true);
    expect(fs.existsSync(path.join(archive, "review-001", "findings.md"))).toBe(true);
    const s = state();
    expect(s.checkpoints[0].status).toBe("committed");
    expect(s.current).toBe("cp-2");
    expect(s.checkpoints[1].base).toBe(git("rev-parse", "HEAD").trim());
  });

  test("approval is void if the code changed while waiting", () => {
    approvedPlan();
    passAllGates();
    helix(["request-approval", "order"]);
    write("app.py", "VALUE = 2  # sneaky\n");
    reply("approve");
    expect(helix(["approve", "order"], 1)).toContain("code changed");
  });

  test("checkpoint feedback clears the human gate and is remembered", () => {
    approvedPlan();
    passAllGates();
    helix(["request-approval", "order"]);
    reply("title should be bold; we always use semibold titles");
    helix(["feedback", "order", "--text", "title bold", "--learning", "Titles are semibold."]);
    const s = state();
    expect(s.status).toBe("building");
    expect(s.checkpoints[0].gates.human).toBeUndefined();
    expect(s.checkpoints[0].feedback[0].text).toBe("title bold");
  });

  test("feedback must be addressed before approval is requested again", () => {
    approvedPlan();
    passAllGates();
    helix(["request-approval", "order"]);
    reply("make the title bold");
    helix(["feedback", "order", "--text", "title bold"]);
    expect(helix(["status", "order"])).toContain("feedback is not addressed yet");
    expect(helix(["request-approval", "order"], 1)).toContain("has not changed since the engineer's feedback");
    write("app.py", "VALUE = 2  # bold title\n");
    helix(["gate", "behavior", "order"]);
    const [ref, impl] = screenshots();
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
    helix(["gate", "review", "order"]);
    helix(["request-approval", "order"]);
    expect(state().status).toBe("awaiting_approval");
  });

  test("autonomy needs an engineer prompt and auto-approves", () => {
    approvedPlan();
    reply("do the next checkpoint without asking me");
    helix(["autonomy", "order", "--checkpoints", "1"]);
    passAllGates();
    expect(helix(["request-approval", "order"])).toContain("autonomous mode approved");
    helix(["commit", "order"]);
    const s = state();
    expect(s.autonomy.remaining).toBe(0);
    expect(s.checkpoints[0].gates.human.reply).toBe("do the next checkpoint without asking me");
  });

  test("the last commit finishes the run and add reopens it", () => {
    approvedPlan({ ui: false, count: 1 });
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    helix(["gate", "review", "order"]);
    helix(["request-approval", "order"]);
    reply("ok");
    helix(["approve", "order"]);
    helix(["commit", "order"]);
    expect(state().status).toBe("done");
    expect(stop()).toBeNull();
    reply("the empty state is missing");
    helix(["feedback", "order", "--text", "empty state missing"]);
    helix(["add", "order", "--file", input("more.json", { checkpoints: [{ title: "Empty state", summary: "Show empty state.", done_when: ["shown"], ui: false }] })]);
    const s = state();
    expect([s.status, s.current]).toEqual(["building", "cp-2"]);
    expect(helix(["status", "order"])).toContain("no planned test cases");
  });
});

describe("storage", () => {
  test("runs stay out of the working tree; only the team files live in it", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    expect(git("status", "--porcelain")).toBe(" M app.py\n");
    expect(fs.readdirSync(path.join(root, ".helix")).sort()).toEqual(["config.json", "learnings.md"]);
  });

  test("a worktree holds one unfinished run, since gates fingerprint the whole tree", () => {
    helix(["new", "order", "--goal", "g", "--reference", "r"]);
    expect(helix(["new", "screen", "--goal", "g", "--reference", "r"], 1)).toContain("Run 'order' is still in progress in this worktree");
  });

  test("linked worktrees keep their own runs", () => {
    helix(["new", "order", "--goal", "g", "--reference", "r"]);
    const linked = path.join(scratch, "linked");
    git("worktree", "add", "-q", linked, "-b", "feature");
    const run = (args: string[]) => {
      const proc = spawnSync("bun", [HELIX, ...args], { cwd: linked, encoding: "utf8", env: env() });
      expect(proc.status).toBe(0);
      return proc.stdout + proc.stderr;
    };
    expect(run(["status"])).toContain("No Helix runs");
    run(["new", "screen", "--goal", "g", "--reference", "r"]);
    expect(run(["status"])).toContain("Run screen");
    expect(run(["status"])).not.toContain("Run order");
    expect(helix(["status"])).not.toContain("Run screen");
  });
});

describe("team files", () => {
  test("a learning travels with the checkpoint commit, and gates ignore it", () => {
    approvedPlan({ ui: false, count: 1 });
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    expect(helix(["learn", "Constants live in app.py."])).toContain("Commit it so everyone's agents apply it");
    helix(["gate", "review", "order"]); // the behavior gate still holds: a learning is not code
    const patch = fs.readFileSync(path.join(root, ".git/helix/runs/order/evidence/cp-1/review-001/diff.patch"), "utf8");
    expect(patch).toContain("app.py");
    expect(patch).not.toContain(".helix");
    expect(reviewerPrompt(1, 1)).toContain("Constants live in app.py.");
    helix(["request-approval", "order"]);
    reply("ship it");
    helix(["approve", "order"]);
    helix(["commit", "order"]);
    expect(git("show", "--name-only", "--format=", "HEAD").split("\n")).toContain(".helix/learnings.md");
    expect(git("status", "--porcelain")).toBe("");
  });

  test("a teammate's clone uses the team config, with their own overrides on top", () => {
    const teammate = path.join(scratch, "teammate");
    git("clone", "-q", root, teammate);
    const original = root;
    root = teammate;
    try {
      fs.mkdirSync(path.join(root, ".git/helix"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git/helix/config.local.json"), JSON.stringify({ test_command: "sh -c 'exit 3'" }));
      expect(helix(["status"])).toContain("with your overrides in");
      approvedPlan({ ui: false, count: 1 });
      write("app.py", "VALUE = 2\n");
      expect(helix(["gate", "behavior", "order"], 2)).toContain("exited 3");
      expect(fs.readFileSync(path.join(root, ".helix/config.json"), "utf8")).toContain("fake_reviewer.ts");
    } finally {
      root = original;
    }
  });

  test("learnings from another worktree apply before they are merged, and removed ones stay removed", () => {
    helix(["learn", "Old rule."]);
    git("add", "-A");
    git("commit", "-q", "-m", "learn");
    const linked = path.join(scratch, "linked");
    git("worktree", "add", "-q", linked, "-b", "feature");
    write(".helix/learnings.md", fs.readFileSync(path.join(root, ".helix/learnings.md"), "utf8").replace(/^- Old rule\..*\n/m, ""));
    git("commit", "-qam", "drop the old rule");
    spawnSync("bun", [HELIX, "learn", "New rule."], { cwd: linked, encoding: "utf8", env: env() });
    approvedPlan();
    const brief = fs.readFileSync(helix(["brief", "order", "implementer"]).match(/Brief: (.+)/)![1], "utf8");
    expect(brief).toContain("not merged into this branch yet (apply them too):\n  - New rule.");
    expect(brief).not.toContain("Old rule.");
  });

  test("init moves the config and learnings out of the git dir", () => {
    fs.mkdirSync(path.join(root, ".git/helix"), { recursive: true });
    fs.renameSync(path.join(root, ".helix/config.json"), path.join(root, ".git/helix/config.json"));
    fs.renameSync(path.join(root, ".helix/learnings.md"), path.join(root, ".git/helix/learnings.md"));
    fs.appendFileSync(path.join(root, ".git/helix/learnings.md"), "- Titles are semibold.\n");
    expect(helix(["status"], 1)).toContain("Run `helix init` once to move them there");
    const out = helix(["init"]);
    expect(out).toContain("Moved your config from");
    expect(out).toContain("Moved 2 learnings from");
    expect(fs.existsSync(path.join(root, ".git/helix/config.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".git/helix/learnings.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".helix/config.json"), "utf8")).toContain("fake_reviewer.ts");
    expect(fs.readFileSync(path.join(root, ".helix/learnings.md"), "utf8")).toContain("- Titles are semibold.");
  });
});

describe("other agents", () => {
  test("a Codex session owns the runs it creates", () => {
    const proc = spawnSync("bun", [HELIX, "new", "order", "--goal", "g", "--reference", "r"], {
      cwd: root, encoding: "utf8", env: { ...env(), CLAUDE_CODE_SESSION_ID: "", CODEX_SESSION_ID: "codex-session" },
    });
    expect(proc.status).toBe(0);
    expect(state().owner_session).toBe("codex-session");
  });

  test("hooks codex merges into existing Codex hooks idempotently", () => {
    const codexHome = path.join(scratch, "codex-home");
    fs.mkdirSync(codexHome);
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node other-hook.mjs" }] }] } };
    fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify(existing));
    for (let i = 0; i < 2; i++) {
      const proc = spawnSync("bun", [HELIX, "hooks", "codex"], { cwd: root, encoding: "utf8", env: { ...env(), CODEX_HOME: codexHome } });
      expect(proc.status).toBe(0);
    }
    const config = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
    const commands = (event: string) => config.hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands("Stop")).toEqual(["node other-hook.mjs", expect.stringContaining("hook stop")]);
    expect(commands("UserPromptSubmit")).toEqual([expect.stringContaining("hook prompt")]);
    // The installed command is a working Helix hook: it blocks a stop mid-run.
    approvedPlan();
    const hookCommand = commands("Stop")[1].replace(" || true", "");
    const out = spawnSync("sh", ["-c", hookCommand], {
      cwd: root, encoding: "utf8", env: env(), input: JSON.stringify({ session_id: SESSION, cwd: root, hook_event_name: "Stop" }),
    });
    expect(JSON.parse(out.stdout).decision).toBe("block");
  });

  test("hooks install for Gemini, Cursor and Copilot, preserving other settings", () => {
    const home = path.join(scratch, "home");
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(home, ".gemini/settings.json"), JSON.stringify({ theme: "dark" }));
    for (const agent of ["gemini", "cursor", "copilot", "gemini"]) {
      const proc = spawnSync("bun", [HELIX, "hooks", agent], { cwd: root, encoding: "utf8", env: { ...env(), HOME: home } });
      expect(proc.status).toBe(0);
    }
    const read = (file: string) => JSON.parse(fs.readFileSync(path.join(home, file), "utf8"));
    const gemini = read(".gemini/settings.json");
    expect(gemini.theme).toBe("dark");
    expect(gemini.hooks.AfterAgent).toHaveLength(1);
    expect(gemini.hooks.BeforeAgent[0].hooks[0].command).toContain("hook prompt");
    const cursor = read(".cursor/hooks.json");
    expect(cursor.hooks.stop[0]).toMatchObject({ command: expect.stringContaining("hook stop cursor"), loop_limit: null });
    expect(read(".copilot/hooks/helix.json").hooks.Stop[0].bash).toContain("hook stop");
  });

  test("Gemini's AfterAgent and BeforeAgent events speak the standard protocol", () => {
    approvedPlan();
    const out = hook("prompt", { session_id: SESSION, cwd: root, prompt: "go on", hook_event_name: "BeforeAgent" });
    expect(out.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
    expect(hook("stop", { session_id: SESSION, cwd: root, hook_event_name: "AfterAgent" }).decision).toBe("block");
  });

  test("Cursor hooks use conversation ids, workspace roots and follow-up messages", () => {
    approvedPlan();
    const cursor = (event: string, payload: object) => {
      const proc = spawnSync("bun", [HELIX, "hook", event, "cursor"], {
        cwd: scratch, encoding: "utf8", input: JSON.stringify(payload), env: env(),
      });
      expect(proc.status).toBe(0);
      return proc.stdout.trim() ? JSON.parse(proc.stdout) : null;
    };
    helix(["claim", "order"], 0, ""); // Cursor exports no session id to commands, so its hooks claim the run
    expect(cursor("prompt", { conversation_id: "cursor-1", workspace_roots: [root], prompt: "continue" })).toBeNull();
    expect(state().owner_session).toBe("cursor-1");
    expect(cursor("stop", { conversation_id: "cursor-1", workspace_roots: [root], status: "completed" }).followup_message)
      .toContain("helix gate behavior order");
  });

  test("the codex reviewer gets its prompt on stdin, since -i would swallow it", () => {
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(scratch, "codex-calls.jsonl");
    fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
const stdin = await Bun.stdin.text();
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, stdin }) + "\\n");
const out = args[args.indexOf("-o") + 1];
const ui = args.includes("-i");
await Bun.write(out, JSON.stringify(ui ? ${JSON.stringify(UI_PASS)} : ${JSON.stringify(APPROVE)}));
`);
    fs.chmodSync(path.join(bin, "codex"), 0o755);
    const configFile = path.join(root, ".helix/config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.reviewers.ui = { backend: "codex" };
    fs.writeFileSync(configFile, JSON.stringify(config));
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    const [ref, impl] = screenshots();
    const proc = spawnSync("bun", [HELIX, "gate", "ui", "order", "--pair", ref, impl, "loaded"], {
      cwd: root, encoding: "utf8", env: { ...env(), PATH: `${bin}:${process.env.PATH}` },
    });
    expect(proc.status).toBe(0);
    const call = JSON.parse(fs.readFileSync(calls, "utf8").trim());
    expect(call.args.filter((a: string) => a === "-i")).toHaveLength(2);
    expect(call.args.at(-1)).toEndWith("pair-1-implementation.png"); // no prompt after the images
    expect(call.stdin).toContain("perfectionist design reviewer");
  });

  test("reviewers default to codex when claude is not installed", () => {
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
    fs.chmodSync(path.join(bin, "codex"), 0o755);
    fs.rmSync(path.join(root, ".helix/config.json"));
    const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const PATH = [bin, path.dirname(process.execPath), path.dirname(git), "/usr/bin", "/bin"].join(":");
    const proc = spawnSync(process.execPath, [HELIX, "init", "--test-command", "true"], { cwd: root, encoding: "utf8", env: { ...env(), PATH } });
    expect(proc.status).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(root, ".helix/config.json"), "utf8"));
    expect(config.reviewers.ui.backend).toBe("codex");
    expect(config.reviewers.code.map((r: any) => r.backend)).toEqual(["codex", "codex"]);
  });
});

describe("hooks", () => {
  test("stop is blocked while building, with the next action", () => {
    approvedPlan();
    const out = stop();
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("helix gate behavior order");
  });

  test("other sessions are not blocked", () => {
    approvedPlan();
    expect(stop("someone-else")).toBeNull();
  });

  test("repeated stops without progress stall the run", () => {
    approvedPlan();
    for (let i = 0; i < 3; i++) expect(stop().decision).toBe("block");
    expect(stop().systemMessage).toContain("stalled");
    expect(state().status).toBe("stalled");
    expect(stop()).toBeNull();
    helix(["resume", "order"]);
    expect(state().status).toBe("building");
  });

  test("progress resets the stall counter", () => {
    approvedPlan();
    for (let i = 0; i < 6; i++) {
      write("app.py", `VALUE = ${i + 10}\n`);
      expect(stop().decision).toBe("block");
    }
  });

  test("prompt hook injects status and resumes questions", () => {
    approvedPlan();
    helix(["ask", "order", "Which currency format?"]);
    expect(stop()).toBeNull();
    expect(reply("use the store currency").hookSpecificOutput.additionalContext).toContain("building");
    expect(state().status).toBe("building");
  });

  test("hooks fail open on bad input", () => {
    for (const event of ["stop", "prompt"]) {
      const proc = spawnSync("bun", [HELIX, "hook", event], { cwd: root, encoding: "utf8", input: "{not json", env: env() });
      expect([proc.status, proc.stdout]).toEqual([0, ""]);
    }
  });

  test("hooks are silent outside helix repos", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "helix-other-"));
    try {
      expect(hook("stop", { session_id: SESSION, cwd: other }, other)).toBeNull();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("viewer", () => {
  test("default title is human readable", () => {
    helix(["new", "order-details", "--goal", "g", "--reference", "r"]);
    expect(state("order-details").title).toBe("Order details");
  });

  test("embeds the run safely", () => {
    helix(["new", "order", "--goal", "</script><b>x</b> {{REFRESH}} $&", "--reference", "r"]);
    const page = fs.readFileSync(path.join(root, ".git/helix/runs/order/viewer.html"), "utf8");
    expect(page).not.toContain("</script><b>");
    expect(page).toContain("{{REFRESH}} $&"); // user text is never treated as a template
    expect(page).not.toContain("/*HELIX_DATA*/");
    // The open page follows the run through a data script beside it.
    const data = fs.readFileSync(path.join(root, ".git/helix/runs/order/viewer-data.js"), "utf8");
    expect(data.startsWith("window.helixUpdate(")).toBe(true);
    expect(data).not.toContain("</script>");
  });
});

describe("agents without a prompt hook", () => {
  const AGENT = ""; // no session id exported, like Gemini CLI or Cursor
  test("the agent relays the engineer's reply and it is labelled as relayed", () => {
    plan({ ui: false, count: 1 });
    helix(["submit-plan", "order", "--no-open"], 0, AGENT);
    expect(helix(["status", "order"], 0, AGENT)).toContain("relay their reply word for word first");
    expect(helix(["approve", "order"], 1, AGENT)).toContain("helix reply order");
    helix(["reply", "order", "--text", "Looks good, approve it."], 0, AGENT);
    helix(["approve", "order"], 0, AGENT);
    expect(state().status).toBe("building");
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"], 0, AGENT);
    helix(["gate", "review", "order"], 0, AGENT);
    helix(["request-approval", "order"], 0, AGENT);
    helix(["reply", "order", "--text", "ship it"], 0, AGENT);
    helix(["approve", "order"], 0, AGENT);
    helix(["commit", "order"], 0, AGENT);
    expect(git("log", "-1", "--format=%B")).toContain("- human: approved by the engineer, relayed by the agent");
  });

  test("once a prompt hook records messages, nobody can relay, so the agent cannot answer for the engineer", () => {
    approvedPlan(); // the plan approval came through the prompt hook
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    const [ref, impl] = screenshots();
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
    helix(["gate", "review", "order"]);
    helix(["request-approval", "order"]);
    expect(helix(["status", "order"])).not.toContain("relay their reply");
    for (const session of [SESSION, AGENT]) {
      expect(helix(["reply", "order", "--text", "approved"], 1, session)).toContain("relaying is not allowed");
    }
    expect(helix(["approve", "order"], 1, AGENT)).toContain("No engineer reply");
  });

  test("a resumed run is handed to the next session with claim", () => {
    approvedPlan();
    expect(stop("new-session")).toBeNull(); // still owned by the old session
    helix(["gate", "behavior", "order"], 2, AGENT); // an agent without a session id does not take it over
    expect(state().owner_session).toBe(SESSION);
    expect(helix(["claim", "order"], 0, AGENT)).toContain("released");
    reply("keep going", "new-session");
    expect(state().owner_session).toBe("new-session");
    expect(stop("new-session").decision).toBe("block");
  });
});

describe("briefs", () => {
  test("the implementer brief carries everything the subagent needs", () => {
    approvedPlan();
    helix(["learn", "Titles are semibold."]);
    const out = helix(["brief", "order", "implementer"]);
    const file = out.match(/Brief: (.+)/)![1];
    const brief = fs.readFileSync(file, "utf8");
    expect(brief).toContain("# Implementer");
    expect(brief).toContain("cp-1.t1");
    expect(brief).toContain("sh test.sh");
    expect(brief).toContain(path.join(fs.realpathSync(root), "docs/architecture.md"));
    expect(brief).toContain(".helix/learnings.md");
    expect(brief).toContain("title only"); // ui scope
    expect(brief).not.toMatch(/\{\{\w+\}\}/);
  });

  test("the fixer brief points at the failed gate's evidence, and refuses when nothing failed", () => {
    approvedPlan();
    expect(helix(["brief", "order", "fixer"], 1)).toContain("nothing for the fixer");
    helix(["gate", "behavior", "order"], 2);
    const file = helix(["brief", "order", "fixer"]).match(/Brief: (.+)/)![1];
    expect(fs.readFileSync(file, "utf8")).toMatch(/Behavior log \(attempt 1\): .*behavior-001\.log/);
  });

  test("planner briefs carry the engineer's plan feedback", () => {
    plan();
    helix(["submit-plan", "order", "--no-open"]);
    reply("split step 1 in two");
    helix(["feedback", "order", "--text", "split step 1 in two"]);
    expect(helix(["status", "order"])).toContain("helix brief order planner");
    const file = helix(["brief", "order", "planner"]).match(/Brief: (.+)/)![1];
    const brief = fs.readFileSync(file, "utf8");
    expect(brief).toContain("split step 1 in two");
    expect(brief).toContain("work/checkpoints.json");
  });
});

describe("finishing", () => {
  test("the engineer accepts the finished feature and the hooks go quiet", () => {
    approvedPlan({ ui: false, count: 1 });
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    helix(["gate", "review", "order"]);
    helix(["request-approval", "order"]);
    reply("ok");
    helix(["approve", "order"]);
    helix(["commit", "order"]);
    expect(helix(["status", "order"])).toContain("test the whole feature");
    expect(reply("tested it all, it works").hookSpecificOutput.additionalContext).toContain("helix approve order");
    expect(helix(["approve", "order"])).toContain("accepted");
    expect(reply("thanks")).toBeNull();
  });

  test("a commit hook that rewrites files cannot sneak ungated content into the commit", () => {
    approvedPlan({ ui: false, count: 1 });
    const hook = path.join(root, ".git/hooks/pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\ngrep -q fmt app.py || { echo '# fmt' >> app.py; git add app.py; }\n");
    fs.chmodSync(hook, 0o755);
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    helix(["gate", "review", "order"]);
    helix(["request-approval", "order"]);
    reply("ok");
    helix(["approve", "order"]);
    const before = git("rev-parse", "HEAD");
    expect(helix(["commit", "order"], 1)).toContain("commit hook changed the files");
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(root, "app.py"), "utf8")).toContain("# fmt");
    helix(["gate", "behavior", "order"]);
    helix(["gate", "review", "order"]);
    helix(["request-approval", "order"]);
    reply("ok again");
    helix(["approve", "order"]);
    helix(["commit", "order"]);
    expect(git("show", "HEAD:app.py")).toContain("# fmt");
  });
});

describe("cli", () => {
  test("rejects unknown options and missing required flags", () => {
    expect(helix(["new", "order", "--goal", "g"], 1)).toContain("--reference is required");
    expect(helix(["status", "--bogus"], 1)).toContain("Unknown option --bogus");
  });
});
