// Agent hooks: the Stop hook keeps a session working while its run is
// unfinished, and the prompt hook records the engineer's messages. One entry
// point serves every agent; `helix hooks <agent>` installs it.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { text } from "node:stream/consumers";
import { ACTIVE, CLI, HelixError, MAX_IDENTICAL_STOPS, now, readJsonInput, writeJson } from "./core.mjs";
import { nextAction } from "./next-action.mjs";
import { fingerprint, repoRoot, runsDir, sharedDir } from "./repo.mjs";
import { recordReply } from "./state.mjs";
import { allRunIds, loadRun, transaction } from "./store.mjs";

/** @import { Args, HookCommands, HookDialect, HookEvent, HookInstaller } from "./types.js" */

/** @param {any} data @returns {HookEvent} */
function readHookEvent(data) {
  return {
    sessionId: data.session_id ?? data.conversation_id ?? data.sessionId ?? null,
    cwd: data.cwd || data.workspace_roots?.[0] || process.cwd(),
    prompt: String(data.prompt ?? ""),
    eventName: String(data.hook_event_name ?? data.hookEventName ?? ""),
  };
}

/** @param {HookDialect} dialect @param {string} reason */
function hookContinue(dialect, reason) {
  return dialect === "cursor" ? { followup_message: reason } : { decision: "block", reason };
}

/**
 * Entry point for every agent's hooks. Never throws and never exits non-zero:
 * a crashing hook would block the engineer's prompt.
 * @param {string} event
 * @param {HookDialect} dialect
 */
export async function hookMain(event, dialect) {
  try {
    const hook = readHookEvent(JSON.parse((await text(process.stdin)) || "{}"));
    const root = repoRoot(hook.cwd);
    if (!fs.existsSync(runsDir(root))) return;
    const mine = allRunIds(root).filter((rid) => {
      const owner = loadRun(root, rid).owner_session;
      return owner === hook.sessionId || owner === null;
    });
    if (event === "prompt") hookPrompt(root, mine, hook, dialect);
    else if (event === "stop") hookStop(root, mine, dialect);
  } catch (error) {
    try {
      fs.appendFileSync(path.join(sharedDir(repoRoot()), "hook-errors.log"), `${now()} ${event}: ${error}\n`);
    } catch {
      // hooks fail open
    }
  }
}

/**
 * @param {string} root
 * @param {string[]} runIds
 * @param {HookEvent} hook
 * @param {HookDialect} dialect
 */
function hookPrompt(root, runIds, hook, dialect) {
  const text = hook.prompt.slice(0, 4000);
  /** @type {string[]} */
  const notes = [];
  for (const rid of runIds) {
    const { run } = transaction(root, rid, (run) => {
      if (hook.sessionId) run.owner_session = run.hook_session = hook.sessionId;
      run.hooked = true;
      recordReply(run, text, "hook");
    }, false);
    if (run.status !== "done" || run.awaiting) notes.push(`Helix run '${rid}' is ${run.status}. ${nextAction(run)}`);
  }
  if (notes.length && dialect === "standard") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hook.eventName || "UserPromptSubmit",
        additionalContext: `${notes.join("\n")}\nRe-read the helix skill before acting if it is not loaded.`,
      },
    }));
  }
}

/** @param {string} root @param {string[]} runIds @param {HookDialect} dialect */
function hookStop(root, runIds, dialect) {
  for (const rid of runIds) {
    const snapshot = loadRun(root, rid);
    if (!ACTIVE.has(snapshot.status)) continue;
    const fp = fingerprint(root);
    const { stop_guard: _g, updated_at: _u, last_prompt: _p, ...essence } = snapshot;
    const signature = createHash("sha256").update(JSON.stringify([fp, essence])).digest("hex");
    const { run, result: stalled } = transaction(root, rid, (run) => {
      const guard = run.stop_guard;
      const count = guard?.signature === signature ? guard.count + 1 : 1;
      if (count > MAX_IDENTICAL_STOPS) {
        run.stalled_from = run.status;
        run.status = "stalled";
        run.stop_guard = null;
        run.history.push({ at: now(), event: "stalled: no progress across stop attempts" });
        return true;
      }
      run.stop_guard = { signature, count };
      return false;
    }, false);
    if (stalled) {
      if (dialect === "standard") {
        console.log(JSON.stringify({
          systemMessage: `Helix run '${rid}' stalled: the agent made no progress across ${MAX_IDENTICAL_STOPS} ` +
            "attempts to stop. Reply to resume it.",
        }));
      }
      return;
    }
    const reason = `Helix run '${rid}' is not finished and no gate lets you stop here. An attempt may be wrong; it ` +
      `may not stop until the gates pass. Next required action: ${nextAction(run, root)}`;
    console.log(JSON.stringify(hookContinue(dialect, reason)));
    return;
  }
}

