// Engineer approval, commits and finishing a run.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { approvedPlan, git, helix, input, passAllGates, reply, root, screenshots, state, stop, useRepo, write } from "./helpers";

useRepo();

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
