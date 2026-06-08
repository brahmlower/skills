---
name: go-improve-coverage
description: Improve test coverage in Go projects by delegating to focused subagents. Use this skill when test coverage is below a target threshold, when a CI coverage gate is failing, or when adding new code that lacks tests. The skill groups coverage gaps by package, creates a serial task list, and dispatches one subagent per package.
---

## Argument

An optional path argument scopes the skill to a subdirectory — useful for monorepos where each service or module lives under its own directory:

```
/go-improve-coverage ./services/billing
```

If no argument is provided, the skill operates on the entire module (`./...`). The argument is used as the root for all `go test` commands throughout this skill — replace `<target>` with `<arg>/...` (e.g. `./services/billing/...`) or `./...` if omitted.

---

## Overview

Low coverage often signals undertested logic, but it can also signal code that is hard to test because of poor architecture. This skill treats both as fixable: subagents are given explicit permission to refactor interfaces and implementations when doing so improves testability.

**Ground rules:**

- Tests must assert real behavior — stubs that touch lines without verifying outcomes are not acceptable
- Research subagents run in parallel — they read code and produce plans, making no changes
- Implementation subagents run serially to prevent conflicting edits
- Refactoring for testability is encouraged; adding `// coverage: ignore` directives without escalation is not

---

## Step 1: Measure baseline coverage

Run the full test suite with coverage and capture per-function output:

```bash
go test -coverprofile=coverage.out <target> 2>&1
go tool cover -func=coverage.out 2>&1
```

If the project has a Taskfile or Makefile test/coverage target, prefer that — but verify it respects the scoped path if one was provided. Record:

- The **total coverage percentage** (last line of `go tool cover -func` output)
- Every function line showing `0.0%` or meaningfully below the target
- The **target threshold** — default to `95%` unless the user specified otherwise

To identify which specific lines are uncovered, filter the func output and group by package:

```bash
go tool cover -func=coverage.out | grep -v "100.0%"
```

Exclude generated files, vendor code, and `main()` entry points from the gap list — these are rarely worth covering.

**Rank packages by impact before proceeding.** For each package with gaps, count the number of uncovered functions — this is the proxy for uncovered lines. Sort packages descending by uncovered function count and label them by tier:

- **High-impact tier**: packages that together account for ~80% of all uncovered functions
- **Tail tier**: the remaining packages

The high-impact tier is the focus of every round's research. The tail tier is addressed in later rounds once the high-impact tier is resolved. If two packages have similar uncovered function counts but one is a dependency of the other, the dependency ranks higher — fixing it may cascade coverage gains to its dependents.

---

## Step 2: Select packages for this round

Each round researches only the **high-impact tier** identified in Step 1 — the packages that together account for ~80% of remaining uncovered functions. Do not spread research across every package with a gap; the tail is addressed in later rounds once the high-impact work is done.

If this is round 2 or later, re-run the Step 1 ranking against the updated coverage output. The high-impact tier will have shifted as prior rounds resolved gaps.

---

## Step 3: Create a research task per selected package

Use `TaskCreate` for each package in this round's high-impact tier:

- Name: `Research coverage gaps: <package> (<N> uncovered functions, rank #<K>)`
- Description: one line per uncovered function — `<file>:<line> — <function> (<coverage%>)`

---

## Step 4: Dispatch research subagents in parallel

Spawn all research subagents at once — they make **no code changes**, only read and plan.

### Research subagent prompt template

```
You are researching coverage gaps in a Go package. Do NOT write or modify any code.

Package: <package path>
Current coverage: <X%>
Target coverage: <Y%>
Uncovered functions:
  <file>:<line> — <function> (<coverage%>)
  ...

Project root: <path>
Scope: <target>

Instructions:
1. Read every file in the package. Then read its direct dependents and
   dependencies — you need to understand not just what this package does, but
   what else becomes testable if this package's structure improves. Do not
   modify any files.

2. Think ambitiously. Your goal is not to find the minimum change that adds a
   few tests — it is to find the highest-leverage change that unlocks the most
   coverage across the codebase. A refactor that makes one package injectable
   may allow 5 dependent packages to be tested for the first time.

3. For each uncovered function, assess:
   - What behavior is untested and why
   - Whether new test cases alone are sufficient, or whether the code needs to
     be refactored to be testable at all

4. If a refactor is needed, describe it concretely:
   - What the current structure is and why it resists testing
   - What the proposed change is (e.g. extract interface, inject dependency,
     split pure logic from side effects)
   - Which other packages would become easier to test as a result, and roughly
     how many of their currently uncovered functions would be unlocked

5. If a function cannot be meaningfully tested (OS boundary, log.Fatal with no
   injection point, dead code), say so explicitly and explain why.

Return your findings as a structured plan using this format:

---PLAN---
package: <package>
estimated_functions_unlocked: <N direct> + <M cascade across other packages>
functions:
  - name: <function>
    file: <file>:<line>
    approach: <tests only | refactor required | untestable>
    notes: <what tests to write, or what refactor is needed, or why it's untestable>
    cascade_packages: <list of other packages that become more testable, or "none">
---END PLAN---
```

