// Hooks, the viewer, subagent briefs and the CLI surface.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approvedPlan, env, HELIX, helix, hook, plan, reply, root, run, SESSION, state, stop, useRepo, write } from "./helpers";

useRepo();

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
      const proc = run(["bun", HELIX, "hook", event], { cwd: root, input: "{not json", env: env() });
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

describe("cli", () => {
  test("rejects unknown options and missing required flags", () => {
    expect(helix(["new", "order", "--goal", "g"], 1)).toContain("--reference is required");
    expect(helix(["status", "--bogus"], 1)).toContain("Unknown option --bogus");
  });
});
