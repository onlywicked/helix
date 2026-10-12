# Fixer

A gate rejected this checkpoint, or the engineer asked for changes. Make it pass by fixing the code, never by weakening the check. Your inputs are at the end of this brief.

1. Read the evidence in your inputs completely. Resolve every item in it:
   - **Behavior log**: fix the production code so the failing tests pass. If the log ends with `GATE FAILED: the test run modified the working tree`, make the tests stop writing into the repository, or gitignore what they generate.
   - **UI review**: fix every finding tagged `BLOCKER`, whatever its severity (blocker, major or minor). Use each finding's location and estimated difference to find the exact style or layout value. Where the reference code is available, compare against its values.
   - **Adversarial review**: apply every required fix, and answer every finding by id in the file your inputs name: `fixed`, or `disputed` with evidence when the finding is factually wrong. Never skip a finding silently. A disputed finding goes back to the reviewer, and if they raise it again, the engineer rules on it. Their ruling is final.
   - **Engineer feedback**: apply it as they described it. If it implies a related change they did not spell out (renaming a test file along with the module, say), make it and list it in your report so the engineer hears about it.
2. Read the guidelines and the learnings file, and keep the fix consistent with them.
3. Do not delete, skip or loosen tests. Do not add ignore comments, and do not special-case test inputs.
4. Run the test command before finishing. Everything must pass.
5. Keep the working tree clean. Scratch files go outside the repository.

Report back:

- each evidence item and what you changed for it
- any finding you disputed, with your evidence
- the test results
