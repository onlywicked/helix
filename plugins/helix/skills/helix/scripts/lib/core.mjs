// Constants, errors and small utilities every part of Helix uses.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** @import { Config, Gate, Status } from "./types.js" */

/** The skill's own directory, the one holding SKILL.md. */
export const SKILL_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const PROMPTS_DIR = path.join(SKILL_DIR, "prompts");
export const CLI = path.join(SKILL_DIR, "scripts", "helix.mjs");

/** @type {ReadonlySet<Status>} */
export const ACTIVE = new Set(["planning", "building"]);
/** @type {readonly Gate[]} */
export const GATES = ["behavior", "ui", "review", "human"];
/** @type {Record<Gate, string>} */
export const GATE_NAME = { behavior: "behavior tests", ui: "UI review", review: "code review", human: "engineer" };
export const MAX_IDENTICAL_STOPS = 3;

/** @type {Config} */
export const DEFAULT_CONFIG = {
  test_command: "",
  test_timeout_seconds: 1800,
  guidelines: [],
  design: [],
  ui: { enabled: true, capture_notes: "" },
  reviewers: {
    ui: { backend: "claude", model: "opus" },
    code: [
      { backend: "claude", model: "opus", lens: "architecture" },
      { backend: "claude", model: "opus", lens: "correctness" },
    ],
    matcher: { backend: "claude", model: "opus" },
    timeout_seconds: 1200,
  },
};

/** A user-facing error: printed without a stack trace, exit code 1. */
export class HelixError extends Error {}

/** A gate ran and did not pass: exit with the given code after printing. */
export class GateExit extends Error {
  /** @param {number} code */
  constructor(code) {
    super(`gate exit ${code}`);
    /** @readonly */
    this.code = code;
  }
}

export const now = () => new Date().toISOString();
/** @template T @param {T} value @returns {T} */
export const clone = (value) => structuredClone(value);
/** @param {string} text */
export const words = (text) => text.split(/\s+/).filter(Boolean).length;
/** @param {string[]} items */
export const bullet = (items, empty = "(none)") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);
/** @param {string[]} items */
export const nested = (items) => (items.length ? items : ["(none)"]).map((i) => `  - ${i}`).join("\n");
/** @param {number} n */
export const pad3 = (n) => String(n).padStart(3, "0");
/** @param {string} text */
export const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/** @param {number} n @param {string} noun */
export const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** @param {string} text */
export const oneLine = (text) => text.replace(/\s*\n\s*/g, " ").trim();

/**
 * Whether a command is on the PATH, like `command -v`.
 * @param {string} command
 */
export function installed(command) {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return fs.statSync(path.join(dir, command)).isFile();
    } catch {
      return false;
    }
  });
}

/** @param {number} ms */
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv; check?: boolean }} [opts]
 */
export function sh(args, cwd, opts = {}) {
  const proc = spawnSync(args[0], args.slice(1), { cwd, env: opts.env, encoding: "utf8", maxBuffer: 256 << 20 });
  if (proc.error) throw new HelixError(`\`${args.join(" ")}\` could not run: ${proc.error.message}`);
  if ((opts.check ?? true) && proc.status !== 0) {
    throw new HelixError(`\`${args.join(" ")}\` failed:\n${(proc.stderr || proc.stdout).trim()}`);
  }
  return proc;
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function git(root, args, env) {
  return sh(["git", ...args], root, { env }).stdout.trim();
}

/** @param {string} file @param {unknown} data */
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** @param {string} file @returns {any} */
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** @param {string} file @returns {any} */
export function readJsonInput(file) {
  try {
    return readJson(file);
  } catch (error) {
    throw new HelixError(`Cannot read JSON from ${file}: ${/** @type {Error} */ (error).message}`);
  }
}

/** @param {string} text */
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

/** @param {string} slug */
export function humanize(slug) {
  const text = slug.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * [width, height] for PNG/JPEG, else null. Lets reviewers judge proportionally.
 * @param {string} file
 * @returns {[number, number] | null}
 */
export function imageSize(file) {
  const data = fs.readFileSync(file);
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = data[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
      i += 2 + data.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** @param {string} root @param {string} file */
export function relTo(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

/** @param {string} file */
export function openFile(file) {
  if (process.env.HELIX_NO_OPEN) return;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (installed(opener)) spawnSync(opener, [file], { stdio: "ignore" });
}
