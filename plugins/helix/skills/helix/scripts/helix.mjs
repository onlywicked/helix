#!/usr/bin/env node
/**
 * Helix: a checkpoint-and-gate state machine for agent-driven development.
 *
 * The orchestrating agent drives the work; this CLI is the part it cannot argue
 * with. Every gate verdict is produced here (tests are run here, reviewers are
 * launched here as isolated processes), every verdict is bound to a fingerprint
 * of the working tree, and a checkpoint can only be committed when all of its
 * gates passed against the exact tree being committed.
 *
 * Run `node helix.mjs help` for commands. Plain JavaScript on Node.js 18 or
 * later, no dependencies and no build step.
 */

import * as nodeModule from "node:module";

// Hooks start this CLI on every prompt, so start-up time matters. Node 22.1+
// caches compiled modules; it must be on before the CLI's modules load.
nodeModule.enableCompileCache?.();
const { main } = await import("./lib/cli.mjs");
await main(process.argv.slice(2));
