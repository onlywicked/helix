---
name: helix
description: Use when building, migrating, porting or refactoring a feature, screen or app with agents where quality must hold across many steps - e.g. rewriting React Native screens in Swift/Kotlin, rebuilding a screen from a reference app, prototype or designs, or any large change that one-shot generation would get wrong. Also use when the engineer mentions Helix, checkpoints, gates, or resuming a Helix run.
---

# Helix

Helix does not expect the first attempt to be right. It splits work into small **checkpoints** that the engineer approves at a glance. Each checkpoint then goes through four **gates** in order:

1. behavior tests
2. UI review against the reference
3. two adversarial code reviews
4. the engineer

An attempt may be wrong, but it cannot move on until it is right. Helix remembers the engineer's feedback, so the loop needs less oversight as it goes.

You are the **orchestrator**, working in the engineer's own session: they see your progress and answer when you stop. You coordinate. Fresh subagents do the reading and writing, so every task starts with a clean context.

## The CLI

The Helix CLI owns all state and produces every verdict. Run it with the full path to this skill's directory (the directory containing this SKILL.md; Claude Code calls it `${CLAUDE_SKILL_DIR}`):

```
node "<skill dir>/scripts/helix.mjs" <command>     # written `helix` below
```

- Pass the engineer's words in **single quotes** (``--goal 'Port the `cart` module'``, writing `'\''` for a literal `'`). Inside double quotes the shell would run backticks and `$(...)` from their text.
- `helix status` always prints the next required action.
- `helix <command> --help` documents a command's flags.
- Exit codes:
  - 0: success.
  - 1: the command was refused. Read the message; it says why and what to do.
  - 2: a gate ran and did not pass.
  - 3: the UI screenshots showed different states.

  Exit codes 2 and 3 are verdicts, not crashes: follow the printed `Next:`.

**Dispatching a subagent** always works the same way:

1. `helix brief <run> <role>` writes a complete brief and prints its path. The brief contains the role's instructions and every input the subagent needs (checkpoint, test case ids, test command, guidelines, learnings, evidence, output path).
2. Give a fresh subagent, using your harness's subagent tool, exactly this task: `Read <brief path> and do exactly what it says.`
3. Wait for the subagent to finish and read its report before the next step. Do not start the next role while one is still running. If your harness runs subagents in the background, wait for its completion notice; waiting is not stopping, and you continue from `helix status` when it arrives.
4. If your harness has no subagents, read the brief and do the task yourself, one brief at a time.

The roles are `planner`, `test-planner`, `test-writer`, `implementer` and `fixer`.

## What the CLI enforces

You do not have to argue about these; the CLI refuses to break them.

- **The CLI produces every gate verdict.** It runs the test command itself and launches the UI and code reviewers as isolated processes. Never write or edit a verdict, and never edit Helix's state files.
- **Every verdict is bound to a fingerprint of the working tree.** Any change to any file in the tree (code, tests, a stray screenshot) makes earlier gates `stale`, and they must run again. `helix commit` refuses unless every gate passed on the exact tree being committed.
- **Gates run in order:** behavior, then UI (UI checkpoints only), then adversarial review, then the engineer.
- **Engineer decisions need the engineer's message.** `approve`, `autonomy`, `waive` and `rule` work only after the engineer actually said something. Their messages reach Helix through a prompt hook, or through `helix reply` (see below).
- **Review findings are tracked by id** (`F1`, `F2`, ...) for the whole checkpoint. The review gate does not run again until the fixer has answered every open finding (`fixed`, or `disputed` with evidence). A finding raised again after a dispute, or raised 3 times, blocks the loop until the engineer rules on it.
- **The Stop hook does not let the session end while a run is `planning` or `building`.** Instead it returns the next required action. Stopping is allowed while the run waits for the engineer, is paused, or is done.

## Hooks

Helix uses two hooks:

- a **Stop hook**, which keeps the loop going;
- a **prompt hook**, which records the engineer's messages.

