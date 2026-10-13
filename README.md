# Helix

An agent skill implementing [Shopify's Helix](https://shopify.engineering/helix). It works in any coding agent that can run shell commands: Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot CLI, opencode, and others.

Helix splits the work into small checkpoints. Each checkpoint must pass four gates before the next one starts:

1. **Behavior**: the planned test cases, written as real tests, pass. The CLI runs them; no simulator or browser is needed.
2. **UI review**: a context-isolated reviewer compares screenshots of the implementation and the reference in the same state, limited to what the checkpoint built. Every fixable difference blocks. If the screenshots show different states, the pair is rejected as `INVALID`.
3. **Adversarial review**: two independent, context-isolated reviewers check the checkpoint's diff against your written guidelines. Any finding blocks. Findings keep their id across attempts; the fixer answers each one (fixed, or disputed with evidence), and a finding that keeps coming back after a dispute, or 3 times, comes to you for a ruling (`helix rule`).
4. **Engineer**: you approve or give feedback. Feedback goes into the team's learnings file, committed with the code, which every agent and reviewer reads. You can grant autonomy for N checkpoints or for the whole run.

Every checkpoint ends in a commit whose message records what each gate proved. The evidence (test logs, UI reviews with screenshots, reviewer verdicts and findings) is shown in the viewer and archived by commit hash, so it outlives the worktree.

## How gates are enforced

Rules written in a prompt are only advice. Helix makes them mechanical:

- `scripts/helix.ts` owns the run state. It runs the tests and launches the reviewers itself, as separate read-only processes, so the orchestrating agent never writes a verdict.
- Each verdict is bound to a fingerprint of the working tree. Any change makes earlier gates stale. `helix commit` refuses unless every gate passed on the exact tree being committed, and it undoes a commit if a git hook changed its content.
- A **Stop hook** (the Ralph-loop idea) keeps the session working while a run is planning or building, and feeds back the next required action. After 3 stop attempts with no progress, the run is marked `stalled` and the session may stop.
- A **prompt hook** records the engineer's replies. `helix approve` fails unless the engineer actually replied after approval was requested. The approval is void if the code changed while they were looking.
- Subagents get their instructions from `helix brief <run> <role>`. It writes a self-contained brief with every input the subagent needs, so the orchestrator never has to assemble them and each subagent starts with a clean context.

## Install

The skill runs inside the agent you are talking to; it is not a background service. Link this directory where your agent looks for skills, then set up the hooks.

| Agent | Skill location | Hooks |
|---|---|---|
| Claude Code | `ln -s "$(pwd)" ~/.claude/skills/helix` | armed from `SKILL.md` when the skill runs |
| Codex | `ln -s "$(pwd)" ~/.agents/skills/helix` | `bun scripts/helix.ts hooks codex`, then trust them in Codex (`/hooks`) |
| Gemini CLI | `ln -s "$(pwd)" ~/.agents/skills/helix` | `bun scripts/helix.ts hooks gemini` |
| Cursor | `ln -s "$(pwd)" ~/.agents/skills/helix` | `bun scripts/helix.ts hooks cursor` |
| GitHub Copilot CLI | `ln -s "$(pwd)" ~/.agents/skills/helix` | `bun scripts/helix.ts hooks copilot` |
| opencode, others | `~/.agents/skills/helix` | none needed: the agent relays your replies with `helix reply` |

Hooks are installed in your user-level agent config, never in the repository. They do nothing outside a Helix run.

**Agents without hooks.** Helix still works, with two differences:

- The agent relays each of your replies word for word with `helix reply`. The viewer and the commit messages label those replies as relayed.
- Nothing forces the agent to keep going: it loops on `helix status` by itself.

Requirements:

- [Bun](https://bun.sh), which runs the TypeScript CLI directly with no dependencies
- `git`
- a reviewer CLI: `claude` or `codex` (`helix init` warns when the configured one is missing)

## Use

In your agent, in the target repository:

```
/helix Migrate the Order Details screen from app/legacy/OrderDetails.tsx into the native app...
```

Or say "use the helix skill to ..." in agents without slash commands.

Helix stops for you at these points:

- **The plan.** You approve the checkpoint plan in the viewer.
- **Each checkpoint.** You approve it, unless you granted autonomy.
- **The finished feature.** You test it end to end; your feedback becomes new checkpoints, or you approve it and the run is finished.

## The viewer

`helix status` prints the path to each run's viewer, `viewer.html`. It is a static page that follows the run live; there is nothing to reload. It shows:

- what the agent is doing now, or what it is waiting for from you
- a progress bar across all checkpoints
- for each checkpoint, its four gates, with every attempt's outcome
- the evidence behind each verdict: test log tail, reference and implementation screenshots side by side with the reviewer's findings, and code review findings
- the planned test cases and the activity log

## Where Helix keeps its files

The team files are committed with the code, so every engineer's agents apply the same config and learnings:

- `.helix/config.json`: the team config (see Configuration).
- `.helix/learnings.md`: the engineers' lasting feedback, one rule per line. A learning recorded during a run is committed with its checkpoint, so it reaches the team when that branch merges, and a teammate can push back on it in review like any guideline change. Learnings recorded in your other worktrees apply right away, before they are merged.

Gates ignore `.helix/`: editing a team file never invalidates a gate, and reviewers never see it in the diff.

Everything else stays out of the working tree, so formatters, linters and test runners never see it:

- `<git common dir>/helix/config.local.json`: your own overrides of the team config, such as a reviewer CLI only you have. Never committed.
- `<git common dir>/helix/evidence/<commit>/`: the evidence of each committed checkpoint.
- `<git dir>/helix/runs/<run>/`: state, evidence, briefs, work files and the viewer. Each worktree has its own, so parallel runs in separate worktrees stay isolated. A worktree holds one unfinished run at a time, since gates fingerprint its whole tree.

`helix status` prints the exact paths.

## Configuration

Created by `helix init` in `.helix/config.json`. Commit it. Keys set in `<git common dir>/helix/config.local.json` override it for you alone; objects such as `reviewers` merge key by key.

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

The `exec` backend works like this:

- It receives the prompt on stdin.
- `HELIX_SCHEMA_FILE` holds the path to the JSON schema.
- `HELIX_IMAGES` holds the screenshot paths, separated by `:`.
- It prints the verdict JSON on stdout.

The prompts spell out the exact JSON to return. Use `exec` to plug in any model. Shopify uses Gemini for UI review because of its spatial accuracy.

Environment:

- `HELIX_NO_OPEN=1`: the CLI never opens the viewer (headless runs).
- `HELIX_SESSION_ID`: identifies the agent session for harnesses that export no session id of their own. Claude Code's and Codex's own session ids take precedence, so an agent cannot pose as another session.

## Layout

```
SKILL.md                 orchestrator playbook (+ Claude Code hook declarations)
scripts/helix.ts         state machine, gates, reviewers, briefs, hooks for every agent, viewer data
scripts/viewer.html      live viewer
prompts/                 subagent briefs (planner, test planner, test writer, implementer, fixer)
                         and reviewer prompts (ui-reviewer, code-reviewer)
tests/                   end-to-end CLI tests (real git repos, fake reviewers, simulated hooks),
                         one file per area, sharing tests/helpers.ts
```

Development: run `bun install` (type definitions only), then `bun run check` (strict type-check, then the tests, one worker per test file).
