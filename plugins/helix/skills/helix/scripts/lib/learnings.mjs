// The team's learnings in .helix/learnings.md: engineer feedback that every
// agent and reviewer applies, including feedback given in other worktrees.

import * as fs from "node:fs";
import * as path from "node:path";
import { git, now, sh } from "./core.mjs";
import { head, TEAM_DIR } from "./repo.mjs";

/** @param {string} root */
export const learningsPath = (root) => path.join(root, TEAM_DIR, "learnings.md");

export const UNMERGED_LEARNINGS = "From this repository's other worktrees, not merged into this branch yet (apply them too):";
export const LEARNING_SAVED = `Learning saved to ${TEAM_DIR}/learnings.md; the checkpoint commit includes it, so the team gets it on merge.`;

/** @param {string} root */
export function readLearnings(root) {
  const file = learningsPath(root);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

/** @param {string} root @param {string} text @param {string} source */
export function appendLearning(root, text, source) {
  appendLearningLines(root, [`- ${text.trim()} _(from ${source}, ${now().slice(0, 10)})_`]);
}

/** @param {string} root @param {string[]} lines */
export function appendLearningLines(root, lines) {
  const file = learningsPath(root);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# Helix learnings\n\nEngineer feedback that every Helix agent and reviewer applies.\n\n");
  }
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(""));
}

/**
 * The learnings themselves (one bullet each) in a learnings file's text.
 * @param {string} text
 */
export const learningLines = (text) => text.split("\n").filter((line) => line.startsWith("- "));

/**
 * Learnings given in this clone's other worktrees that have not reached this
 * branch yet, so parallel runs apply the engineer's feedback before it is
 * merged. Only lines a worktree added since it forked from this branch count,
 * so a learning this branch removed stays removed.
 * @param {string} root
 * @returns {string[]}
 */
export function unmergedLearnings(root) {
  const own = new Set(learningLines(readLearnings(root)));
  const here = fs.realpathSync(root);
  const ours = head(root);
  /** @type {string[]} */
  const found = [];
  for (const entry of git(root, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (!entry.startsWith("worktree ")) continue;
    const other = entry.slice("worktree ".length);
    const file = learningsPath(other);
    if (!fs.existsSync(file) || fs.realpathSync(other) === here) continue;
    const theirs = head(other);
    const base = ours && theirs ? sh(["git", "merge-base", ours, theirs], root, { check: false }).stdout.trim() : "";
    const before = new Set(base
      ? learningLines(sh(["git", "show", `${base}:${TEAM_DIR}/learnings.md`], root, { check: false }).stdout)
      : []);
    for (const line of learningLines(fs.readFileSync(file, "utf8"))) {
      if (!own.has(line) && !before.has(line) && !found.includes(line)) found.push(line);
    }
  }
  return found;
}

/**
 * Every learning that applies here, for a reviewer prompt.
 * @param {string} root
 */
export function learningsForReview(root) {
  const own = readLearnings(root) || "(none yet)";
  const unmerged = unmergedLearnings(root);
  return unmerged.length ? `${own}\n\n${UNMERGED_LEARNINGS}\n${unmerged.join("\n")}` : own;
}
