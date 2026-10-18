// Code review findings, tracked across review attempts: the fixer answers each
// one (fixed or disputed), and the engineer settles those that go in circles.

import * as fs from "node:fs";
import * as path from "node:path";
import { HelixError, now, oneLine, pad3 } from "./core.mjs";
import { workDir } from "./repo.mjs";
import { ReviewerError } from "./reviewers.mjs";

/** @import { Checkpoint, FixerResponse, MatchVerdict, ReviewResult, Run, TrackedFinding } from "./types.js" */

/** Raised this many times since the engineer last ruled on it, a finding goes to the engineer. */
const STUCK_AFTER = 3;

export const RESPONSE_FORMAT = '{"responses": [{"id": "F1", "status": "fixed", "note": "what you changed"}, ' +
  '{"id": "F2", "status": "disputed", "note": "why the finding is wrong, with evidence"}]}';

/** @param {Checkpoint} cp */
export const openFindings = (cp) => (cp.findings ?? []).filter((f) => f.status === "open");

/** @param {TrackedFinding} f */
const lastRaised = (f) => /** @type {number} */ (f.raised.at(-1));

/**
 * The fixer has not answered the finding's latest raise yet.
 * @param {TrackedFinding} f
 */
export const unanswered = (f) => !f.responses.some((r) => r.attempt === lastRaised(f));

/** @param {TrackedFinding[]} findings */
export const sortFindings = (findings) =>
  [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id, "en", { numeric: true }));

/**
 * A finding the fixer and the reviewers are going in circles on: raised again
 * after the fixer disputed it, or raised STUCK_AFTER times since the engineer
 * last ruled on it. Only the engineer can settle it.
 * @param {TrackedFinding} f
 */
export function isStuck(f) {
  if (f.status !== "open") return false;
  const since = f.ruling?.attempt ?? 0;
  const last = lastRaised(f);
  return f.responses.some((r) => r.status === "disputed" && r.attempt > since && r.attempt < last) ||
    f.raised.filter((a) => a > since).length >= STUCK_AFTER;
}

/** @param {TrackedFinding} f */
function stuckReason(f) {
  const since = f.ruling?.attempt ?? 0;
  const disputed = f.responses.some((r) => r.status === "disputed" && r.attempt > since);
  return disputed ? `${f.id} (the fixer disputed it, the reviewer raised it again)`
    : `${f.id} (raised ${f.raised.filter((a) => a > since).length} times)`;
}

/** @param {string} rid @param {TrackedFinding[]} stuck */
export function needsRuling(rid, stuck) {
  return (`the reviewers and the fixer are going in circles on ${stuck.map(stuckReason).join(", ")}. Do not ` +
    `dispatch the fixer again; the engineer settles it. Ask them with \`helix ask ${rid} ` +
    `${stuck.map((f) => `--finding ${f.id}`).join(" ")}\`, which quotes each finding and the fixer's answer. Then ` +
    `record each ruling with \`helix rule ${rid} <id> fix|drop --text '<their words>'\`.`);
}

/** @param {TrackedFinding} f */
export function describeFinding(f) {
  const history = f.raised.length > 1 ? `, raised in review attempts ${f.raised.join(", ")}` : "";
  const lines = [
    `- ${f.id} [${f.severity}] ${f.file}:${f.line} (${f.rule}), ${f.lens} reviewer${history}`,
    `  Problem: ${oneLine(f.problem)}`,
    `  Required fix: ${oneLine(f.required_fix)}`,
  ];
  for (const r of f.responses) {
    lines.push(`  Fixer's answer to attempt ${r.attempt}: ${r.status}${r.note ? ` - ${oneLine(r.note)}` : ""}`);
  }
  if (f.ruling) {
    const decision = f.ruling.decision === "fix" ? "it must be fixed" : "the finding is wrong; it is dropped";
    lines.push(`  Engineer's ruling: ${decision} - "${oneLine(f.ruling.text)}"`);
  }
  return lines.join("\n");
}

/** @param {string} root @param {string} rid @param {Checkpoint} cp @param {number} attempt */
export const responsePath = (root, rid, cp, attempt) =>
  path.join(workDir(root, rid), "fixes", `${cp.id}-review-${pad3(attempt)}.json`);

/**
 * @param {string} file
 * @returns {{ id: string; status: FixerResponse["status"]; note: string }[]}
 */
