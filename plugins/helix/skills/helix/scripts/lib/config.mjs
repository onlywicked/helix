// The team config in .helix/config.json, with one engineer's overrides on top.

import * as fs from "node:fs";
import { clone, DEFAULT_CONFIG, HelixError, installed, readJson } from "./core.mjs";
import { legacyPath, localConfigPath, TEAM_DIR, teamConfigPath } from "./repo.mjs";

/** @import { Config } from "./types.js" */

/**
 * The defaults, then the team config, then the engineer's own overrides.
 * @param {string} root
 * @returns {Config}
 */
export function loadConfig(root) {
  if (fs.existsSync(legacyPath(root, "config.json"))) {
    throw new HelixError(`Helix now keeps the config and learnings in ${TEAM_DIR}/ in the repository, so everyone on the ` +
      `team shares them. Run \`helix init\` once to move them there, then commit ${TEAM_DIR}/.`);
  }
  const team = teamConfigPath(root);
  if (!fs.existsSync(team)) {
    throw new HelixError(`Helix is not initialized on this branch (no ${TEAM_DIR}/config.json). If your team set it up ` +
      "on another branch, merge or rebase onto it; otherwise run `helix init`.");
  }
  /** @param {unknown} v */
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  /** @type {any} */
  const merged = clone(DEFAULT_CONFIG);
  for (const file of [team, localConfigPath(root)].filter((f) => fs.existsSync(f))) {
    for (const [key, value] of Object.entries(readConfigFile(file))) {
      merged[key] = isObject(value) && isObject(merged[key]) ? { ...merged[key], ...value } : value;
    }
  }
  return merged;
}

/** @param {string} file @returns {Config} */
export function readConfigFile(file) {
  try {
    return readJson(file);
  } catch (error) {
    throw new HelixError(`${file} is not valid JSON (${/** @type {Error} */ (error).message}). Fix it, or resolve its merge conflict.`);
  }
}

/** Reviewers run on whichever agent CLI is installed, preferring Claude Code. */
export function defaultConfig() {
  const config = clone(DEFAULT_CONFIG);
  if (!installed("claude") && installed("codex")) {
    config.reviewers.ui = { backend: "codex" };
    config.reviewers.code = [{ backend: "codex", lens: "architecture" }, { backend: "codex", lens: "correctness" }];
    config.reviewers.matcher = { backend: "codex" };
  }
  return config;
}
