// The command line: every command, its flags, and dispatch.

import { cmdBrief, BRIEF_ROLES } from "../commands/brief.mjs";
import { cmdCommit } from "../commands/commit.mjs";
import {
  cmdApprove, cmdAsk, cmdAutonomy, cmdClaim, cmdFeedback, cmdFindings, cmdPause, cmdReply, cmdRequestApproval, cmdResume,
  cmdRule, cmdWaive,
} from "../commands/engineer.mjs";
import { cmdGate } from "../commands/gates.mjs";
import { cmdAdd, cmdNew, cmdPlan, cmdSubmitPlan, cmdTests } from "../commands/planning.mjs";
import { cmdInit, cmdLearn, cmdStatus, cmdView } from "../commands/setup.mjs";
import { GateExit, HelixError } from "./core.mjs";
import { cmdHooks, HOOK_AGENTS, hookMain } from "./hooks.mjs";
import { TEAM_DIR } from "./repo.mjs";

/** @import { Args, CommandSpec } from "./types.js" */

const RUN = "<run>";
/** @type {Record<string, CommandSpec>} */
const COMMANDS = {
  init: {
    help: `create or update the team config in ${TEAM_DIR}/ (commit it so the team shares it)`,
    usage: "init [--test-command CMD] [--guideline FILE]... [--design FILE]... [--no-ui] [--capture-notes TEXT]",
    positionals: 0,
    flags: { "test-command": "string", guideline: "repeat", design: "repeat", "no-ui": "boolean", "capture-notes": "string" },
    run: cmdInit,
  },
  new: {
    help: "start a run", usage: "new <name> --goal TEXT --reference TEXT [--title TEXT] [--target TEXT]",
    positionals: 1, flags: { title: "string", goal: "string", reference: "string", target: "string" },
    required: ["goal", "reference"], run: cmdNew,
  },
  plan: {
    help: "load the checkpoint plan (replaces it while planning)", usage: `plan ${RUN} --file FILE`,
    positionals: 1, flags: { file: "string" }, required: ["file"], run: cmdPlan,
  },
  tests: {
    help: "attach planned test cases to checkpoints", usage: `tests ${RUN} --file FILE`,
    positionals: 1, flags: { file: "string" }, required: ["file"], run: cmdTests,
  },
  "submit-plan": {
    help: "send the plan to the engineer for approval", usage: `submit-plan ${RUN} [--no-open]`,
    positionals: 1, flags: { "no-open": "boolean" }, run: cmdSubmitPlan,
  },
  gate: {
    help: "run a gate for the current checkpoint",
    usage: `gate behavior|ui|review ${RUN} [--pair REF IMPL STATE]...`,
    positionals: 2, flags: { pair: "triple" }, run: cmdGate,
  },
  "request-approval": {
    help: "hand a checkpoint whose automated gates passed to the engineer", usage: `request-approval ${RUN}`,
    positionals: 1, run: cmdRequestApproval,
  },
  approve: {
    help: "record the engineer's approval (plan, checkpoint or finished feature)",
    usage: `approve ${RUN} [--message SUBJECT]  (--message: the subject of the commit that closes the run, when accepting the feature)`,
    positionals: 1, flags: { message: "string" }, run: cmdApprove,
  },
  feedback: {
    help: "record the engineer's feedback (plan, checkpoint or final review)",
    usage: `feedback ${RUN} --text TEXT [--learning TEXT]`,
    positionals: 1, flags: { text: "string", learning: "string" }, required: ["text"], run: cmdFeedback,
  },
  commit: {
    help: "commit the current checkpoint (all gates must pass on this exact tree)",
    usage: `commit ${RUN} --message SUBJECT [--trailer 'Key: value']...`,
    positionals: 1, flags: { message: "string", trailer: "repeat" }, required: ["message"], run: cmdCommit,
  },
  add: {
    help: "append checkpoints to an approved run (e.g. from engineer feedback)", usage: `add ${RUN} --file FILE`,
    positionals: 1, flags: { file: "string" }, required: ["file"], run: cmdAdd,
  },
  autonomy: {
    help: "let the next N checkpoints, counting the current one, skip engineer approval (engineer's request only)",
    usage: `autonomy ${RUN} --checkpoints N | --all | --off`,
    positionals: 1, flags: { checkpoints: "string", all: "boolean", off: "boolean" }, run: cmdAutonomy,
  },
  brief: {
    help: "write the complete brief for a subagent role",
    usage: `brief ${RUN} ${BRIEF_ROLES.join("|")} [--checkpoint ID]  (--checkpoint: re-plan one checkpoint's tests)`,
    positionals: 2, flags: { checkpoint: "string" }, run: cmdBrief,
  },
  reply: {
    help: "relay the engineer's message word for word (agents without a prompt hook)",
    usage: `reply ${RUN} --text TEXT`, positionals: 1, flags: { text: "string" }, required: ["text"], run: cmdReply,
  },
  ask: {
    help: "stop to ask the engineer a question (--finding: ask for a ruling on a review finding)",
    usage: `ask ${RUN} [QUESTION] [--finding ID]...`, positionals: 1, optionalPositionals: 1,
    flags: { finding: "repeat" }, run: cmdAsk,
  },
  waive: {
    help: "waive the current checkpoint's UI gate (engineer's ruling only)", usage: `waive ${RUN} ui --reason TEXT`,
    positionals: 2, flags: { reason: "string" }, required: ["reason"], run: cmdWaive,
  },
  findings: {
    help: "list the current checkpoint's review findings with the fixer's answers and rulings",
    usage: `findings ${RUN}`, positionals: 1, run: cmdFindings,
  },
  rule: {
    help: "record the engineer's ruling on a review finding (fix: it must be fixed, drop: it is wrong)",
    usage: `rule ${RUN} FINDING fix|drop --text TEXT [--learning TEXT]`,
    positionals: 3, flags: { text: "string", learning: "string" }, required: ["text"], run: cmdRule,
  },
  claim: {
    help: "take over a run: after resuming in a new session, or a teammate's run from the branch", usage: `claim ${RUN}`, positionals: 1, run: cmdClaim,
  },
  pause: { help: "pause the run (engineer's request)", usage: `pause ${RUN}`, positionals: 1, run: cmdPause },
  resume: { help: "resume a paused or stalled run", usage: `resume ${RUN}`, positionals: 1, run: cmdResume },
  learn: {
    help: "append a lesson to the shared learnings", usage: "learn TEXT [--source TEXT]",
    positionals: 1, flags: { source: "string" }, run: cmdLearn,
  },
  status: {
    help: "show runs, gates and the next required action", usage: `status [${RUN}]`,
    positionals: 0, optionalPositionals: 1, run: cmdStatus,
  },
  hooks: {
    help: "install Helix's hooks for an agent (not needed with the Claude Code plugin)",
    usage: `hooks ${HOOK_AGENTS.join("|")}`,
    positionals: 1, run: cmdHooks,
  },
  view: {
    help: "render and open the viewer", usage: `view ${RUN} [--no-open]`,
    positionals: 1, flags: { "no-open": "boolean" }, run: cmdView,
  },
};

