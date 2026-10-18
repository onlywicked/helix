// Planning: checkpoints, test plans and plan approval.

import { expect } from "expect";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { approvedPlan, briefFile, helix, input, plan, reply, root, state, useRepo, write } from "./helpers.mjs";

useRepo();

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
    const brief = fs.readFileSync(briefFile(helix(["brief", "order", "test-planner"])), "utf8");
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
    const file = briefFile(helix(["brief", "order", "test-planner", "--checkpoint", "cp-1"]));
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