function parseResponses(file) {
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new HelixError(`${file} is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  if (!Array.isArray(data?.responses)) throw new HelixError(`${file} must look like ${RESPONSE_FORMAT}`);
  return data.responses.map((/** @type {any} */ item, /** @type {number} */ i) => {
    const id = String(item?.id ?? "").trim().toUpperCase();
    const note = String(item?.note ?? "").trim();
    if (!id || !["fixed", "disputed"].includes(item?.status)) {
      throw new HelixError(`${file}: responses[${i}] needs an "id" and a "status" of "fixed" or "disputed".`);
    }
    if (item.status === "disputed" && !note) {
      throw new HelixError(`${file}: ${id} is disputed without evidence. Its "note" must say why the finding is wrong.`);
    }
    return { id, status: item.status, note };
  });
}

/**
 * Before the review runs again, the fixer must have answered every open
 * finding of the review it fixed: fixed, or disputed with evidence. The
 * reviewers see those answers, and a finding they raise again after a dispute
 * goes to the engineer instead of another round.
 * @param {string} root
 * @param {Run} run
 * @param {Checkpoint} cp
 */
export function takeFixerResponses(root, run, cp) {
  const stuck = openFindings(cp).filter(isStuck);
  if (stuck.length) throw new HelixError(`${cp.id}: ${needsRuling(run.id, stuck)}`);
  const due = openFindings(cp).filter(unanswered);
  /** @type {string[]} */
  const missing = [];
  for (const attempt of new Set(due.map(lastRaised))) {
    const file = responsePath(root, run.id, cp, attempt);
    const raised = due.filter((f) => lastRaised(f) === attempt);
    for (const answer of fs.existsSync(file) ? parseResponses(file) : []) {
      const f = raised.find((x) => x.id === answer.id);
      if (!f || !unanswered(f)) {
        throw new HelixError(`${file}: ${answer.id} is not an unanswered finding of review attempt ${attempt} ` +
          `(those are ${raised.map((x) => x.id).join(", ")}).`);
      }
      if (answer.status === "disputed" && f.ruling?.decision === "fix") {
        throw new HelixError(`${file}: the engineer ruled that ${f.id} must be fixed, so it cannot be disputed.`);
      }
      f.responses.push({ attempt, ...answer });
    }
    const left = raised.filter(unanswered).map((f) => f.id);
    if (left.length) missing.push(`${left.join(", ")} in ${file}`);
  }
  if (missing.length) {
    throw new HelixError(`The fixer has not answered every review finding: ${missing.join("; ")}. Dispatch it ` +
      `with \`helix brief ${run.id} fixer\`, or complete the file, as ${RESPONSE_FORMAT}. Then rerun the review.`);
  }
}

/**
 * Folds one review attempt into the checkpoint's findings. A finding a
 * reviewer raises again keeps its id; a reviewer's open finding it does not
 * raise again is resolved; one the engineer dropped never blocks again. A
 * reviewer that errored leaves its findings as they were.
 * @param {Checkpoint} cp
 * @param {number} attempt
 * @param {ReviewResult[]} results
 */
export function trackFindings(cp, attempt, results) {
  cp.findings ??= [];
  const all = cp.findings;
  const at = now();
  return results.map((result, index) => {
    const reviewer = index + 1;
    /** @type {string[]} */
    const raised = [];
    /** @type {string[]} */
    const ignored = [];
    if (!result.verdict) return { raised, ignored };
    const earlier = all.filter((f) => f.reviewer === reviewer && f.status !== "resolved");
    for (const finding of result.verdict.findings) {
      const { repeats, ...fields } = finding;
      const prior = earlier.find((f) => f.id === repeats.trim().toUpperCase() && !raised.includes(f.id));
      if (prior?.status === "dropped") {
        ignored.push(prior.id);
      } else if (prior) {
        Object.assign(prior, fields);
        prior.raised.push(attempt);
        prior.raised_at = at;
        raised.push(prior.id);
      } else {
        const id = `F${all.length + 1}`;
        all.push({ ...fields, id, reviewer, lens: result.lens, raised: [attempt], raised_at: at, status: "open", responses: [] });
        raised.push(id);
      }
    }
    for (const f of earlier) {
      if (f.status === "open" && !raised.includes(f.id)) {
        f.status = "resolved";
        f.resolved_in = attempt;
      }
    }
    return { raised, ignored };
  });
}

/**
 * What the reviewer raised on earlier attempts, for it to check again.
 * @param {Checkpoint} cp
 * @param {number} reviewer
 */
export function earlierFindings(cp, reviewer) {
  const mine = sortFindings((cp.findings ?? []).filter((f) => f.reviewer === reviewer && f.status !== "resolved"));
  const open = mine.filter((f) => f.status === "open");
  const dropped = mine.filter((f) => f.status === "dropped");
  if (!open.length && !dropped.length) return "None. Review the change from scratch.";
  const sections = [];
  if (open.length) sections.push(`Still open from your earlier reviews:\n\n${open.map(describeFinding).join("\n")}`);
  if (dropped.length) {
    sections.push("Dropped by the engineer. Their ruling is final: never raise these again, in any form:\n\n" +
      dropped.map(describeFinding).join("\n"));
  }
  return sections.join("\n\n");
}

/**
 * Review findings fixed in the run's committed checkpoints. Later briefs carry
 * them so subagents do not repeat them, and the finding matcher spots a repeat.
 * @param {Run} run
 */
export const fixedEarlier = (run) => run.checkpoints.filter((c) => c.status === "committed")
  .flatMap((c) => (c.findings ?? []).filter((f) => f.status === "resolved").map((f) => ({ cp: c.id, f })));