| Agent | Setup |
|---|---|
| Claude Code | Installed as a plugin: nothing to do, the plugin brings both hooks. Installed as a plain skill: `helix hooks claude` once. |
| Codex | `helix hooks codex` once, then trust the hooks when Codex asks (`/hooks`). |
| Gemini CLI | `helix hooks gemini` once. |
| Cursor | `helix hooks cursor` once. |
| GitHub Copilot CLI | `helix hooks copilot` once. |
| Any other agent with hooks | Run `helix hook stop` / `helix hook prompt` with the hook's JSON event on stdin. Protocol: input has `session_id`, `cwd`, and `prompt` (for the prompt hook). The stop hook prints `{"decision":"block","reason":...}` to continue. The prompt hook prints `hookSpecificOutput.additionalContext`. Both always exit 0. |

**Without a prompt hook** (opencode, or hooks not set up), relay every message the engineer sends after the run exists, before you act on it. The request that starts a run is its `--goal`, not a reply:

```
helix reply <run> --text '<their exact words>'
```

Relay it word for word. Never paraphrase, never relay anything they did not say, and never relay before they have answered. Helix marks relayed replies as relayed everywhere it shows them.

**Without a Stop hook**, nothing stops you from ending your turn early. Keep going on your own: after every step run `helix status` and continue until its next action starts with `STOP`.

If `helix approve` says no engineer reply was recorded, the prompt hook did not see their message: set the hooks up or relay it.

## One-time setup per repository

1. Run `helix status`. If Helix is not initialized, gather the following with the engineer. Ask only what you cannot find in the repo:
   - **Test command**: runs the behavior tests without a simulator or browser (exit 0 = pass).
   - **Guidelines**: documents describing the target architecture and UI code conventions. Adversarial review is only as good as this standard. If none exist, offer to draft one from the existing code, get the engineer's sign-off, and commit it before planning.
   - **Design** documents (design system, design.md) for the UI reviewer, if any.
   - **Screenshot capture**: how to screenshot the reference and the new implementation in a given state.
2. Run init:
   ```
   helix init --test-command "..." --guideline docs/architecture.md --design design.md --capture-notes "..."
   ```
   Use `--no-ui` for logic-only work.
3. If init warns that a reviewer CLI is missing, tell the engineer. Reviewers run on `claude` or `codex` by default. Another model can plug in through the `exec` backend; the README covers it.
4. Tell the engineer to commit `.helix/`, so everyone's agents share the config and the learnings.

The config and learnings live in `.helix/` and are committed with the code; a learning recorded during a run is committed with its checkpoint. Gates ignore `.helix/`, so recording a learning never invalidates a gate. Run state and evidence stay inside the git directory. `helix status` prints where everything lives.

## The loop

### 1. Plan (stop #1)

1. Create the run:
   ```
   helix new <name> --title '<short human title>' --goal '<what the engineer asked for>' --reference '<reference code, running app, prototype or designs>' --target '<where new code goes>'
   ```
   It prints the run's **work dir** (`<work>` below). Scratch files go there, never in the repository.
2. Dispatch the `planner`. If it returns questions instead of a plan, ask the engineer (`helix ask <run> '...'`, then stop).
3. `helix plan <run> --file <work>/checkpoints.json`. If the CLI rejects the plan, have the planner fix it and reload. The planner may list `decisions` for the engineer (for example, where the reference and the guidelines disagree). The CLI prints them, and the viewer shows them with the plan.
4. Dispatch the `test-planner`, then `helix tests <run> --file <work>/tests.json`.
5. `helix submit-plan <run>` opens the viewer. Tell the engineer in two or three lines what the plan covers, list any decisions they need to make, and say that the plan is in the viewer. Then **stop**.
6. When they reply (without a prompt hook, first relay it: `helix reply <run> --text '<their exact words>'`):
   - If they approve: `helix approve <run>`.
   - Otherwise: `helix feedback <run> --text '<their words>' [--learning '<general lesson>']`. Dispatch the planner again (its brief now carries their feedback), then repeat steps 3 to 5.

