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
    problem: "UI calls storage directly", required_fix: "go through the service",
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
  const configFile = path.join(root, ".git/helix/config.json");
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

  test("plan feedback returns to planning and saves the learning", () => {
    plan();
    helix(["submit-plan", "order", "--no-open"]);
    reply("split step 1, and never mix fetch and render in one checkpoint");
    helix(["feedback", "order", "--text", "split step 1", "--learning", "Never mix fetch and render."]);
    expect(state().status).toBe("planning");
    const learnings = fs.readFileSync(path.join(root, ".git/helix/learnings.md"), "utf8");
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

  test("behavior gate fails when tests dirty the tree", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    write("test.sh", "#!/bin/sh\ntouch coverage.out\n");
    expect(helix(["gate", "behavior", "order"], 2)).toContain("modified the working tree");
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
    expect(helix(["status", "order"])).toContain("Dispatch the fixer with the findings");
    write("app.py", "VALUE = 2  # fixed\n");
    helix(["gate", "behavior", "order"]);
    helix(["gate", "ui", "order", "--pair", ref, impl, "loaded"]);
    expect(helix(["status", "order"])).toContain("the code changed since the last review failed");
    setVerdicts({ architecture: { ...REJECT, verdict: "approve" } });
    helix(["gate", "review", "order"], 2);
    setVerdicts({ architecture: APPROVE });
    helix(["gate", "review", "order"]);
    const review = path.join(root, ".git/helix/runs/order/evidence/cp-1/review-003");
    expect(fs.readFileSync(path.join(review, "diff.patch"), "utf8")).toContain("VALUE = 2");
    expect(fs.readFileSync(path.join(review, "reviewer-1.prompt.md"), "utf8")).toContain("docs/architecture.md");
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
    helix(["request-approval", "order"]);
    expect(state().status).toBe("awaiting_approval");
    expect(stop()).toBeNull(); // stopping is allowed while waiting for the engineer
    expect(helix(["approve", "order"], 1)).toContain("No engineer reply");
    reply("ship it");
    helix(["approve", "order"]);
    helix(["commit", "order"]);
    const message = git("log", "-1", "--format=%B");
    expect(message).toContain("helix(order): cp-1 Step 1");
    expect(message).toContain("human: passed");
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("app.py"); // only the product change
    expect(git("status", "--porcelain")).toBe(""); // Helix's own writes never dirty the tree
    expect(fs.existsSync(path.join(root, ".git/helix/runs/order/evidence/cp-1/summary.json"))).toBe(true);
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
  test("helix never writes into the working tree", () => {
    approvedPlan();
    write("app.py", "VALUE = 2\n");
    helix(["gate", "behavior", "order"]);
    expect(git("status", "--porcelain")).toBe(" M app.py\n");
    expect(fs.existsSync(path.join(root, ".helix"))).toBe(false);
  });

  test("linked worktrees share config and learnings but keep their own runs", () => {
    helix(["new", "order", "--goal", "g", "--reference", "r"]);
    helix(["learn", "Prefer small modules."]);
    const linked = path.join(scratch, "linked");
    git("worktree", "add", "-q", linked, "-b", "feature");
    const run = (args: string[]) => {
      const proc = spawnSync("bun", [HELIX, ...args], { cwd: linked, encoding: "utf8", env: env() });
      expect(proc.status).toBe(0);
      return proc.stdout + proc.stderr;
    };
    expect(run(["status"])).toContain("No Helix runs");
    expect(fs.readFileSync(path.join(root, ".git/helix/learnings.md"), "utf8")).toContain("Prefer small modules.");
    run(["new", "screen", "--goal", "g", "--reference", "r"]);
    expect(run(["status"])).toContain("Run screen");
    expect(run(["status"])).not.toContain("Run order");
    expect(helix(["status"])).not.toContain("Run screen");
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

  test("reviewers default to codex when claude is not installed", () => {
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
    fs.chmodSync(path.join(bin, "codex"), 0o755);
    fs.rmSync(path.join(root, ".git/helix/config.json"));
    const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const PATH = [bin, path.dirname(process.execPath), path.dirname(git), "/usr/bin", "/bin"].join(":");
    const proc = spawnSync(process.execPath, [HELIX, "init", "--test-command", "true"], { cwd: root, encoding: "utf8", env: { ...env(), PATH } });
    expect(proc.status).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(root, ".git/helix/config.json"), "utf8"));
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
    expect(page).toContain("REFRESH_SECONDS = 4");
    expect(page).not.toContain("/*HELIX_DATA*/");
  });
});

describe("cli", () => {
  test("rejects unknown options and missing required flags", () => {
    expect(helix(["new", "order", "--goal", "g"], 1)).toContain("--reference is required");
    expect(helix(["status", "--bogus"], 1)).toContain("Unknown option --bogus");
  });
});
