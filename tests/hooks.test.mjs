// Hooks, the viewer, subagent briefs and the CLI surface.

import { expect } from "expect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { approvedPlan, briefFile, env, HELIX, helix, hook, plan, reply, root, run, SESSION, state, stop, useRepo, write } from "./helpers.mjs";

useRepo();

describe("hooks", () => {
  test("stop is blocked while building, with the next action", () => {
    approvedPlan();
    const out = stop();
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("helix gate behavior order");
  });

  test("the Claude Code plugin's hooks run this CLI", () => {
    approvedPlan();
    const plugin = path.resolve(import.meta.dirname, "..", "plugins", "helix");
    const hooks = JSON.parse(fs.readFileSync(path.join(plugin, "hooks/hooks.json"), "utf8")).hooks;
    /** @param {string} event */
    const command = (event) => hooks[event][0].hooks[0].command.replace(" || true", "");
    const event = { session_id: SESSION, cwd: root };
    const runHook = (/** @type {string} */ name, /** @type {object} */ payload) =>
      run(["sh", "-c", command(name)], { cwd: root, env: { ...env(), CLAUDE_PLUGIN_ROOT: plugin }, input: JSON.stringify(payload) });
    expect(runHook("UserPromptSubmit", { ...event, prompt: "keep going" }).status).toBe(0);
    expect(state().last_prompt.text).toBe("keep going");
    expect(JSON.parse(runHook("Stop", event).stdout).decision).toBe("block");
  });

  test("hooks claude installs into Claude Code's user settings, keeping the rest", () => {
    const config = path.join(os.tmpdir(), `helix-claude-${process.pid}`);
    fs.mkdirSync(config, { recursive: true });
    const settings = path.join(config, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }));
    try {
      for (let i = 0; i < 2; i++) {
        expect(run(["node", HELIX, "hooks", "claude"], { cwd: root, env: { ...env(), CLAUDE_CONFIG_DIR: config } }).status).toBe(0);
      }
      const written = JSON.parse(fs.readFileSync(settings, "utf8"));
      expect(written.model).toBe("opus");
      /** @param {string} name */
      const commands = (name) => written.hooks[name].flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
      expect(commands("Stop")).toEqual(["other", `node ${JSON.stringify(HELIX)} hook stop || true`]);
      expect(commands("UserPromptSubmit")).toEqual([`node ${JSON.stringify(HELIX)} hook prompt || true`]);
    } finally {
      fs.rmSync(config, { recursive: true, force: true });
    }
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
      const proc = run(["node", HELIX, "hook", event], { cwd: root, input: "{not json", env: env() });
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

describe("briefs", () => {
  test("the implementer brief carries everything the subagent needs", () => {
    approvedPlan();
    helix(["learn", "Titles are semibold."]);
    const out = helix(["brief", "order", "implementer"]);
    const file = briefFile(out);
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
    const file = briefFile(helix(["brief", "order", "fixer"]));
    expect(fs.readFileSync(file, "utf8")).toMatch(/Behavior log \(attempt 1\): .*behavior-001\.log/);
  });

  test("planner briefs carry the engineer's plan feedback", () => {
    plan();
    helix(["submit-plan", "order", "--no-open"]);
    reply("split step 1 in two");
    helix(["feedback", "order", "--text", "split step 1 in two"]);
    expect(helix(["status", "order"])).toContain("helix brief order planner");
    const file = briefFile(helix(["brief", "order", "planner"]));
    const brief = fs.readFileSync(file, "utf8");
    expect(brief).toContain("split step 1 in two");
    expect(brief).toContain("work/checkpoints.json");
  });
});

describe("cli", () => {
  test("rejects unknown options and missing required flags", () => {
    expect(helix(["new", "order", "--goal", "g"], 1)).toContain("--reference is required");
    expect(helix(["status", "--bogus"], 1)).toContain("Unknown option --bogus");
  });
});
