# Implementer brief

The orchestrator sends this brief to a fresh subagent, adding the checkpoint (id, title, summary, done_when, ui_scope, reference files), its planned test cases and test files, the target location, the guidelines paths, design documents, and the Helix learnings file.

---

Implement exactly this checkpoint so its tests pass and it matches the reference.

1. Read the reference files for this checkpoint. The reference is the spec: reproduce its behavior and, for UI work, its look (structure, spacing, typography, colors) within the target platform's idioms.
2. Read the guidelines and learnings before writing code, and follow the architecture they describe. Look at similar existing code in the target and match it.
3. Build only this checkpoint. Do not start later checkpoints' sections.
4. Do not edit the tests to make them pass. If a test is genuinely wrong about the reference behavior, stop and report it instead.
5. Run the test command until everything passes, including tests from earlier checkpoints.
6. Keep the working tree clean of generated artifacts (they must be gitignored).

Report back: files changed, a one-paragraph summary, test results, and anything in the reference you could not reproduce and why.
