// Agents other than Claude Code, and agents without a prompt hook.

import { expect } from "expect";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { APPROVE, approvedPlan, env, git, HELIX, helix, hook, plan, reply, root, run, scratch, screenshots, SESSION, state, stop, UI_PASS, useRepo, write } from "./helpers.mjs";

useRepo();

describe("other agents", () => {
  test("a Codex session owns the runs it creates", () => {
    const proc = run(["node", HELIX, "new", "order", "--goal", "g", "--reference", "r"], {
      cwd: root, env: { ...env(), CLAUDE_CODE_SESSION_ID: "", CODEX_SESSION_ID: "codex-session" },
    });
    expect(proc.status).toBe(0);
    expect(state().owner_session).toBe("codex-session");
  });

  test("hooks codex merges into existing Codex hooks idempotently", () => {
    const codexHome = path.join(scratch, "codex-home");
    fs.mkdirSync(codexHome);
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node other-hook.mjs" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: 'bun "/old/helix/scripts/helix.ts" hook prompt || true' }] }] } };
    fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify(existing));
    for (let i = 0; i < 2; i++) {
      const proc = run(["node", HELIX, "hooks", "codex"], { cwd: root, env: { ...env(), CODEX_HOME: codexHome } });
      expect(proc.status).toBe(0);
    }
    const config = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
    const commands = (/** @type {string} */ event) => config.hooks[event].flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
    expect(commands("Stop")).toEqual(["node other-hook.mjs", expect.stringContaining("hook stop")]);
    expect(commands("UserPromptSubmit")).toEqual([expect.stringContaining("hook prompt")]);
    // The installed command is a working Helix hook: it blocks a stop mid-run.
    approvedPlan();
    const hookCommand = commands("Stop")[1].replace(" || true", "");
    const out = run(["sh", "-c", hookCommand], {
      cwd: root, env: env(), input: JSON.stringify({ session_id: SESSION, cwd: root, hook_event_name: "Stop" }),
    });
    expect(JSON.parse(out.stdout).decision).toBe("block");
  });

  test("hooks install for Gemini, Cursor and Copilot, preserving other settings", () => {
    const home = path.join(scratch, "home");
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(home, ".gemini/settings.json"), JSON.stringify({ theme: "dark" }));
    for (const agent of ["gemini", "cursor", "copilot", "gemini"]) {
      const proc = run(["node", HELIX, "hooks", agent], { cwd: root, env: { ...env(), HOME: home } });
      expect(proc.status).toBe(0);
    }
    const read = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(path.join(home, file), "utf8"));
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
    const cursor = (/** @type {string} */ event, /** @type {object} */ payload) => {
      const proc = run(["node", HELIX, "hook", event, "cursor"], {
        cwd: scratch, input: JSON.stringify(payload), env: env(),
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
    fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, stdin }) + "\\n");
const out = args[args.indexOf("-o") + 1];
const ui = args.includes("-i");
fs.writeFileSync(out, JSON.stringify(ui ? ${JSON.stringify(UI_PASS)} : ${JSON.stringify(APPROVE)}));
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
    const proc = run(["node", HELIX, "gate", "ui", "order", "--pair", ref, impl, "loaded"], {
      cwd: root, env: { ...env(), PATH: `${bin}:${process.env.PATH}` },
    });
    expect(proc.status).toBe(0);
    const call = JSON.parse(fs.readFileSync(calls, "utf8").trim());
    expect(call.args.filter((/** @type {string} */ a) => a === "-i")).toHaveLength(2);
    expect(call.args.at(-1)).toMatch(/pair-1-implementation\.png$/); // no prompt after the images
    expect(call.stdin).toContain("perfectionist design reviewer");
  });

  test("reviewers default to codex when claude is not installed", () => {
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
    fs.chmodSync(path.join(bin, "codex"), 0o755);
    fs.rmSync(path.join(root, ".helix/config.json"));
    const git = run(["sh", "-c", "command -v git"]).stdout.trim();
    const PATH = [bin, path.dirname(process.execPath), path.dirname(git), "/usr/bin", "/bin"].join(":");
    const proc = run([process.execPath, HELIX, "init", "--test-command", "true"], { cwd: root, env: { ...env(), PATH } });
    expect(proc.status).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(root, ".helix/config.json"), "utf8"));
    expect(config.reviewers.ui.backend).toBe("codex");
    expect(config.reviewers.code.map((/** @type {any} */ r) => r.backend)).toEqual(["codex", "codex"]);
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