// helix.ts: installed before Helix was plain JavaScript, as `bun .../helix.ts hook ...` or `node .../helix.mjs hook ...`.
/** @param {unknown} command */
const isHelixHook = (command) => typeof command === "string" && /helix\.(mjs|ts)"? hook (stop|prompt)/.test(command);

/**
 * Claude-style config: {hooks: {Event: [{hooks: [{type, command, ...}]}]}}.
 * @param {(kind: "stop" | "prompt") => object} extra
 * @returns {HookInstaller["merge"]}
 */
function mergeGrouped(extra) {
  return (config, commands, events) => {
    config.hooks ??= {};
    for (const kind of /** @type {const} */ (["stop", "prompt"])) {
      /** @type {any[]} */
      const groups = config.hooks[events[kind]] ?? [];
      for (const group of groups) group.hooks = (group.hooks ?? []).filter((/** @type {any} */ hook) => !isHelixHook(hook?.command));
      config.hooks[events[kind]] = [
        ...groups.filter((group) => group.hooks.length),
        { hooks: [{ type: "command", command: commands[kind], ...extra(kind) }] },
      ];
    }
    return config;
  };
}

/** @type {Record<string, HookInstaller>} */
const HOOK_INSTALLERS = {
  claude: {
    file: () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json"),
    events: { stop: "Stop", prompt: "UserPromptSubmit" },
    dialect: "standard",
    merge: mergeGrouped(() => ({})),
    note: "Claude Code runs them from its next session. Skip this when Helix is installed as a Claude Code plugin: " +
      "the plugin brings its own hooks.",
  },
  codex: {
    file: () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json"),
    events: { stop: "Stop", prompt: "UserPromptSubmit" },
    dialect: "standard",
    merge: mergeGrouped(() => ({ timeout: 30 })),
    note: "Codex asks you to review and trust new hooks (/hooks) the next time it starts; approve them there.",
  },
  gemini: {
    file: () => path.join(os.homedir(), ".gemini", "settings.json"),
    events: { stop: "AfterAgent", prompt: "BeforeAgent" },
    dialect: "standard",
    merge: mergeGrouped((kind) => ({ name: `helix-${kind}`, timeout: 30_000 })),
    note: "Gemini CLI runs them from its next session.",
  },
  cursor: {
    file: () => path.join(os.homedir(), ".cursor", "hooks.json"),
    events: { stop: "stop", prompt: "beforeSubmitPrompt" },
    dialect: "cursor",
    merge: (config, commands, events) => {
      config.version ??= 1;
      config.hooks ??= {};
      for (const kind of /** @type {const} */ (["stop", "prompt"])) {
        const kept = (config.hooks[events[kind]] ?? []).filter((/** @type {any} */ hook) => !isHelixHook(hook?.command));
        config.hooks[events[kind]] = [...kept, { command: commands[kind], ...(kind === "stop" ? { loop_limit: null } : {}) }];
      }
      return config;
    },
    note: "Cursor's agent picks them up in new chats. Cursor's prompt hook cannot add context, so the agent " +
      "learns the next action from `helix status` and the stop hook.",
  },
  copilot: {
    file: () => path.join(os.homedir(), ".copilot", "hooks", "helix.json"),
    events: { stop: "Stop", prompt: "UserPromptSubmit" },
    dialect: "standard",
    merge: (_config, commands, events) => ({
      version: 1,
      hooks: {
        [events.stop]: [{ type: "command", bash: commands.stop, timeoutSec: 30 }],
        [events.prompt]: [{ type: "command", bash: commands.prompt, timeoutSec: 30 }],
      },
    }),
    note: "Copilot CLI loads ~/.copilot/hooks/*.json at startup.",
  },
};

export const HOOK_AGENTS = Object.keys(HOOK_INSTALLERS);

/**
 * Installs Helix's Stop and prompt hooks in an agent's user-level hook config,
 * never in the repository, so the working tree stays untouched. The hooks do
 * nothing outside a Helix run.
 * @param {Args} args
 */
export function cmdHooks(args) {
  const agent = args._[0];
  const installer = HOOK_INSTALLERS[agent];
  if (!installer) {
    throw new HelixError(`No hook installer for '${agent}'. Supported: ${HOOK_AGENTS.join(", ")}. ` +
      "Other agents: wire `helix hook stop` and `helix hook prompt` by hand (see the skill's Hooks section), or " +
      "relay the engineer's replies with `helix reply`.");
  }
  const file = installer.file();
  const suffix = installer.dialect === "cursor" ? " cursor" : "";
  /** @param {string} kind */
  const command = (kind) => `node ${JSON.stringify(CLI)} hook ${kind}${suffix} || true`;
  const existing = fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() ? readJsonInput(file) : {};
  /** @type {HookCommands} */
  const commands = { stop: command("stop"), prompt: command("prompt") };
  writeJson(file, installer.merge(existing, commands, installer.events));
  console.log(`Installed Helix's ${installer.events.stop} and ${installer.events.prompt} hooks in ${file}.`);
  console.log(installer.note);
}