### 2. Build each checkpoint

`helix status <run>` names the current checkpoint and the next action. For the current checkpoint:

1. **Behavior gate.** Dispatch the `test-writer`, then the `implementer`, then run `helix gate behavior <run>`. On failure, dispatch the `fixer` and rerun. Iterate on behavior as often as needed before taking any screenshot.
   - If the implementer reports that a planned test contradicts the reference, take it to the engineer with `helix ask`. Never weaken the test yourself.
2. **UI gate** (checkpoints marked `ui`).
   1. Put the reference and the implementation in the **same state**: same data, same scroll position, same device size. Follow the capture notes in the Helix config.
   2. Screenshot both into `<work>/shots/`, never into the repository. Web: Playwright. iOS: `xcrun simctl io booted screenshot`. Android: `adb exec-out screencap -p`.
   3. Run `helix gate ui <run> --pair <ref.png> <impl.png> "<state>"`. Repeat `--pair` for several states.

   The reviewer compares only the checkpoint's `ui_scope`. On the result:
   - `FAIL`: dispatch the fixer, rerun the behavior gate, recapture, rerun the UI gate.
   - `INVALID`: the screenshots show different states or sections. Recapture both in the same state; the code is not the problem.
   - No comparable reference exists (designs only, the reference app cannot run): ask the engineer. If they agree, run `helix waive <run> ui --reason '<their words>'`.
3. **Adversarial review gate.** `helix gate review <run>`. Two context-isolated reviewers check the checkpoint's diff against the guidelines and learnings. Any finding fails the gate. Each finding gets an id that it keeps for the whole checkpoint, so one raised again is visibly the same finding. Then:
   1. Dispatch the fixer. It fixes each finding, or disputes it with evidence, and writes its answers to the file its brief names.
   2. Rerun the behavior gate, and the UI gate if anything visible changed.
   3. Run the review gate again. Each reviewer sees its own open findings with the fixer's answers, and drops the ones that are fixed.

   Repeat until both reviewers approve. If the reviewers and the fixer go in circles (a disputed finding raised again, or one raised 3 times), the CLI stops the loop:
   1. Ask the engineer to rule: `helix ask <run> --finding <id>` (repeat for each stuck finding) records a question quoting each finding and the fixer's answer. Put that question to them, then stop. `helix findings <run>` prints the full history.
   2. On their answer, record it: `helix rule <run> <id> fix --text '<their words>'` (the reviewer is right; the fixer must fix it) or `helix rule <run> <id> drop --text '<their words>'` (the finding is wrong; it never blocks again). Add `--learning '<rule>'` when the ruling applies beyond this finding and the guidelines do not already say it.
   3. Continue from `helix status <run>`.
4. **A gate `ERROR`** means a reviewer crashed, timed out or is not installed. It is not a finding, so never dispatch the fixer for it. Read the `*.raw.txt` next to the evidence, fix the setup or tell the engineer, then rerun the gate.
5. **Engineer gate** (stop). `helix request-approval <run>`.
   - In autonomous mode the CLI approves the checkpoint and you continue to commit.
   - Otherwise, tell the engineer in a few lines what the checkpoint does, how to see it running, and the evidence (attempt counts, UI review, reviewer verdicts). Then **stop**.
   - If it lists **recurring problems** (fixed in an earlier checkpoint, then made again), propose a one-line learning for each. Save only those the engineer agrees to, with `helix learn '<rule>'`.

   When they reply (without a prompt hook, relay it first with `helix reply`):
   - Approval: `helix approve <run>`.
   - Feedback: run `helix feedback <run> --text '<their words>' --learning '<the general rule behind it>'`. Then dispatch the fixer and run the gates again from behavior.
     - `--text` is their words, verbatim. `--learning` is your one-line generalization of them, written so it applies to future checkpoints and not just this one.
     - If the feedback changes what the checkpoint should do, re-plan its test cases first: `helix brief <run> test-planner --checkpoint <id>`, then `helix tests`.
     - If the feedback also applies to code from earlier checkpoints, the fix goes into the current checkpoint. Its reviewers see it in the diff.