After all research subagents complete, collect all `---PLAN---` blocks and proceed to Step 5.

---

## Step 5: Synthesize plans and create implementation tasks

Review all plans together before creating any implementation tasks. This is the most important step — decisions made here determine how much coverage this round actually moves.

**Rank by estimated impact first.** Sum each plan's `estimated_functions_unlocked` (direct + cascade). Sort plans highest to lowest. The highest-impact work goes first — this is more important than any other ordering consideration.

**Look for cross-package refactor opportunities:** if multiple plans recommend similar structural changes (e.g. extracting the same dependency behind an interface), a single well-scoped refactor may resolve gaps in several packages at once. When you spot this, consolidate into one implementation task and re-estimate the combined impact.

**Assess scope:** some plans may recommend a major refactor to cover a minor function. Compare the estimated functions unlocked against the complexity of the proposed change. A smaller refactor or a targeted test double may achieve the same result with far less risk.

**Determine a feasible ordering:** implementation tasks that others depend on must go first, but within that constraint, sort by impact descending. Do not let dependency ordering push a high-impact task to the end of the list if it has no blockers.

Once the analysis is complete, create implementation tasks using `TaskCreate`:

- Name: `Implement: <short description of change> (~<N> functions unlocked)`
- Description: list the packages and functions addressed, the approach (tests only or refactor + tests), estimated functions unlocked (direct + cascade), and any cross-package changes required

---

## Step 6: Dispatch implementation subagents serially

Work through the implementation task list one at a time:

1. `TaskUpdate` → `in_progress`
2. Spawn the subagent using the prompt template below
3. **Wait for completion before starting the next task**
4. Run `go test -coverprofile=coverage.out ./<package>/... && go tool cover -func=coverage.out` to confirm coverage improved with no regressions (use full `<target>` scope if the package is not isolated)
5. `TaskUpdate` → `completed` (or `blocked` if an escalation was raised)

### Implementation subagent prompt template

```
You are implementing a coverage improvement plan for a Go project.

Project root: <path>
Scope: <target>

Plan:
<paste the relevant section(s) from the synthesized plan>

Instructions:
1. Read every file you will modify before touching anything.

2. Implement the plan as described. If the plan calls for a refactor, do the
   refactor first, then write the tests.

3. Write tests that assert real behavior — inputs, outputs, state changes, and
   error conditions. Do not write tests that merely call a function to increment
   line counts without verifying the result.

4. After implementing, run:
     go test -coverprofile=coverage.out ./<package>/...
     go tool cover -func=coverage.out
   If the package cannot be tested in isolation, use the full scope:
     go test -coverprofile=coverage.out <target>
     go tool cover -func=coverage.out | grep <package>
   Fix any compilation errors or test failures before reporting done.

5. If you discover that the plan is not feasible as written — for example because
   the proposed refactor would require changes beyond the described scope, or
   because a function turns out to be untestable — stop and emit the ESCALATION
   block below. Do not improvise a large unplanned refactor.

ESCALATION format — output exactly this if needed:
---ESCALATION---
task: <task name>
issue: <what makes the plan infeasible>
attempted: <what you tried>
suggestion: <revised approach or question for the primary agent>
---END ESCALATION---
```

---

## Step 7: Handle escalations

After each implementation subagent, scan its output for `---ESCALATION---` blocks.

For each one:

- Mark the task `blocked`
- Use `AskUserQuestion` — present the full escalation: what the plan called for, what the subagent found, and its suggestion
- **If the plan needs revision**: update the task description and dispatch a new subagent with the corrected plan
- **If dead code should be deleted**: confirm with the user, delete it, mark complete
- **If exclusion from coverage is warranted**: only accept for genuinely narrow cases (OS boundary, intentional panic path, generated glue code). Add a comment in the source explaining why, and note it in the final report

---

## Step 8: Final verification

After all tasks reach `completed` or `blocked`:

```bash
go test -coverprofile=coverage.out <target> 2>&1
go tool cover -func=coverage.out 2>&1
```

If the final run surfaces regressions (tests that now fail due to subagent changes), create tasks for them and resolve before closing.

**If total coverage still falls short of the target**, repeat from Step 1 — re-measure, re-rank, and re-select the new high-impact tier. Do not carry the previous round's gap list forward; always recompute from fresh coverage data so the ranking reflects what's actually remaining. Track how many full rounds have been attempted. After **3 complete rounds** without reaching the target, stop and report to the user:

- Coverage at each round (baseline → round 1 → round 2 → round 3)
- Packages still below target and why (blocked escalations, diminishing returns, architectural constraints)
- Any dead code deleted
- Any exclusions added, with justifications
- Any refactors made to improve testability

Then use `AskUserQuestion` to ask whether to continue with another round or accept the current state.
