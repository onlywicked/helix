---
name: helix
description: Use when building, migrating, porting or refactoring a feature, screen or app with agents where quality must hold across many steps - e.g. rewriting React Native screens in Swift/Kotlin, rebuilding a screen from a reference app, prototype or designs, or any large change that one-shot generation would get wrong. Also use when the engineer mentions Helix, checkpoints, gates, or resuming a Helix run.
hooks:
  Stop:
    - hooks:
        - type: command
          command: "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/helix.ts\" hook stop || true"
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/helix.ts\" hook prompt || true"
---

# Helix

Helix does not expect the first attempt to be right. It splits work into small **checkpoints** the engineer approves at a glance, then pushes each checkpoint through four **gates** in order: behavior tests, UI review against the reference, two adversarial code reviews, and the engineer. An attempt may be wrong; it may not move on until it isn't. Engineer feedback is remembered, so the loop needs less oversight as it goes.

You are the **orchestrator**, working in the engineer's own session: they see your progress and answer your stops directly. You coordinate; fresh subagents do the reading and writing so every task starts with a clean context. "Dispatch a subagent" means your harness's subagent tool (Claude Code: Agent; Codex: spawning an agent). If your harness has none, do that task yourself, reading only what its brief lists. The Helix CLI owns all state and produces every verdict:

```
bun "${CLAUDE_SKILL_DIR}/scripts/helix.ts" <command>      # referred to as `helix` below
```

`${CLAUDE_SKILL_DIR}` is the directory containing this SKILL.md; substitute it if your agent does not. Always use the full path. `helix status` always prints the next required action; `helix <command> --help` documents flags.

## What the CLI enforces (so you don't have to argue about it)

- Gate verdicts come from the CLI: it runs the test command itself and launches the UI and code reviewers as isolated processes. You never write or edit a verdict, and never edit Helix's state files.
- Every verdict is bound to a fingerprint of the working tree. Any code or test change makes earlier gates `stale`; they must run again. `helix commit` refuses unless every gate passed on the exact tree being committed.
- Gates run in order: behavior, then UI (UI checkpoints only), then adversarial review, then the engineer.
- `helix approve` only works after the engineer actually replied (a hook records their messages). You cannot approve on their behalf.
- The Stop hook will not let the session end while a run is `planning` or `building`. It returns the next required action instead. Stopping is allowed while the run waits for the engineer, is paused, or is done.

## Hooks by agent

