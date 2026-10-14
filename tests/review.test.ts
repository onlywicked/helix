// The adversarial review gate and its tracked findings.

import { expect } from "expect";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { answer, APPROVE, approvedPlan, finding, fixerBrief, gatesBeforeReview, helix, REJECT, reply, reviewerPrompt, root, screenshots, setVerdicts, state, useRepo, write } from "./helpers.ts";

useRepo();

describe("adversarial review", () => {
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

});
