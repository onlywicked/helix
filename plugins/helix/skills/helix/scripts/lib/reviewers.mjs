// Reviewers: context-isolated agent processes that return a verdict as JSON
// matching a schema. The CLI launches them, so the orchestrator never writes one.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { HelixError, readJson, writeJson } from "./core.mjs";
import { treeMayHaveChanged } from "./repo.mjs";

/** @import { ProcessResult, ReviewerSpec } from "./types.js" */

export const UI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "invalid_reason", "findings", "out_of_scope_notes"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL", "INVALID"] },
    invalid_reason: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "location", "element", "expected", "actual", "estimated_difference", "fixable_in_code"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          location: { type: "string" },
          element: { type: "string" },
          expected: { type: "string" },
          actual: { type: "string" },
          estimated_difference: { type: "string" },
          fixable_in_code: { type: "boolean" },
        },
      },
    },
    out_of_scope_notes: { type: "array", items: { type: "string" } },
  },
};

export const CODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes_requested"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "rule", "problem", "required_fix", "repeats"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: "string" },
          line: { type: "integer" },
          rule: { type: "string" },
          problem: { type: "string" },
          required_fix: { type: "string" },
          repeats: { type: "string" },
        },
      },
    },
  },
};

export const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "repeats", "recurs"],
        properties: {
          finding: { type: "string" },
          repeats: { type: "string" },
          recurs: { type: "string" },
        },
      },
    },
  },
};

export class ReviewerError extends Error {}

/** @type {Record<string, (v: any) => boolean>} */
const KIND_CHECKS = {
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  integer: Number.isInteger,
};

/**
 * Minimal validator for the schemas above (objects, arrays, enums, scalars).
 * @param {any} value
 * @param {any} schema
 */
function checkSchema(value, schema, where = "$") {
  const kind = schema.type;
  if (kind in KIND_CHECKS && !KIND_CHECKS[kind](value)) throw new ReviewerError(`reviewer output ${where}: expected ${kind}`);
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ReviewerError(`reviewer output ${where}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (kind === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new ReviewerError(`reviewer output ${where}: missing '${key}'`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) checkSchema(value[key], sub, `${where}.${key}`);
    }
  }
  if (kind === "array") value.forEach((/** @type {unknown} */ item, /** @type {number} */ i) => checkSchema(item, schema.items ?? {}, `${where}[${i}]`));
}

/**
 * @param {string[]} cmd
 * @param {{ cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number }} opts
 * @returns {Promise<ProcessResult>}
 */
function runProcess(cmd, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd, env: opts.env, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
    proc.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") resolve({ missing: true });
      else reject(error);
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8").on("data", (/** @type {string} */ chunk) => (stdout += chunk));
    proc.stderr?.setEncoding("utf8").on("data", (/** @type {string} */ chunk) => (stderr += chunk));
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      treeMayHaveChanged();
      resolve({ missing: false, stdout, stderr, code: code ?? signal, timedOut });
    });
    if (proc.stdin) {
      proc.stdin.on("error", () => {}); // a reviewer that exits without reading its prompt
      proc.stdin.end(opts.input);
    }
  });
}

/**
 * Launch one context-isolated reviewer process and return its verdict.
 *
 * Backends: claude (headless Claude Code, read-only tools, no project
 * settings), codex (read-only sandbox), exec (any command: prompt on stdin,
 * HELIX_SCHEMA_FILE in env, verdict JSON on stdout; use it to wrap Gemini).
 * @template T
 * @param {ReviewerSpec} spec
 * @param {string} prompt
 * @param {object} schema
 * @param {string[]} images
 * @param {string} root
 * @param {string} out
 * @param {number} timeoutSeconds
 * @returns {Promise<T>}
 */
export async function runReviewer(spec, prompt, schema, images, root, out, timeoutSeconds) {
  const backend = spec.backend ?? "claude";
  const stem = path.join(path.dirname(out), path.basename(out, ".json"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${stem}.prompt.md`, prompt);
  const schemaFile = `${stem}.schema.json`;
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const env = { ...process.env };
  delete env.CLAUDECODE; // allow launching an independent headless session
  /** @type {string[]} */
  let cmd;
  /** @type {string | undefined} */
  let input;
  const lastMessage = `${stem}.last.json`;
  if (backend === "claude") {
    cmd = ["claude", "-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob",
      "--no-session-persistence", "--setting-sources", ""];
    if (spec.model) cmd.push("--model", spec.model);
  } else if (backend === "codex") {
    // The prompt goes on stdin: `-i` takes every following argument as an image.
    cmd = ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
      "--output-schema", schemaFile, "-o", lastMessage, "-C", root];
    if (spec.model) cmd.push("-m", spec.model);
    for (const image of images) cmd.push("-i", image);
    input = prompt;
  } else if (backend === "exec") {
    if (!spec.command) throw new ReviewerError("exec reviewer needs a 'command' list");
    cmd = Array.isArray(spec.command) ? spec.command.map(String) : ["sh", "-c", spec.command];
    env.HELIX_SCHEMA_FILE = schemaFile;
    env.HELIX_IMAGES = images.join(path.delimiter);
    input = prompt;
  } else {
    throw new ReviewerError(`unknown reviewer backend '${backend}'`);
  }
  const result = await runProcess(cmd, { cwd: root, env, input, timeoutMs: timeoutSeconds * 1000 });
  if (result.missing) throw new ReviewerError(`reviewer backend '${backend}' is not installed (${cmd[0]} not found)`);
  fs.writeFileSync(`${stem}.raw.txt`, `$ exit ${result.code}\n${result.stdout}\n--- stderr\n${result.stderr}`);
  if (result.timedOut) throw new ReviewerError(`reviewer timed out after ${timeoutSeconds}s`);
  if (result.code !== 0) {
    throw new ReviewerError(`reviewer exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-800)}`);
  }
  /** @type {any} */
  let verdict;
  try {
    if (backend === "claude") {
      const envelope = JSON.parse(result.stdout);
      if (envelope.is_error) throw new ReviewerError(`reviewer error: ${envelope.result}`);
      verdict = envelope.structured_output ?? JSON.parse(envelope.result ?? "");
    } else if (backend === "codex") {
      verdict = readJson(lastMessage);
    } else {
      verdict = JSON.parse(result.stdout);
    }
  } catch (error) {
    if (error instanceof ReviewerError) throw error;
    throw new ReviewerError(`reviewer returned unparseable output: ${/** @type {Error} */ (error).message}`);
  }
  checkSchema(verdict, schema);
  writeJson(out, verdict);
  return verdict;
}

/**
 * A prompt template with its {{PLACEHOLDERS}} filled; any left unfilled is a bug.
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function fill(template, values) {
  /** @type {Set<string>} */
  const missing = new Set();
  const text = template.replace(/\{\{(\w+)\}\}/g, (match, /** @type {string} */ key) => {
    if (key in values) return values[key];
    missing.add(match);
    return match;
  });
  if (missing.size) throw new HelixError(`Prompt template has unfilled placeholders: ${[...missing].join(", ")}`);
  return text;
}
