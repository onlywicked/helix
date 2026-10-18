# Helix

**An agent skill for large changes that one-shot generation gets wrong: small checkpoints, each held until it is proven.**

Inspired by [Shopify's Helix](https://shopify.engineering/helix), the checkpoint-and-gate workflow Shopify built for agent-driven migrations. This is an independent implementation.

Use it with Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot CLI, opencode, or any coding agent that can read instructions and run shell commands. It also ships as a Claude Code plugin for convenient installation.

Ask an agent to migrate a screen or rebuild a feature in one go and it hands back something that looks finished: most of it right, some of it subtly wrong, and too big to review. Helix does not expect the first attempt to be right. It splits the work into checkpoints you can approve at a glance, and no checkpoint moves on until its tests, its screenshots, two adversarial reviewers and you all agree it is right.

[![MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Agent skill](https://img.shields.io/badge/agent-skill-3b82f6.svg)](plugins/helix/skills/helix/SKILL.md)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://code.claude.com/docs/en/plugins)
[![Node 18+](https://img.shields.io/badge/node-18%2B-339933.svg)](https://nodejs.org)

---

## What it actually does

**Four gates per checkpoint, in order**

1. **Behavior**: the planned test cases, written as real tests, pass. The CLI runs them; no simulator or browser is needed.
2. **UI review**: a context-isolated reviewer compares screenshots of the implementation and the reference in the same state, limited to what the checkpoint built. Every fixable difference blocks. If the screenshots show different states, the pair is rejected as `INVALID`.
3. **Adversarial review**: two independent, context-isolated reviewers check the checkpoint's diff against your written guidelines. Any finding blocks.
4. **Engineer**: you approve or give feedback. You can grant autonomy for N checkpoints or for the whole run.

Every checkpoint ends in a commit whose message records what each gate proved. The evidence (test logs, UI reviews with screenshots, reviewer verdicts and findings) is shown in the viewer and archived by commit hash, so it outlives the worktree.

**Rules the agent cannot argue with**

Rules written in a prompt are only advice. Helix makes them mechanical:

- **The CLI produces every verdict.** It runs the tests and launches the reviewers itself, as separate read-only processes, so the orchestrating agent never writes one.
- **Verdicts are bound to the tree.** Each one is tied to a fingerprint of the working tree; any change makes earlier gates stale. `helix commit` refuses unless every gate passed on the exact tree being committed, and undoes a commit if a git hook changed its content.
- **A Stop hook keeps the session working** while a run is planning or building, and feeds back the next required action. After 3 stop attempts with no progress, the run is marked `stalled` and the session may stop.
- **Only you approve.** A prompt hook records your replies. `helix approve` fails unless you actually replied after approval was requested, and the approval is void if the code changed while you were looking.
- **Every subagent starts clean.** `helix brief <run> <role>` writes a self-contained brief with every input the subagent needs.

**Review findings that do not go in circles**

- Findings keep their id across attempts. The fixer answers each one: fixed, or disputed with evidence.
- When a reviewer raises a finding again in new words without saying so, a finding matcher (another isolated process) links it to the original, so its history is kept.
- A finding raised again after a dispute, or 3 times, comes to you for a ruling (`helix rule`). Your ruling is final.

**It learns**

- Your feedback goes into `.helix/learnings.md`, committed with the code, which every agent and reviewer reads.
- Findings fixed in one checkpoint go into the briefs of the next ones, so the implementer does not make the same mistake twice.
- When a fixed problem comes back in a later checkpoint anyway, Helix proposes a learning for it. It is saved only if you agree.

---

## Install

The skill runs inside the agent you are talking to; it is not a background service.

### Codex and other coding agents

The complete skill lives in [`plugins/helix/skills/helix/`](plugins/helix/skills/helix/). Keep that folder intact (`SKILL.md`, `prompts/`, `scripts/`). Below, `<skill>` is wherever that folder ends up.

- **With [skills.sh](https://skills.sh):** `npx skills add onlywicked/helix` copies it into each agent's skill directory.
- **By hand:** link or copy the folder where your agent looks for skills (`~/.agents/skills/helix` for Codex and most others, `~/.claude/skills/helix` for Claude Code).
- **Any coding agent with file access:** leave the repository in your workspace and ask the agent to read `plugins/helix/skills/helix/SKILL.md` and follow it.

Then install the hooks once, from wherever the skill now lives:

| Agent | Hooks |
|---|---|
| Claude Code (as a skill) | `node <skill>/scripts/helix.mjs hooks claude` |
| Codex | `node <skill>/scripts/helix.mjs hooks codex`, then trust them in Codex (`/hooks`) |
| Gemini CLI | `node <skill>/scripts/helix.mjs hooks gemini` |
| Cursor | `node <skill>/scripts/helix.mjs hooks cursor` |
| GitHub Copilot CLI | `node <skill>/scripts/helix.mjs hooks copilot` |
| opencode, others | none needed: the agent relays your replies with `helix reply` |

Hooks are installed in your user-level agent config, never in the repository. They do nothing outside a Helix run.

**Agents without hooks.** Helix still works, with two differences:

- The agent relays each of your replies word for word with `helix reply`. The viewer and the commit messages label those replies as relayed.
- Nothing forces the agent to keep going: it loops on `helix status` by itself.

### Claude Code plugin

```bash
/plugin marketplace add onlywicked/helix
```
```bash
/plugin install helix@helix
```

The plugin brings the skill and both hooks; there is nothing else to set up. Use it by describing what you want, or invoke it directly:

```
/helix:helix
```

If the install summary says `Run /reload-plugins to activate.`, run that.

To hack on Helix without installing:

```bash
claude --plugin-dir ./plugins/helix
```

## First run

In your agent, in the repository you want to change:

```
/helix Migrate the Order Details screen from app/legacy/OrderDetails.tsx into the native app...
```

With the Claude Code plugin the command is `/helix:helix`. In agents without slash commands, say "use the helix skill to ...".

The first time, the agent sets Helix up with you. It asks only for what it cannot find in the repository: the test command, the guidelines documents reviewers enforce, any design documents, and how to screenshot both apps. Adversarial review is only as good as those guidelines; if you have none, the agent offers to draft them from the existing code.

Helix then stops for you at these points:

- **The plan.** You approve the checkpoint plan in the viewer.
- **Each checkpoint.** You approve it, unless you granted autonomy.
- **The finished feature.** You test it end to end; your feedback becomes new checkpoints, or you approve it and the run is finished.

## Steering a run

Tell the agent in your own words; it runs the matching command.

| You say | The agent runs |
|---|---|
| "do the next 3 without asking" | `helix autonomy <run> --checkpoints 3` |
| "run it all / overnight" | `helix autonomy <run> --all` (gates stay exactly as strict) |
| "ask me again" | `helix autonomy <run> --off` |
| "stop / pause" | `helix pause <run>`; later `helix resume <run>` |
| a lasting preference ("we never use X") | `helix learn '<rule>'` |
| "skip the visual check for this one" | `helix waive <run> ui --reason '<your words>'` (only the UI gate can be waived) |

Plan approval always needs you. To work on several screens at once, start one run per screen, each in its own git worktree.

## Handing a run to a teammate

Every checkpoint commit carries the run in `.helix/runs/<run>.json`: the goal and reference, the plan, test cases, the engineer's decisions and approvals, and the review findings. To continue someone else's run, check out their branch and run:

```
helix status          # lists the runs on this branch you can pick up
helix claim <run>     # takes one over from its last checkpoint commit
```

The run continues with the next checkpoint, in your session. Briefs are rebuilt on your machine from the run, so they carry your paths and the latest learnings. Evidence (test logs, screenshots, reviewer output) stays on the machine that produced it; the commit messages record what each gate proved. Handing back works the same way: once you have committed more checkpoints, the original engineer pulls and claims the run again.

A run has one owner at a time; two people building the same run in parallel would mean two branches, and so two runs. When the engineer accepts the finished feature, Helix removes the run file in a commit of its own (`helix(<run>): close the run`), so it never reaches `main`. History keeps it.

## Requirements

| | Why | Notes |
| --- | --- | --- |
| **Node.js 18+** | the Helix CLI | Plain JavaScript, no dependencies, no build step. |
| **git** | every checkpoint ends in a commit | |
| **A reviewer CLI** | the UI and review gates | `claude` or `codex`. `helix init` warns when the configured one is missing. Any other model plugs in through the `exec` backend. |

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
- `.helix/runs/<run>.json`: an unfinished run's plan and progress, committed with each of its checkpoints so a teammate can pick it up (see Handing a run to a teammate). Accepting the feature removes it.
- `.helix/learnings.md`: the engineers' lasting feedback, one rule per line. A learning recorded during a run is committed with its checkpoint, so it reaches the team when that branch merges, and a teammate can push back on it in review like any guideline change. Learnings recorded in your other worktrees apply right away, before they are merged.

Gates ignore `.helix/`: editing a team file never invalidates a gate, and reviewers never see it in the diff.

Everything else stays out of the working tree, so formatters, linters and test runners never see it:

- `<git common dir>/helix/config.local.json`: your own overrides of the team config, such as a reviewer CLI only you have. Never committed.
- `<git common dir>/helix/evidence/<commit>/`: the evidence of each committed checkpoint.
- `<git dir>/helix/runs/<run>/`: state, evidence, briefs, work files and the viewer. Each worktree has its own, so parallel runs in separate worktrees stay isolated.

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
| `reviewers.matcher` | Backend that decides which new review findings repeat earlier ones. |

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

The prompts spell out the exact JSON to return. Use `exec` to plug in any model; Shopify's Helix uses Gemini as its UI reviewer.

Environment:

- `HELIX_NO_OPEN=1`: the CLI never opens the viewer (headless runs).
- `HELIX_SESSION_ID`: identifies the agent session for harnesses that export no session id of their own. Claude Code's and Codex's own session ids take precedence, so an agent cannot pose as another session.

## What is in here

```
.claude-plugin/marketplace.json   Claude Code marketplace listing this repository's plugin
plugins/helix/
├── .claude-plugin/plugin.json    the plugin
├── hooks/hooks.json              the plugin's Stop and prompt hooks
└── skills/helix/                 the skill: everything an agent needs, nothing else
    ├── SKILL.md                  orchestrator playbook
    ├── prompts/                  subagent briefs (planner, test planner, test writer, implementer, fixer)
    │                             and the prompts of the processes the CLI launches
    │                             (ui-reviewer, code-reviewer, finding-matcher)
    └── scripts/
        ├── helix.mjs             CLI entry point
        ├── viewer.html           live viewer
        ├── lib/                  state, gates' building blocks, reviewers, hooks, viewer data
        │   └── types.d.ts        types of the state and config, for the type checker only
        └── commands/             one module per group of commands
tests/                            end-to-end CLI tests (real git repos, fake reviewers, simulated hooks),
                                  one file per area, sharing tests/helpers.mjs
```

Development: run `npm install` (type definitions, TypeScript and the tests' `expect`), then `npm run check`: a strict type-check of the JavaScript through its JSDoc types, then the tests, one process per test file. The dev tooling stays at the repository root, outside the plugin, so installs never download it.

## The one rule that matters most

An attempt may be wrong; it may not move on until it is right. Every gate verdict comes from the CLI, bound to the exact tree it judged, and nothing in the loop lets the agent write or skip one. Only you can approve, waive the UI gate, or overrule a reviewer.

## Honest limitations

- **Reviews cost model calls.** Every review attempt runs two code reviewers, and the finding matcher when a reviewer's findings may repeat earlier ones; every UI attempt runs one reviewer per screenshot pair.
- **You capture the screenshots.** The UI gate compares what the agent captures, following your capture notes. It cannot drive a simulator or browser by itself.
- **One unfinished run per worktree.** Gates fingerprint the whole tree, so parallel runs need their own worktrees (`git worktree add`).
- **Skill installs need one extra step.** Copied or linked as a plain skill (including through skills.sh), Helix's hooks are installed once with `helix hooks <agent>`. Only the Claude Code plugin brings them itself.

## Credits

Inspired by [Shopify's Helix](https://shopify.engineering/helix): small checkpoints, each pushed through behavior tests, UI review, adversarial code review and the engineer before the next one starts. The implementation here is independent.

## Licence

MIT. See [LICENSE](LICENSE).