/** @param {{ cp: string; f: TrackedFinding }} fixed */
const fixedId = ({ cp, f }) => `${cp} ${f.id}`;

/** @param {{ cp: string; f: TrackedFinding }} fixed */
export const describeFixed = (fixed) => `- ${fixedId(fixed)} ${fixed.f.file}:${fixed.f.line} (${fixed.f.rule}): ` +
  `${oneLine(fixed.f.problem)} Fix: ${oneLine(fixed.f.required_fix)}`;

/**
 * The findings a reviewer reported without saying whether they repeat an
 * earlier one, with what they may repeat: that reviewer's earlier findings on
 * this checkpoint, and problems fixed in earlier checkpoints. Null when there
 * is nothing to match.
 * @param {Run} run
 * @param {Checkpoint} cp
 * @param {ReviewResult[]} results
 */
export function matchJob(run, cp, results) {
  const fixed = fixedEarlier(run);
  const reviewers = results.map((result, index) => {
    const reviewer = index + 1;
    const earlier = (cp.findings ?? []).filter((f) => f.reviewer === reviewer && f.status !== "resolved");
    const unmarked = (result.verdict?.findings ?? []).map((finding, i) => ({ id: `R${reviewer}-${i + 1}`, finding }))
      .filter(({ finding }) => !finding.repeats.trim());
    return { reviewer, earlier, unmarked: earlier.length || fixed.length ? unmarked : [] };
  }).filter((r) => r.unmarked.length);
  return reviewers.length ? { reviewers, fixed } : null;
}

/** @param {NonNullable<ReturnType<typeof matchJob>>} job */
export function matchInputs(job) {
  /** @param {{ file: string; line: number; rule: string; problem: string }} f */
  const where = (f) => `${f.file}:${f.line} (${f.rule}): ${oneLine(f.problem)}`;
  const reviewers = job.reviewers.map(({ reviewer, earlier, unmarked }) => [
    `### Reviewer ${reviewer}`,
    `Its earlier findings on this checkpoint:\n${earlier.map((f) => `- ${f.id} (${f.status}) ${where(f)}`).join("\n") || "(none)"}`,
    `Its new findings:\n${unmarked.map(({ id, finding }) => `- ${id} ${where(finding)}`).join("\n")}`,
  ].join("\n\n"));
  return { REVIEWERS: reviewers.join("\n\n"), FIXED: job.fixed.map(describeFixed).join("\n") || "(none)" };
}

/**
 * Marks each new finding the matcher matched: `repeats` to the reviewer's
 * earlier finding, `recurs` to a problem fixed in an earlier checkpoint. An
 * answer naming anything it was not shown is the matcher's error.
 * @param {NonNullable<ReturnType<typeof matchJob>>} job
 * @param {MatchVerdict} verdict
 */
export function applyMatches(job, verdict) {
  const fixed = new Set(job.fixed.map(fixedId));
  for (const match of verdict.matches) {
    const reviewer = job.reviewers.find((r) => r.unmarked.some((u) => u.id === match.finding));
    const entry = reviewer?.unmarked.find((u) => u.id === match.finding);
    if (!reviewer || !entry) throw new ReviewerError(`the finding matcher answered for unknown finding '${match.finding}'`);
    const repeats = match.repeats.trim().toUpperCase();
    const recurs = match.recurs.trim();
    if (repeats && !reviewer.earlier.some((f) => f.id === repeats)) {
      throw new ReviewerError(`the finding matcher matched ${match.finding} to '${repeats}', which is not one of that reviewer's earlier findings`);
    }
    if (recurs && !fixed.has(recurs)) {
      throw new ReviewerError(`the finding matcher matched ${match.finding} to '${recurs}', which is not a problem fixed in an earlier checkpoint`);
    }
    entry.finding.repeats = repeats;
    if (recurs) entry.finding.recurs = recurs;
  }
}

/**
 * A question asking the engineer to rule on review findings, quoting each one and the fixer's answer.
 * @param {Checkpoint} cp
 * @param {string[]} ids
 */
export function rulingQuestion(cp, ids) {
  const parts = ids.map((raw) => {
    const id = raw.trim().toUpperCase();
    const f = (cp.findings ?? []).find((x) => x.id === id && x.status === "open");
    if (!f) throw new HelixError(`${cp.id} has no open review finding ${id}.`);
    const answer = f.responses.at(-1);
    const fixer = answer
      ? ` The fixer ${answer.status === "disputed" ? "disputes it" : "says it fixed it"}${answer.note ? `: "${oneLine(answer.note)}"` : ""}.`
      : "";
    return `${f.id} (${f.lens} reviewer, ${f.file}:${f.line}, raised ${f.raised.length}x): "${oneLine(f.problem)}" ` +
      `Required fix: "${oneLine(f.required_fix)}".${fixer}`;
  });
  return `The code reviewers and the fixer disagree. ${parts.join(" ")} For each: is the finding right (fix it) ` +
    "or wrong (drop it)?";
}