function usage() {
  const lines = Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(17)} ${spec.help}`);
  return `usage: helix <command> [args]  (helix <command> --help for details)\n\ncommands:\n${lines.join("\n")}\n` +
    "  hook stop|prompt [cursor]  hook entry point (stdin: the agent's hook event)";
}

/** @param {CommandSpec} spec @param {string[]} argv @returns {Args} */
function parse(spec, argv) {
  /** @type {Args} */
  const args = { _: [] };
  const flags = spec.flags ?? {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    const kind = flags[name];
    if (!kind) throw new HelixError(`Unknown option --${name}.\nusage: helix ${spec.usage}`);
    const take = () => {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new HelixError(`--${name} needs a value.\nusage: helix ${spec.usage}`);
      return value;
    };
    if (kind === "boolean") args[name] = true;
    else if (kind === "string") args[name] = take();
    else if (kind === "repeat") (args[name] ??= []).push(take());
    else {
      const triple = argv.slice(i + 1, i + 4);
      if (triple.length < 3) throw new HelixError(`--${name} needs 3 values.\nusage: helix ${spec.usage}`);
      (args[name] ??= []).push(triple);
      i += 3;
    }
  }
  const max = spec.positionals + (spec.optionalPositionals ?? 0);
  if (args._.length < spec.positionals || args._.length > max) {
    throw new HelixError(`Wrong number of arguments.\nusage: helix ${spec.usage}`);
  }
  for (const name of spec.required ?? []) {
    if (args[name] === undefined) throw new HelixError(`--${name} is required.\nusage: helix ${spec.usage}`);
  }
  return args;
}

/** @param {string[]} argv */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "hook") {
    await hookMain(rest[0], rest[1] === "cursor" ? "cursor" : "standard");
    return;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  const spec = COMMANDS[command];
  try {
    if (!spec) throw new HelixError(`Unknown command '${command}'.\n${usage()}`);
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(`usage: helix ${spec.usage}\n\n${spec.help}`);
      return;
    }
    await spec.run(parse(spec, rest));
  } catch (error) {
    // Setting the exit code instead of exiting lets piped output finish writing.
    if (error instanceof GateExit) process.exitCode = error.code;
    else if (error instanceof HelixError) {
      console.error(`helix: ${error.message}`);
      process.exitCode = 1;
    } else throw error;
  }
}