6. `helix commit <run>` commits the checkpoint with its evidence and starts the next one.
   - If your harness or the engineer requires commit trailers, add `--trailer 'Key: value'` (repeatable).
   - If a git commit hook rewrites files, Helix undoes the commit. Rerun the gates on the hook's changes and commit again.

### 3. Final review (stop #2)

When the last checkpoint is committed, the run is `done`. Ask the engineer to test the whole feature, telling them in a few lines:

- the commits
- how to run it end to end
- what differs from the reference on purpose
- anything left for later, such as removing the legacy code

Then **stop**. When they reply (without a prompt hook, relay it first with `helix reply`):

- If they accept it: `helix approve <run>`. The run is finished.
- Otherwise:
  1. `helix feedback <run> --text '<their words>'`.
  2. Dispatch the `planner`; its brief now asks for new checkpoints.
  3. `helix add <run> --file <work>/checkpoints.json`, then the `test-planner` and `helix tests <run> --file <work>/tests.json`.
  4. Continue the loop.

## Engineer controls

| Engineer says | You run |
|---|---|
| "do the next 3 without asking" | `helix autonomy <run> --checkpoints 3` |
| "run it all / overnight" | `helix autonomy <run> --all` (gates stay exactly as strict) |
| "ask me again" | `helix autonomy <run> --off` |
| "stop / pause" | `helix pause <run>`; later `helix resume <run>` |
| a lasting preference ("we never use X") | `helix learn '<rule>'` |
| "skip the visual check for this one" (no comparable reference or device) | `helix waive <run> ui --reason '<their words>'` (only the UI gate can be waived) |
| work on several screens at once | one run per screen, each in its own git worktree (`git worktree add`). A worktree holds one unfinished run, since gates fingerprint its whole tree |

Plan approval always needs the engineer.

One reply can carry several instructions, such as "approved, and do the next two without asking". Handle all of them, approval first. When an approval also settles a lasting rule (a plan decision, a convention), record it with `helix learn` as well.

## Resuming

If the session was resumed or restarted:

1. Make sure the hooks are active (see Hooks).
2. Run `helix claim <run>`. In Claude Code and Codex, or with `HELIX_SESSION_ID` exported, it gives the run to your session. Otherwise it releases the run, and the next message the engineer sends through a prompt hook gives it to this session.
3. Run `helix status` and continue from the printed next action.

If a run is `stalled`, tell the engineer what blocked you, and run `helix resume <run>` when they reply.

## Red flags: stop and correct course

| Thought | Reality |
|---|---|
| "The UI difference is tiny, good enough" | Fixable differences are blockers. Fix it and rerun the gate. |
| "This reviewer finding is wrong, I'll just commit" | You cannot commit past a failed gate. Have the fixer dispute it with evidence. If the reviewer raises it again, the engineer rules on it with `helix rule`; only their ruling overrides a reviewer. |
| "Tests fail for an unrelated reason, I'll adjust the test" | Weakening tests is forbidden. Fix the code, or ask the engineer with `helix ask`. |
| "I'll screenshot a different state, it's close enough" | That earns `INVALID`. Put both apps in the same state. |
| "I'll save the screenshots next to the code" | Any file in the working tree makes the gates stale and would be committed. Use `<work>/shots/`. |
| "The engineer would approve this, I'll run approve" | `approve` needs their actual reply. Stop and ask. |
| "I'll relay a summary of what they meant" | Relay their exact words, and only after they said them. |
| "I'll build checkpoints 2 and 3 together to save time" | One checkpoint at a time. Its gates pass before the next starts. |
| "I'll write this code myself instead of a subagent" | If your harness has subagents, dispatch one. Your context is for coordination across the whole run. |
