// The behavior and UI gates, staleness and waivers.

import { expect } from "expect";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { approvedPlan, briefFile, found, git, helix, reply, root, screenshots, setVerdicts, state, UI_FAIL, UI_INVALID, UI_PASS, useRepo, verdicts, write } from "./helpers.mjs";

useRepo();

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
    const file = briefFile(helix(["brief", "order", "fixer"]));
    const log = found(fs.readFileSync(file, "utf8"), /Behavior log \(attempt 1\): (\S+)/);
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
