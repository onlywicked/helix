// The repository: where Helix keeps its files, the tree fingerprint every gate
// verdict is bound to, and the agent session calling the CLI.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, HelixError, sh } from "./core.mjs";

/** @import { Repo } from "./types.js" */

/** @type {Map<string, Repo>} */
const repos = new Map();

/**
 * Where the repository keeps things. It cannot change while a command runs, so git is asked once.
 * @param {string} dir
 * @returns {Repo}
 */
export function repo(dir) {
  let found = repos.get(dir);
  if (!found) {
    const proc = sh(["git", "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--git-path", "index"],
      dir, { check: false });
    if (proc.status !== 0) {
      throw new HelixError("Helix needs a git repository (every checkpoint ends in a commit). Run `git init` first.");
    }
    const [root, gitDir, commonDir, index] = proc.stdout.trim().split("\n");
    found = { root, gitDir, commonDir: path.resolve(dir, commonDir), index: path.resolve(dir, index) };
    repos.set(dir, found);
  }
  return found;
}

export const repoRoot = (start = process.cwd()) => repo(start).root;

/**
 * Helix keeps runs (state, evidence, viewer) inside git's own directory, never
 * in the working tree, so formatters, linters and test runners never see them.
 * They live in the per-worktree git dir so parallel runs in separate worktrees
 * stay isolated. The team files (config and learnings) live in TEAM_DIR and are
 * committed with the code, so every engineer's agents apply the same rules.
 * @param {string} root
 */
export const runsDir = (root) => path.join(repo(root).gitDir, "helix", "runs");
/** @param {string} root */
export const sharedDir = (root) => path.join(repo(root).commonDir, "helix");
/** The team files' folder. Gates ignore it, so editing a team file never invalidates a gate. */
export const TEAM_DIR = ".helix";
/** @param {string} root */
export const teamConfigPath = (root) => path.join(root, TEAM_DIR, "config.json");
/**
 * One engineer's overrides of the team config, such as a reviewer CLI only they have. Never committed.
 * @param {string} root
 */
export const localConfigPath = (root) => path.join(sharedDir(root), "config.local.json");
/**
 * Where config and learnings lived before they moved into TEAM_DIR; `helix init` moves them.
 * @param {string} root
 * @param {"config.json" | "learnings.md"} name
 */
export const legacyPath = (root, name) => path.join(sharedDir(root), name);
/**
 * A run's plan and progress, committed with each of its checkpoints so a
 * teammate who checks out the branch can pick the run up.
 * @param {string} root
 * @param {string} runId
 */
export const sharedRunPath = (root, runId) => path.join(root, TEAM_DIR, "runs", `${runId}.json`);
/** Pathspec for the code under review: everything but the team files. */
export const CODE = ["--", ".", `:(exclude)${TEAM_DIR}`];

/** @param {string} root @param {string} runId */
export const runDir = (root, runId) => path.join(runsDir(root), runId);
/** @param {string} root @param {string} runId */
export const workDir = (root, runId) => path.join(runDir(root, runId), "work");

/**
 * Hash of the working tree (tracked + untracked, minus ignored files and the
 * team files). Computed through a throwaway index so the user's real index is
 * untouched. Any edit to code or tests changes it, which invalidates earlier gates.
 * @param {string} root
 * @returns {string}
 */
export function fingerprint(root) {
  const known = fingerprints.get(root);
  if (known) return known;
  const realIndex = repo(root).index;
  const fp = codeTree(root, (env, index) => {
    if (fs.existsSync(realIndex)) {
      // Keep the index's mtime: git re-hashes "racily clean" files (edited in
      // the same second the index was written) only when their mtime is not
      // older than the index file's. A fresh mtime would hide such edits.
      fs.copyFileSync(realIndex, index);
      const { atime, mtime } = fs.statSync(realIndex);
      fs.utimesSync(index, atime, mtime);
    }
    git(root, ["add", "-A"], env);
  });
  fingerprints.set(root, fp);
  return fp;
}

/**
 * Fingerprints computed during this command. Helix itself never edits the
 * code, so one stays valid until Helix runs something that may: the test
 * command, a reviewer or a commit hook. Each calls treeMayHaveChanged().
 * @type {Map<string, string>}
 */
const fingerprints = new Map();
export const treeMayHaveChanged = () => fingerprints.clear();

/**
 * The tree a throwaway index holds once `fill` has populated it, minus the team files.
 * @param {string} root
 * @param {(env: NodeJS.ProcessEnv, index: string) => void} fill
 * @returns {string}
 */
export function codeTree(root, fill) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-"));
  try {
    const index = path.join(tmp, "index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    fill(env, index);
    git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", TEAM_DIR], env);
    return git(root, ["write-tree"], env);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {string} root @returns {string | null} */
export function head(root) {
  return sh(["git", "rev-parse", "--verify", "-q", "HEAD"], root, { check: false }).stdout.trim() || null;
}

/** @param {string} root @returns {string[]} */
export function dirtyFiles(root) {
  return git(root, ["status", "--porcelain", ...CODE]).split("\n").filter((l) => l.trim());
}

/**
 * The calling agent session, so hooks guard the right session. Claude Code and
 * Codex export theirs to commands they run; another harness can export
 * HELIX_SESSION_ID. When one agent runs inside the other both are set, and the
 * nearest agent in the process tree is the caller.
 * @returns {string | null}
 */
export function sessionId() {
  const claude = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const codex = process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || null;
  if (!claude || !codex) return claude ?? codex ?? (process.env.HELIX_SESSION_ID || null);
  const claudePid = Number(process.env.CLAUDE_PID);
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    if (pid === claudePid) return claude;
    const [ppid, ...command] = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/);
    if (/codex/i.test(command.join(" "))) return codex;
    pid = Number(ppid);
  }
  return claude;
}
