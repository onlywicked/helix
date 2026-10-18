You decide whether code review findings repeat earlier ones. Reviewers sometimes raise a problem again in new words without saying so. Your answer decides which findings keep their history, so match only what is clearly the same problem.

## Findings to match

Each reviewer's new findings below did not say whether they repeat an earlier one. Compare each new finding only with that reviewer's own earlier findings, and with the problems fixed in earlier checkpoints.

{{REVIEWERS}}

Problems fixed in this run's earlier checkpoints:
{{FIXED}}

## Rules

- `repeats`: the id of the reviewer's earlier finding (for example `F3`) when the new finding describes the same problem in the same code. A different problem in the same file, or the same kind of problem in different code, is not a repeat.
- `recurs`: the id of a problem fixed in an earlier checkpoint (for example `cp-1 F2`) when the new finding is the same mistake made again, in this checkpoint's code.
- When unsure, leave the field empty. An empty field keeps the finding as a new one, which is always safe.
- Use only the ids listed above. Do not read or judge the code; judge only whether the findings describe the same problem.

## Output

Return only this JSON object, with no prose around it. Give one entry per new finding:

```json
{
  "matches": [
    {"finding": "R1-1", "repeats": "F3", "recurs": ""},
    {"finding": "R2-1", "repeats": "", "recurs": "cp-1 F2"}
  ]
}
```
