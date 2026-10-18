// Setting Helix up in a repository, and seeing where its runs stand.

import * as fs from "node:fs";
import * as path from "node:path";
import { clone, DEFAULT_CONFIG, HelixError, installed, openFile, plural, writeJson } from "../lib/core.mjs";
import { defaultConfig, loadConfig, readConfigFile } from "../lib/config.mjs";
import { appendLearning, appendLearningLines, learningLines, learningsPath, readLearnings } from "../lib/learnings.mjs";
import { nextAction } from "../lib/next-action.mjs";
import { fingerprint, legacyPath, localConfigPath, repoRoot, runDir, TEAM_DIR, teamConfigPath, workDir } from "../lib/repo.mjs";
import { gateState, requiredGates } from "../lib/state.mjs";
import { allRunIds, loadRun, runsToPickUp } from "../lib/store.mjs";
import { renderViewer } from "../lib/viewer.mjs";

/** @import { Args, Config } from "../lib/types.js" */

/** @param {Args} args */
export function cmdInit(args) {
  const root = repoRoot();
  const file = teamConfigPath(root);
  const legacyConfig = legacyPath(root, "config.json");
  const legacyLearnings = legacyPath(root, "learnings.md");
  const shared = fs.existsSync(file);
  /** @type {Config} */
  const config = shared ? readConfigFile(file)
    : fs.existsSync(legacyConfig) ? readConfigFile(legacyConfig) : defaultConfig();
  if (args["test-command"] !== undefined) config.test_command = args["test-command"];
  for (const [flag, key] of /** @type {const} */ ([["guideline", "guidelines"], ["design", "design"]])) {
    for (const item of /** @type {string[] | undefined} */ (args[flag]) ?? []) {
      if (!fs.existsSync(path.join(root, item))) {
        throw new HelixError(`${key} file '${item}' does not exist (paths are relative to the repo root).`);
      }
      config[key] ??= [];
      if (!config[key].includes(item)) config[key].push(item);
    }
  }
  config.ui ??= clone(DEFAULT_CONFIG.ui);
  if (args["no-ui"]) config.ui.enabled = false;
  if (args["capture-notes"] !== undefined) config.ui.capture_notes = args["capture-notes"];
  writeJson(file, config);
  const moved = [];
  if (fs.existsSync(legacyConfig)) {
    if (shared) {
      const kept = `${legacyConfig}.old`;
      fs.renameSync(legacyConfig, kept);
      moved.push(`The team's ${TEAM_DIR}/config.json now applies. Your earlier config is kept at ${kept}: copy any ` +
        `setting only you need into ${localConfigPath(root)}.`);
    } else {
      fs.rmSync(legacyConfig);
      moved.push(`Moved your config from ${legacyConfig} into ${TEAM_DIR}/config.json.`);
    }
  }
  if (fs.existsSync(legacyLearnings)) {
    const known = new Set(learningLines(readLearnings(root)));
    const lines = learningLines(fs.readFileSync(legacyLearnings, "utf8")).filter((l) => !known.has(l));
    if (lines.length) appendLearningLines(root, lines);
    fs.rmSync(legacyLearnings);
    moved.push(`Moved ${plural(lines.length, "learning")} from ${legacyLearnings} into ${TEAM_DIR}/learnings.md.`);
  }
  if (!fs.existsSync(learningsPath(root))) appendLearningLines(root, []);
  console.log(`Helix config: ${file}`);
  console.log(JSON.stringify(config, null, 2));
  for (const line of moved) console.log(`\n${line}`);
  console.log(`\nCommit ${TEAM_DIR}/ so everyone's agents share this config and the learnings. Settings only you ` +
    `need, such as a reviewer CLI the team does not use, go in ${localConfigPath(root)}.`);
  if (!config.test_command) {
    console.log("\nWARNING: no test_command yet. The behavior gate cannot run without one " +
      "(set it with `helix init --test-command ...`).");
  }
  const effective = loadConfig(root);
  const { ui, code, matcher } = effective.reviewers;
  const backends = new Set([ui, ...code, matcher].map((r) => r?.backend ?? "claude"));
  for (const backend of backends) {
    if (backend !== "exec" && !installed(backend)) {
      console.log(`\nWARNING: reviewers use the '${backend}' CLI, which is not installed. The UI and review gates will ` +
        `error until it is, or until reviewers point at an installed backend in your own ${localConfigPath(root)}.`);
    }
  }
  if (!config.guidelines?.length) {
    console.log("\nWARNING: no guidelines documents. Adversarial reviewers need a written standard to enforce " +
      "(add with `helix init --guideline docs/architecture.md`).");
  }
}

/** @param {Args} args */
export function cmdLearn(args) {
  const root = repoRoot();
  loadConfig(root);
  appendLearning(root, args._[0], args.source ?? "engineer");
  console.log(`Saved to ${learningsPath(root)}. Commit it so everyone's agents apply it; a checkpoint commit includes it.`);
}

/** @param {Args} args */
export function cmdStatus(args) {
  const root = repoRoot();
  const config = loadConfig(root);
  const ids = args._[0] ? [args._[0]] : allRunIds(root);
  const local = localConfigPath(root);
  console.log(`Config: ${teamConfigPath(root)}${fs.existsSync(local) ? `, with your overrides in ${local}` : ""}\n` +
    `Learnings: ${learningsPath(root)}\n`);
  for (const rid of runsToPickUp(root)) {
    console.log(`Run ${rid} on this branch is further along than this clone's copy, or new to it: pick it up with ` +
      `\`helix claim ${rid}\`.\n`);
  }
  if (!ids.length) {
    console.log("No Helix runs in this clone. Start one with `helix new`.");
    return;
  }
  const fp = fingerprint(root);
  ids.forEach((rid, index) => {
    const run = loadRun(root, rid);
    const mode = run.autonomy.remaining;
    console.log(`Run ${rid}: ${run.title}  [${run.accepted_at ? "accepted" : run.status}]  autonomy=${mode ?? "all"}  owner=${run.owner_session || "-"}`);
    for (const cp of run.checkpoints) {
      const marker = cp.id === run.current ? ">" : " ";
      const gates = requiredGates(cp, config)
        .map((g) => `${g}:${cp.status === "committed" ? "passed" : gateState(cp, g, fp)}`).join(" ");
      console.log(` ${marker} ${cp.id.padEnd(6)} ${cp.status.padEnd(11)} ${cp.title.padEnd(40)} ${gates}`);
    }
    console.log("Next:", nextAction(run, root, config));
    console.log(`Work dir: ${workDir(root, rid)}`);
    console.log(`Viewer: ${path.join(runDir(root, rid), "viewer.html")}`);
    if (ids.length > 1 && index < ids.length - 1) console.log();
  });
}

/** @param {Args} args */
export function cmdView(args) {
  const root = repoRoot();
  const run = loadRun(root, args._[0]);
  renderViewer(root, run);
  const file = path.join(runDir(root, run.id), "viewer.html");
  if (!args["no-open"]) openFile(file);
  console.log(file);
}
