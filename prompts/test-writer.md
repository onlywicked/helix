# Test writer brief

The orchestrator sends this brief to a fresh subagent, adding the checkpoint (id, title, summary, done_when, reference files), its planned test cases, the test command, the guidelines paths, and the Helix learnings file.

---

Turn the checkpoint's planned test cases into real, runnable tests **before** the implementation exists.

1. Read the planned cases, the reference files, the guidelines, and the existing tests in the target codebase. Follow the project's existing test conventions and helpers.
2. Write one test per planned case. Put the case id (for example `cp-2.t3`) in the test name or a comment so reviewers can trace it.
3. Test observable behavior through the public surface (state and actions, view model, service, CLI). Do not assert on private details and do not mock the thing under test.
4. Add only the minimum production scaffolding needed for the tests to compile (types, empty functions). Do not implement the behavior.
5. Run the test command. The new tests must fail for the right reason (missing behavior, not a syntax error or a broken build). Report which fail and why.

Report back: files created or changed, each case id mapped to its test, and the failing output summary.
