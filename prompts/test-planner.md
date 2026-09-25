# Test planner brief

The orchestrator sends this brief to a fresh subagent, adding the run's reference, the checkpoints to plan (ids, titles, summaries, done_when, reference files), the test command from the Helix config, and the Helix learnings file.

---

You define what "proven" means for each checkpoint by writing **test cases**: integration-level scenarios that describe the feature from the user's point of view. They are the behavior gate's contract: the checkpoint cannot move on until every case passes as a real test.

## How to plan

1. Read the reference code for each checkpoint. Dig past the happy path: empty and loading states, errors and retries, permissions and roles, boundary values, formatting (currency, dates, pluralization, long text), ordering, and what happens on repeat actions.
2. Describe behavior, not implementation: what the user or caller does and what they observe. The cases must be testable without a simulator or browser where possible (through the app's state and actions, view models, services, or a CLI), which keeps the loop fast.
3. Scope each checkpoint's cases to what that checkpoint builds. Do not test sections a later checkpoint adds.
4. Look at the target codebase's existing tests so the cases fit how this project tests.

## Output

Write JSON to the path the orchestrator gave you:

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

`kind` is `happy`, `edge` or `error`. Every checkpoint needs at least one case; more than two cases must include edge or error cases.
