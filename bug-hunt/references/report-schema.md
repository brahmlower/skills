# Research report formats

Research agents return these as string fields of their final response (`report_md`, `summary_md`).
They never write them to files.

## Research report (`report_md`)

```markdown
# F04: <claim>

## Verdict
CONFIRMED | REFUTED | PARTIAL — one paragraph. Say how it differs from the original claim
(worse, narrower, different mechanism).

## Evidence
- `path/file.go:123` — what this line does and why it matters.
- Command → output, for every number or behavioral claim:
  `grep -rn "nolint:exhaustruct" cmd/... | grep -c corev1` → 8

## Reproduction
Evidence level, then one of:
- Failing test: name, file, how to run (project's test command), observed vs expected output.
  The diff is in `repro_patch`.
- Manual recipe (high severity, can't reproduce locally): numbered steps, environment needed,
  expected observation, and why local reproduction wasn't possible.
- Static only: why reproduction wasn't attempted (medium/low only).

## Mechanism
How the bug happens, step by step. Include external-system semantics (Kubernetes, Temporal,
SDKs, cloud APIs) with sources: doc URL, upstream source file and version, or observed behavior.

## Impact
Who hits it, how often, what they see. Production relevance with evidence (deploy config
file:line), or "not deployed".

## Existing issues
Related or overlapping issues/PRs and how this finding relates to each.

## Options
For each: approach, code areas touched, pros, cons, risks, coupling it introduces, assumptions it
bakes in. Mark the recommendation and why.
```

## Summary (`summary_md`)

At most 20 lines; must stand alone:

```markdown
F04 CONFIRMED high reproduced — <claim, corrected if research changed it>
Differs from claim: <one line, or "no">
Mechanism: <one or two lines>
Impact: <one line>
Options: A) <one line> B) <one line> C) <one line>
Recommend: <letter> because <reason>
Depends on / conflicts with: <finding ids, issues>
Needs user judgment: <one line, or "none">
```
