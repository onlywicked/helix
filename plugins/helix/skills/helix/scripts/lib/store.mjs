// Runs on disk: each run's state.json, read and written under a cross-process
// lock, and the evidence and work files beside it.

import * as fs from "node:fs";
import * as path from "node:path";
import { HelixError, now, readJson, readJsonInput, sleepSync, writeJson } from "./core.mjs";
import { nextAction } from "./next-action.mjs";
import { runDir, runsDir, sessionId, workDir } from "./repo.mjs";
import { currentCp } from "./state.mjs";
import { renderViewer } from "./viewer.mjs";

/** @import { Checkpoint, Run } from "./types.js" */

/** @param {string} root @returns {string[]} */
export function allRunIds(root) {
  const runs = runsDir(root);
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs).filter((name) => fs.existsSync(path.join(runs, name, "state.json"))).sort();
}

/**
 * Cross-process mutex (mkdir is atomic). Held only for short read-modify-write sections.
 * @template T
 * @param {string} root
 * @param {string} runId
 * @param {() => T} fn
 * @returns {T}
 */
export function withLock(root, runId, fn) {
  const dir = runDir(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > 30_000) fs.rmSync(lock, { recursive: true, force: true }); // holder died
      else if (Date.now() > deadline) throw new HelixError(`Timed out waiting for the lock on run '${runId}'.`);
      else sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** @param {string} root @param {string} runId @returns {Run} */
export function loadRun(root, runId) {
  const file = path.join(runDir(root, runId), "state.json");
  if (!fs.existsSync(file)) {
    throw new HelixError(`No Helix run named '${runId}'. Known runs: ${allRunIds(root).join(", ") || "none"}.`);
  }
  return readJson(file);
}

/** @param {string} root @param {Run} run */
export function saveRun(root, run) {
  run.updated_at = now();
  writeJson(path.join(runDir(root, run.id), "state.json"), run);
  renderViewer(root, run);
}

/**
 * Locked read-modify-write of a run. Mutating commands claim the run for the
 * calling session so the hooks know whose Stop to guard.
 * @template T
 * @param {string} root
 * @param {string} runId
 * @param {(run: Run) => T} fn
 * @returns {{ run: Run; result: T }}
 */
export function transaction(root, runId, fn, claim = true) {
  return withLock(root, runId, () => {
    const run = loadRun(root, runId);
    if (claim && sessionId()) run.owner_session = sessionId();
    const result = fn(run);
    saveRun(root, run);
    return { run, result };
  });
}

/** @param {Run} run @returns {Checkpoint} */
export function requireCurrent(run) {
  const cp = currentCp(run);
  if (run.status !== "building" || !cp) {
    throw new HelixError(`Run '${run.id}' is '${run.status}', not building a checkpoint.\n${nextAction(run)}`);
  }
  return cp;
}

/** @param {string} root @param {Run} run @param {Checkpoint} cp */
export function evidenceDir(root, run, cp) {
  const dir = path.join(runDir(root, run.id), "evidence", cp.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A run's JSON input: a path, or a file name in the run's work dir, where briefs tell subagents to write.
 * @param {string} root
 * @param {string} runId
 * @param {string} file
 * @returns {any}
 */
export function readRunInput(root, runId, file) {
  const inWork = path.join(workDir(root, runId), file);
  return readJsonInput(!path.isAbsolute(file) && !fs.existsSync(file) && fs.existsSync(inWork) ? inWork : file);
}
