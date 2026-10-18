// Runs on disk: each run's state.json, read and written under a cross-process
// lock, and the evidence and work files beside it.

import * as fs from "node:fs";
import * as path from "node:path";
import { clone, git, HelixError, now, readJson, readJsonInput, sleepSync, writeJson } from "./core.mjs";
import { nextAction } from "./next-action.mjs";
import { runDir, runsDir, sessionId, sharedRunPath, TEAM_DIR, workDir } from "./repo.mjs";
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
    const pickUp = readSharedRun(root, runId) ? ` Run '${runId}' is on this branch: pick it up with \`helix claim ${runId}\`.` : "";
    throw new HelixError(`No Helix run named '${runId}' in this clone.${pickUp} Known runs: ${allRunIds(root).join(", ") || "none"}.`);
  }
  return readJson(file);
}

/** Run fields that belong to one machine's agent sessions, never to the branch. */
const SESSION_FIELDS = /** @type {const} */ (["owner_session", "hook_session", "stop_guard", "last_prompt", "hooked"]);

/** @param {Run} run */
export const committedCount = (run) => run.checkpoints.filter((cp) => cp.status === "committed").length;

/** @param {string} root @returns {string[]} */
export function sharedRunIds(root) {
  const dir = path.dirname(sharedRunPath(root, "-"));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
}

/** @param {string} root @param {string} runId @returns {Run | null} */
export function readSharedRun(root, runId) {
  const file = sharedRunPath(root, runId);
  return fs.existsSync(file) ? readJsonInput(file) : null;
}

/**
 * Runs on this branch that are further along than this clone's copy, or that
 * this clone has no copy of: a teammate's work to pick up.
 * @param {string} root
 */
export function runsToPickUp(root) {
  const local = new Set(allRunIds(root));
  return sharedRunIds(root).filter((rid) => !local.has(rid) ||
    committedCount(/** @type {Run} */ (readSharedRun(root, rid))) > committedCount(loadRun(root, rid)));
}

/**
 * Writes the run, as it stands once this checkpoint commit is made, into the
 * working tree for the commit to carry. The commit's own hash is not known
 * yet; pickUpRun fills it in from git.
 * @param {string} root
 * @param {Run} run
 */
export function writeSharedRun(root, run) {
  const shared = clone(run);
  for (const field of SESSION_FIELDS) delete shared[field];
  writeJson(sharedRunPath(root, run.id), shared);
}

/**
 * Takes over a run from the branch: the plan and progress as of its last
 * checkpoint commit, for this clone and session. The next checkpoint starts
 * from that commit.
 * @param {string} root
 * @param {string} runId
 */
export function pickUpRun(root, runId) {
  const shared = readSharedRun(root, runId);
  if (!shared) throw new HelixError(`Run '${runId}' is not on this branch (no ${TEAM_DIR}/runs/${runId}.json).`);
  const commit = git(root, ["log", "-1", "--format=%H", "--", path.relative(root, sharedRunPath(root, runId))]);
  for (const cp of shared.checkpoints) {
    if (cp.status === "committed") cp.commit ??= commit;
    if (cp.status === "in_progress") cp.base = commit;
  }
  /** @type {Run} */
  const run = { ...shared, owner_session: sessionId(), hook_session: null, stop_guard: null, last_prompt: null, hooked: false };
  run.history.push({ at: now(), event: `picked up from the branch at ${commit.slice(0, 10)}` });
  withLock(root, runId, () => saveRun(root, run));
  fs.mkdirSync(workDir(root, runId), { recursive: true });
  return run;
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
