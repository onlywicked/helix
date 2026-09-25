# Helix skill for Claude Code

A Claude Code implementation of [Shopify's Helix](https://shopify.engineering/helix): work is split into small checkpoints, and each checkpoint must pass four gates before the next one starts:

1. **Behavior**: planned test cases, written as real tests, pass (run by the CLI, no simulator or browser needed).
2. **UI review**: a context-isolated reviewer compares implementation and reference screenshots in the same state, scoped to what the checkpoint built. Every fixable difference blocks. Mismatched states are rejected as `INVALID`.
3. **Adversarial review**: two independent, context-isolated reviewers check the checkpoint's diff against your written guidelines. Any finding blocks.
4. **Engineer**: you approve or give feedback. Feedback is saved to the shared learnings file, which every agent and reviewer reads. You can grant autonomy for N checkpoints or the whole run.

Every checkpoint ends in a commit whose message records each gate's result. The evidence (test logs, UI reviews with screenshots, reviewer verdicts) is archived locally and linked from the viewer.

## How gates are enforced

Prose rules are advice; Helix makes them mechanical:

- `scripts/helix.ts` owns the run state. It runs the tests and launches the reviewers itself (`claude -p` with read-only tools and no project settings), so the orchestrating agent never writes a verdict.
- Each verdict is bound to a fingerprint of the working tree. Any code change makes earlier gates stale, and `helix commit` refuses unless every gate passed on the exact tree being committed.
- A **Stop hook** (the Ralph-loop idea) keeps the session working while a run is planning or building, and feeds back the next required action. After 3 stop attempts with no progress the run is marked `stalled` and the session may stop.
- A **UserPromptSubmit hook** records engineer replies. `helix approve` fails unless the engineer actually replied after approval was requested, and it is void if the code changed while they were looking.

The hooks are declared in `SKILL.md` and are armed when the skill is invoked. They are silent for sessions and repositories without a Helix run.

## Install

The skill runs in the agent you are talking to. It is not a background service: you invoke it in your session and the agent orchestrates the loop there.

```sh
# Claude Code (hooks are armed from SKILL.md when the skill runs)
ln -s "$(pwd)" ~/.claude/skills/helix

# Codex (and other agents that read ~/.agents/skills)
ln -s "$(pwd)" ~/.agents/skills/helix
bun scripts/helix.ts hooks codex    # once; then trust the hooks when Codex asks
```

Requirements: [Bun](https://bun.sh) (runs the TypeScript CLI directly, no dependencies), `git`, and the `claude` CLI for reviewers. Optional: `codex` CLI as a second-model reviewer.

## Use

In your agent (Claude Code, Codex, ...), in the target repository:

```
/helix Migrate the Order Details screen from app/legacy/OrderDetails.tsx into the native app...
```

Helix stops for you twice by default: to approve the checkpoint plan (shown in the run's viewer page, which `helix status` locates), and after each checkpoint (unless you grant autonomy). When everything is committed it asks you to test the whole feature, and your feedback becomes new checkpoints.

After resuming a Claude Code session (`claude --resume`), invoke `/helix` again to re-arm the hooks.

## Where Helix keeps its files

Nothing goes in the working tree, so formatters, linters and test runners never see Helix and its writes can never dirty the tree:

- `<git common dir>/helix/config.json` and `learnings.md`: shared by every worktree of the repository.
- `<git dir>/helix/runs/<run>/`: state, evidence, work files and `viewer.html`, per worktree, so parallel runs in separate worktrees stay isolated.

`helix status` prints the exact paths.

## Configuration

Created by `helix init`:

| Key | Meaning |
|---|---|
| `test_command` | Behavior gate command. Exit 0 = pass. A checkpoint may override it. |
| `guidelines` | Architecture and code standard documents the adversarial reviewers enforce. |
| `design` | Design documents for the UI reviewer. |
| `ui.enabled`, `ui.capture_notes` | UI gate switch; how to put both apps in a state and screenshot them. |
| `reviewers.ui` | UI reviewer backend. |
| `reviewers.code` | At least two independent code reviewers, each with a `lens` (`architecture`, `correctness`, `general`). |

Reviewer backends:

```json
{"backend": "claude", "model": "opus"}
{"backend": "codex"}
{"backend": "exec", "command": ["./tools/gemini-review.sh"]}
```

`exec` receives the prompt on stdin, the JSON schema path in `HELIX_SCHEMA_FILE` and screenshot paths in `HELIX_IMAGES`, and prints the verdict JSON on stdout. Use it to plug in Gemini, which Shopify uses for UI review because of its spatial accuracy.

Set `HELIX_NO_OPEN=1` to stop the CLI from opening the viewer in a browser (headless runs).

## Layout

```
SKILL.md                 orchestrator playbook + hook declarations
scripts/helix.ts         state machine, gates, reviewers, hooks, viewer rendering
scripts/viewer.html      viewer template
prompts/                 subagent briefs (planner, test planner, test writer, implementer, fixer)
                         and reviewer prompts used by the CLI (ui-reviewer, code-reviewer)
tests/helix.test.ts      end-to-end CLI tests (real git repos, fake reviewers, simulated hooks)
```

Development: `bun install` (type definitions only), then `bun run check` (strict type-check + tests).
