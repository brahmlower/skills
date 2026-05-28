---
name: go-lint-fix
description: Fix golangci-lint errors in Go projects by delegating to focused subagents. Use this skill whenever golangci-lint reports errors — pre-commit hooks, CI failures, or during development. Also invoke when you find yourself considering a //nolint directive as a workaround, or when lint errors are blocking a commit. The skill groups violations by lint rule, creates a serial task list, and dispatches one subagent per rule group — keeping the main agent's context clean and producing proper fixes rather than suppressions.
---

## Overview

Lint violations in Go often require real refactoring: extracting functions to reduce complexity, restructuring error handling, fixing whitespace conventions. When the main agent is deep into a task, it's tempting to reach for `//nolint` as a shortcut. This skill offloads the work to fresh subagents with full context budgets.

**Ground rules:**

- `//nolint` directives are almost never correct — see "Escalation" below
- Subagents run **serially** to prevent conflicting edits
- Each subagent owns exactly one lint rule group
- Subagents consult `references/rules.md` before touching any code

---

## Step 1: Gather current violations

Run lint on the affected scope:

```bash
golangci-lint run ./... 2>&1
```

If the project has a Taskfile or Makefile lint target, prefer that. Collect all output lines of the form:
`<file>:<line>:<col>: <message> (<rule>)`

---

## Step 2: Group by rule

Bucket every violation by its rule identifier (e.g. `cognitive-complexity`, `nilerr`, `wsl_v5`). Each bucket becomes one task.

**Recommended ordering** — fix structural issues before style issues, since refactoring changes line numbers that style rules depend on:

1. Complexity rules — `cognitive-complexity`, `cyclomatic`, `function-length`
2. Error-handling rules — `nilerr`, `wrapcheck`
3. Style / whitespace rules — `nlreturn`, `noinlineerr`, `wsl_v5`, `lll`, `line-length-limit`
4. Everything else

---

## Step 3: Create a task per rule group

Use `TaskCreate` for each bucket:

- **Name**: `Fix <rule> violations (<N> instances)`
- **Description**: one line per violation — `<file>:<line> — <message>`

---

## Step 4: Dispatch subagents serially

Work through the task list one at a time:

1. `TaskUpdate` → `in_progress`
2. Spawn the subagent using the prompt template below
3. **Wait for completion before starting the next task**
4. Run `golangci-lint run <modified files>` — confirm no new violations on modified lines
5. `TaskUpdate` → `completed` (or `blocked` if an escalation was raised)

### Subagent prompt template

```
You are fixing golangci-lint violations in a Go project.

Lint rule: <rule>
Violations to fix:
  <file>:<line> — <message>
  ...

Project root: <path>
Lint config: <path to .golangci.yml if present, otherwise "none">
Rule reference: <skill-path>/references/rules.md

Instructions:
1. Read the rule reference before touching any code. It has worked examples for
   common rules. Follow the patterns it describes.

2. Read each affected file and understand the surrounding context before editing.

3. Fix every listed violation. Do NOT add //nolint directives. They are almost
   never the right answer — the reference explains proper resolutions.

4. After fixing, run: golangci-lint run <affected files>
   If new violations appear in lines you modified, fix those too.

5. If after two genuinely different approaches the violation still cannot be
   resolved, or if you believe a //nolint is the only viable option, stop
   editing and emit the ESCALATION block below. Do not guess or add workarounds.

6. If you find yourself repeatedly struggling with a rule not covered well in
   the reference doc, note it in your ESCALATION so the guidance can be improved.

ESCALATION format — output exactly this if needed:
---ESCALATION---
rule: <rule>
violations:
  - <file>:<line> — <message>
approaches_tried:
  - <first approach and why it failed>
  - <second approach and why it failed>
nolint_requested: <true/false>
nolint_justification: <if true — specific reason why no structural fix is possible>
guidance_gap: <describe what additional guidance in rules.md would have helped>
---END ESCALATION---
```

---

## Step 5: Handle escalations

After each subagent, scan its output for `---ESCALATION---` blocks.

For each one:

- Mark the task `blocked`
- Use `AskUserQuestion` — present the full escalation: what was tried, why it failed, whether a `//nolint` is being requested
- **If user approves a `//nolint`**: add it yourself with an inline comment explaining the reasoning. A future reader (human or agent) must understand why this specific violation was suppressed
- **If user provides alternative guidance**: add it to `references/rules.md` before retrying, then dispatch a new subagent for that task
- **If a `guidance_gap` is noted but no escalation needed**: still flag it to the user at the end as an opportunity to improve the rule reference

---

## Step 6: Final verification

After all tasks reach `completed` or `blocked`:

```bash
golangci-lint run ./...
```

Report to the user:

- How many violations were fixed
- Any `//nolint` directives added, with justifications
- Any tasks left blocked
- Any rules where subagents flagged a guidance gap in `references/rules.md`

If the final run surfaces new violations introduced by subagent changes, create tasks for them and repeat from Step 3.

---

## On nolint directives

A `//nolint` comment is **not a fix** — it hides a problem from the linter while leaving the underlying issue in the code. The cases where one is genuinely warranted are rare and narrow: for example, an error that is semantically meaningless in a specific, well-understood context where restructuring would make the code _less_ clear, not more.

If a subagent escalates requesting one, treat it with skepticism. The bar is: _would a senior Go engineer reading this code agree that no structural fix is reasonable here?_ If yes, approve it and make sure the comment explains why. If no, push back and ask the subagent for another approach.

A pattern of escalations on the same rule is a signal that `references/rules.md` is missing useful guidance — not that `//nolint` is appropriate.
