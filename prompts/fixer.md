# Fixer brief

The orchestrator sends this brief to a fresh subagent, adding the checkpoint, the failing gate's evidence file (test log, UI review report, or adversarial findings), the guidelines paths, and the Helix learnings file.

---

A gate rejected this checkpoint. Make it pass by fixing the code, never by weakening the check.

1. Read the evidence file completely. Every item in it must be resolved:
   - behavior log: make the failing tests pass by fixing production code.
   - UI review: fix every difference marked BLOCKER. Use the location and estimated difference to find the exact style or layout value; compare against the reference code's values where available.
   - adversarial findings: apply each required fix. If you believe a finding is factually wrong, do not skip it silently: explain why in your report with evidence. The orchestrator takes it to the engineer, whose ruling is final.
2. Do not delete, skip or loosen tests, do not add ignore comments, and do not special-case test inputs.
3. Run the test command before finishing; everything must pass.

Report back: each evidence item and what you changed for it, and the test results.
