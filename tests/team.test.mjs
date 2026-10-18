// Where Helix keeps its files, and what a team shares.

import { expect } from "expect";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  approvedPlan, briefFile, env, git, HELIX, helix, reply, reviewerPrompt, root, run, scratch, screenshots, SESSION, state, stop, useRepo,
  useRoot, write,
} from "./helpers.mjs";

useRepo();

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
    const inLinked = (/** @type {string[]} */ args) => {
      const proc = run(["node", HELIX, ...args], { cwd: linked, env: env() });
      expect(proc.status).toBe(0);
      return proc.stdout + proc.stderr;
    };
    expect(inLinked(["status"])).toContain("No Helix runs");
    inLinked(["new", "screen", "--goal", "g", "--reference", "r"]);
    expect(inLinked(["status"])).toContain("Run screen");
    expect(inLinked(["status"])).not.toContain("Run order");
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
    useRoot(teammate);
    try {
      fs.mkdirSync(path.join(root, ".git/helix"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git/helix/config.local.json"), JSON.stringify({ test_command: "sh -c 'exit 3'" }));
      expect(helix(["status"])).toContain("with your overrides in");
      approvedPlan({ ui: false, count: 1 });
      write("app.py", "VALUE = 2\n");
      expect(helix(["gate", "behavior", "order"], 2)).toContain("exited 3");
      expect(fs.readFileSync(path.join(root, ".helix/config.json"), "utf8")).toContain("fake_reviewer.mjs");
    } finally {
      useRoot(original);
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
    run(["node", HELIX, "learn", "New rule."], { cwd: linked, env: env() });
    approvedPlan();
    const brief = fs.readFileSync(briefFile(helix(["brief", "order", "implementer"])), "utf8");
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
    expect(out).toContain("Moved 1 learning from");
    expect(fs.existsSync(path.join(root, ".git/helix/config.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".git/helix/learnings.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".helix/config.json"), "utf8")).toContain("fake_reviewer.mjs");
    expect(fs.readFileSync(path.join(root, ".helix/learnings.md"), "utf8")).toContain("- Titles are semibold.");
  });
});

describe("handing a run over", () => {
  /**
   * Builds the current checkpoint as `code`, takes it through every gate and commits it, all as `session`.
   * @param {string} code
   */
  function commitCheckpoint(code, session = SESSION) {
    write("app.py", code);
    helix(["gate", "behavior", "order"], 0, session);
    if (state().current === "cp-1") {
      const [ref, impl] = screenshots();
      helix(["gate", "ui", "order", "--pair", ref, impl, "loaded order"], 0, session);
    }
    helix(["gate", "review", "order"], 0, session);
    helix(["request-approval", "order"], 0, session);
    reply("ship it", session);
    helix(["approve", "order"], 0, session);
    helix(["commit", "order"], 0, session);
  }

  test("a teammate picks a run up from the branch, and it comes back once they committed more", () => {
    approvedPlan();
    commitCheckpoint("VALUE = 2\n");
    const shared = JSON.parse(git("show", "HEAD:.helix/runs/order.json"));
    expect(shared.checkpoints.map((/** @type {any} */ cp) => cp.status)).toEqual(["committed", "in_progress"]);
    expect(shared.owner_session).toBeUndefined(); // sessions belong to one machine
    expect(shared.last_prompt).toBeUndefined();
    const original = root;
    const teammate = path.join(scratch, "teammate");
    git("clone", "-q", root, teammate);
    useRoot(teammate);
    try {
      const mate = "teammate-session";
      expect(helix(["status"], 0, mate)).toContain("pick it up with `helix claim order`");
      expect(helix(["new", "other", "--goal", "g", "--reference", "r"], 1, mate)).toContain("Run 'order' on this branch is unfinished");
      expect(helix(["claim", "order"], 0, mate)).toContain("Picked up run 'order' from the branch: 1 of 2 checkpoints committed.");
      const head = git("rev-parse", "HEAD").trim();
      expect(state()).toMatchObject({ owner_session: mate, goal: "Order screen", current: "cp-2" });
      expect(state().checkpoints[0].commit).toBe(head);
      expect(state().checkpoints[1].base).toBe(head);
      expect(fs.readFileSync(briefFile(helix(["brief", "order", "implementer"], 0, mate)), "utf8")).toContain("### cp-2: Step 2");
      expect(stop(mate).decision).toBe("block"); // the hooks guard the teammate's session now
      commitCheckpoint("VALUE = 2  # step two\n", mate);
    } finally {
      useRoot(original);
    }
    git("pull", "-q", teammate, "HEAD");
    expect(helix(["status"])).toContain("pick it up with `helix claim order`");
    expect(helix(["claim", "order"])).toContain("2 of 2 checkpoints committed. It replaces this clone's older copy.");
    expect(state()).toMatchObject({ status: "done", awaiting: { kind: "final" } });
  });

  test("accepting the feature removes the run file in a commit of its own", () => {
    approvedPlan({ count: 1 });
    commitCheckpoint("VALUE = 2\n");
    write("notes.txt", "unrelated\n");
    git("add", "notes.txt");
    reply("accepted, thanks");
    expect(helix(["approve", "order"])).toContain("The feature is accepted.");
    expect(git("log", "-1", "--format=%s")).toBe("helix(order): close the run\n");
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe(".helix/runs/order.json");
    expect(fs.existsSync(path.join(root, ".helix/runs/order.json"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("A  notes.txt\n"); // the engineer's staged work is left alone
  });
});