Helix needs two hooks: Stop (keeps the loop going) and UserPromptSubmit (records the engineer's replies).

- **Claude Code** arms both from this file when the skill is invoked.
- **Codex**: run `helix hooks codex` once. It adds both to `~/.codex/hooks.json`; approve them when Codex asks you to trust new hooks.
- **Other agents** with hooks: call `helix hook stop` and `helix hook prompt` with the hook's JSON event on stdin, using the same protocol as Claude Code.

If `helix approve` says no engineer reply was recorded, the hooks are not active: set them up, then ask the engineer to reply again.

## One-time setup per repository

1. `helix status`. If it says Helix is not initialized, gather with the engineer (ask only what you cannot find in the repo):
   - the **test command** that runs behavior tests without a simulator or browser (exit 0 = pass),
   - **guidelines**: the documents describing the target architecture and UI code conventions. Adversarial review is only as good as this standard. If none exist, offer to draft one from the existing code and get the engineer's sign-off before starting.
   - **design** documents (design system, design.md) for the UI reviewer, if any,
   - how to **capture screenshots** of the reference and the new implementation in a given state.
2. `helix init --test-command "..." --guideline docs/architecture.md --design design.md --capture-notes "..."` (`--no-ui` for logic-only work). Helix keeps its config, learnings, run state and evidence inside the git directory, never in the working tree, so there is nothing to commit, ignore or exclude from the repo's tools. `helix status` prints where the config and learnings live.

## The loop

### 1. Plan (stop #1)

1. `helix new <name> --title "<short human title>" --goal "<engineer's words>" --reference "<reference code, running app, prototype or designs>" --target "<where new code goes>"`. It prints the run's **work dir** (`<work>` below; `helix status` shows it too).
2. Dispatch the **checkpoint planner** subagent with `prompts/checkpoint-planner.md` plus the goal, reference, target and output path `<work>/checkpoints.json`. If it returns questions, ask the engineer (with your ask-the-user tool, or `helix ask <run> "..."` then stop).
3. `helix plan <run> --file <work>/checkpoints.json`. Fix and reload if the CLI rejects it.
4. Dispatch the **test planner** subagent with `prompts/test-planner.md` for all checkpoints, then `helix tests <run> --file <work>/tests.json`.
5. `helix submit-plan <run>` opens the viewer. Tell the engineer in two or three lines what the plan covers and that it is in the viewer, then **stop**.
6. On their reply: `helix approve <run>` if they approve; otherwise `helix feedback <run> --text "<their words>" [--learning "<general lesson>"]`, revise with the planner, `helix plan`, `helix tests`, `helix submit-plan` again.

### 2. Build each checkpoint

`helix status <run>` names the current checkpoint and next action. For the current checkpoint:

1. **Behavior gate.** Dispatch the **test writer** (`prompts/test-writer.md`), then the **implementer** (`prompts/implementer.md`), then run `helix gate behavior <run>`. On failure, dispatch the **fixer** (`prompts/fixer.md`) with the log path the CLI printed and rerun. Iterate on behavior as often as needed before taking any screenshot.
2. **UI gate** (checkpoints marked `ui`). Put the reference and the implementation in the **same state** (same data, same scroll position, same device size) following the capture notes in the Helix config, screenshot both (web: Playwright; iOS: `xcrun simctl io booted screenshot`; Android: `adb exec-out screencap -p`), then `helix gate ui <run> --pair <ref.png> <impl.png> "<state>"` (repeat `--pair` for several states). The reviewer compares only the checkpoint's `ui_scope`.
   - `FAIL`: dispatch the fixer with the report, rerun behavior, recapture, rerun UI.
   - `INVALID`: the screenshots show different states or sections. Recapture both in the same state; the code is not the problem.
3. **Adversarial review gate.** `helix gate review <run>`. Two context-isolated reviewers check the checkpoint's diff against the guidelines and learnings. Any finding fails the gate: dispatch the fixer with the findings file, rerun `gate behavior`, rerun `gate ui` if anything visible changed, then `gate review` again. Repeat until both approve. If the fixer shows a finding is factually wrong (not merely inconvenient), ask the engineer; if they agree, record their ruling with `helix learn "<rule>"`, which every reviewer reads, and rerun the review.
4. **Engineer gate** (stop). `helix request-approval <run>`. In autonomous mode the CLI approves it and you continue to commit. Otherwise tell the engineer in a few lines what the checkpoint does, how to see it running, and the evidence (attempt counts, UI review, reviewer verdicts), then **stop**.
   - Approval: `helix approve <run>`.
   - Feedback: `helix feedback <run> --text "<their words>" --learning "<the general rule behind it>"`, dispatch the fixer with the feedback, and run the gates again from behavior. Write the learning so it applies to future checkpoints, not just this one.
5. `helix commit <run>` commits the checkpoint with its evidence and starts the next one.

### 3. Final review (stop #2)

When the last checkpoint is committed the run is `done`. Ask the engineer to test the whole feature and **stop**. Record their reply with `helix feedback`, have the planner turn it into checkpoints, then `helix add <run> --file ...` and `helix tests <run> --file ...` and continue the loop.

## Engineer controls

| Engineer says | You run |
|---|---|
| "do the next 3 without asking" | `helix autonomy <run> --checkpoints 3` |
| "run it all / overnight" | `helix autonomy <run> --all` (gates stay exactly as strict) |
| "ask me again" | `helix autonomy <run> --off` |
| "stop / pause" | `helix pause <run>`; later `helix resume <run>` |
| a lasting preference ("we never use X") | `helix learn "<rule>"` |
| "skip the visual check for this one" (no comparable reference or device) | `helix waive <run> ui --reason "<their words>"` (only the UI gate can be waived) |
| work on several screens at once | one run per screen, each in its own git worktree (`git worktree add`), since every run commits |

Plan approval always needs the engineer.

## Resuming

If the session was resumed or restarted, invoke this skill again (in Claude Code that re-arms its hooks), run `helix status`, and continue from the printed next action. Your first Helix command claims the run for the new session. If a run is `stalled`, tell the engineer what blocked you and `helix resume <run>` when they reply.

## Red flags: stop and correct course

| Thought | Reality |
|---|---|
| "The UI difference is tiny, good enough" | Fixable differences are blockers. Fix it and rerun the gate. |
| "This reviewer finding is wrong, I'll just commit" | You cannot commit past a failed gate. Fix it, or take the evidence to the engineer; only their ruling, recorded as a learning, overrides a reviewer. |
| "Tests fail for an unrelated reason, I'll adjust the test" | Weakening tests is forbidden. Fix the code or report to the engineer. |
| "I'll screenshot a different state, it's close enough" | That earns `INVALID`. Put both apps in the same state. |
| "The engineer would approve this, I'll run approve" | `approve` needs their actual reply. Stop and ask. |
| "I'll build checkpoints 2 and 3 together to save time" | One checkpoint at a time. Its gates pass before the next starts. |
| "I'll write this code myself instead of a subagent" | Dispatch a subagent. Your context is for coordination across the whole run. |
