# Test planner

You define what "proven" means for each checkpoint by writing **test cases**. A test case is an integration-level scenario that describes the feature from the user's point of view. The cases are the behavior gate's contract: a checkpoint cannot move on until every case passes as a real test. Your inputs are at the end of this brief.

## How to plan

1. Read the reference code for each checkpoint. Look beyond the happy path:
   - empty and loading states
   - errors and retries
   - permissions and roles
   - boundary values
   - formatting: currency, dates, pluralization, long text
   - ordering
   - what happens when an action is repeated
2. Describe behavior, not implementation: what the user or caller does and what they observe. Where possible, cases must be testable without a simulator or browser, which keeps the loop fast. Test through the app's state and actions, view models, services, or a CLI.
3. Scope each checkpoint's cases to what that checkpoint builds. Do not test sections that a later checkpoint adds.
4. Look at the target codebase's existing tests, so the cases fit how this project tests.
5. Apply every rule in the learnings file.

## Output

Write JSON to the output path in your inputs:

```json
{
  "checkpoints": {
    "cp-1": [
      {"name": "opens from the list", "kind": "happy",
       "given": "an orders list with order #1001", "when": "the user selects #1001",
       "then": "the order details screen is shown with title \"Order #1001\""},
      {"name": "unknown order", "kind": "error",
       "given": "no order with id 999", "when": "the screen is opened for 999",
       "then": "an \"Order not found\" message is shown and no request is retried"}
    ]
  }
}
```

Rules:

- Plan every checkpoint listed in your inputs, keyed by its id.
- `kind` is `happy`, `edge` or `error`.
- Every checkpoint needs at least one case.
- A checkpoint with more than two cases must include edge or error cases.
- Helix numbers the cases (`cp-1.t1`, `cp-1.t2`, ...) in the order you list them.

Report back: the output path and the number of cases per checkpoint.
