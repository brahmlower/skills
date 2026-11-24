---
name: bug-hunt
description: >
  Multi-round bug review and research over a PR, branch, or Go package, run as a workflow of
  subagents: find candidate bugs, dedupe them against existing GitHub issues, research and verify
  each one (reproducing high-severity bugs with a failing test), follow related findings for up
  to 3 rounds, cross-reference everything into shared contracts, plan and align fixes, then
  surface ONE final report and file issues only after human approval. Use when the user says
  "bug hunt", "hunt for bugs in", "research these bugs", "review and research PR #N", "find bugs
  in package X and plan fixes", "investigate these review findings and file issues", or wants
  review findings turned into researched, deduplicated, aligned GitHub issues.
---

# Bug Hunt

Review a target for bugs, research the findings in rounds, cross-reference them against each other
and existing issues, plan aligned fixes, and present everything once at the end. Invoking this skill
authorizes the Workflow tool for this run.

## Why a workflow

The orchestrator's context must stay small. Two facts shape the design:

- **Subagents cannot write report files.** The harness blocks it with: "Subagents should return
  findings as text, not write report files. Include this content in your final response instead."
  The supported route is the agent's final response; in a workflow that is its `agent()` return
  value (a schema-validated object).
- **Background agents' final responses land in the orchestrator's context.** With plain Agent
  calls, every report arrives as a task notification. A previous run grew to ~540K tokens this way.

So all agent work runs inside `scripts/bug-hunt.workflow.js`. Results stay in script variables, are
recorded in the run's `journal.jsonl` on disk, and only a compact summary is returned to you.
`scripts/pull.sh` reads any individual result back from the journal when one is needed.

## Rules

1. **Never route around a harness guard.** If a tool is blocked, follow the route the block message
   names; if it names none, stop and report the block. Never suggest, or try, the same action
   through another tool (Bash heredoc instead of Write, and so on). The workflow's agents are given
   this rule too.
2. **Stay small.** Don't read agent transcripts, the journal, or full reports or drafts. Use the
   workflow's return value; use `pull.sh` only for a specific field you need for a decision.
3. **Stay quiet.** The workflow's `log()` lines reach the user directly, including interrupts. While
   it runs, respond only to the user; when a notification isn't the workflow finishing, end the
   turn without user-facing text.
4. **No outward actions before approval.** Nothing is created or posted on GitHub until the user
   approves the final report.

## Limits (passed to the workflow; defaults shown)

| Limit | Default | Behavior |
|---|---|---|
| `rounds` | 3 | Investigation rounds |
| `total` | 15 | Findings researched in total (duplicates don't count) |
| `round1` | 8 | Round 1's share, so later rounds have room for related findings |
| `align` | 3 | Alignment iterations |

Round-1 candidates over the share go to a backlog that later rounds draw from after their new
candidates, so the budget isn't wasted if research finds nothing new. Anything left when the
caps are hit is **deferred** and listed in the report.

Severity: **high** = security or tenancy exposure, data loss or corruption, silent wrong results,
outage, or permanent failure of a core path. **High severity requires reproduction** (a failing
test in a worktree); if impossible locally, a manual recipe, and the finding shows in "needs your
attention". Verification: every high finding, every confirmed finding that wasn't reproduced, and
one medium per cluster as a sample, each by a fresh verifier that doesn't see the researcher's
reasoning.

## Steps

### 1. Pin the target (you, a few small commands)

- PR: `gh pr view <N> --json headRefOid,baseRefName,headRefName,url`.
- Branch: `git rev-parse <branch>` and the merge base with the default branch.
- Package: `git rev-parse HEAD`; scope is the package directory.
- Find every repo involved (e.g. an infra repo whose config deploys the target) with its GitHub
  `owner/repo` name and local path. Ask only if you can't find one.
- Workspace: `~/.claude/bug-hunt/<repo>-<slug>-<sha7>/` (`<slug>` = `pr<N>`, branch name, or
  package path with `/` → `-`). Write `RUN.md` there: target, SHA, args, and later the run id.

### 2. Launch the workflow

```
Workflow({
  scriptPath: "~/.claude/skills/bug-hunt/scripts/bug-hunt.workflow.js",   // expand ~ to the absolute path
  args: {
    target: "yardrail/cloud services/registry",
    scope: "package services/registry: its code, callers, tests, Dockerfile and deploy config",
    sha: "<full sha>", base: "<base sha or empty>",
    targetRef: "<branch or origin/main>", defaultBranch: "main",
    startTime: "<ISO timestamp from `date -u +%FT%TZ`>",
    repos: [{ name: "yardrail/cloud", path: "/abs/path/cloud" }],
    seeds: [],            // [{claim, location, severity}] from the user, if any
    seedsOnly: false,     // true when the user said "only these"
    limits: { rounds: 3, total: 15, round1: 8, align: 3 }
  }
})
```

Record the returned run id in `RUN.md`. Tell the user in one line that it's running and that they'll
see progress lines and any interrupt directly. Then wait.

**Interrupts:** the workflow logs `⚠ INTERRUPT` when a verifier confirms live security or
data-loss impact. If the user asks about one while the run continues, answer from the log line;
use `pull.sh <run> verify <id> checks_md` if they want the evidence.

**Resume:** in the same session, `Workflow({scriptPath, args, resumeFromRunId})` replays finished
agents from cache. In a new session, start a new run with the earlier ledger's confirmed findings as
`seeds`.

### 3. Present the report

The return value holds `report_md`, `ledger`, `landing_order`, `drafts` and `comments` (indexes,
not bodies), `interrupts`, `open_questions`, `rounds_run` and `alignment`. Save `report_md` to the
workspace as `REPORT.md`, then show it to the user in full; it is the one long thing you read.

Ask (AskUserQuestion, multiSelect where it fits): which issues to file, which comments to post,
the open questions, and how to handle any interrupt finding (normal issue, or privately first).
Collect any edits the user wants to a draft as instructions; don't rewrite drafts yourself.

### 4. File (after approval only)

Spawn one `filer` agent (Agent tool, foreground):

```
File approved bug-hunt drafts from workflow run <runId>. Read drafts with
~/.claude/skills/bug-hunt/scripts/pull.sh <runId> draft <key> title|body|repo|ids
and comments with: pull.sh <runId> comment <key> target|body.
Approved issues, in landing order: <keys>. Approved comments: <keys>.
Edits to apply before filing: <per key, the user's instructions, or "none">.
1. Create each issue in its repo, piping the body (`... | gh issue create --repo R --title T
   --body-file -`); no temp files. Apply the repo's bug label if `gh label list` has one, and any
   other filing conventions in the repo's CLAUDE.md/AGENTS.md (e.g. project boards).
2. When all numbers are known, replace every #Fnn placeholder in each created body with the real
   reference (#N in the same repo, owner/repo#N across repos; plain text for unfiled findings) and
   `gh issue edit --body-file -`.
3. Post approved comments with placeholders substituted.
4. End the body with the attribution footer this session defines for issues/PRs, if any.
If any action is blocked, follow the route the block message names; if none, stop and report it.
Final response: one line per key, `<key> → <url>`, and one line per comment. Nothing else.
```

Append its result to `REPORT.md` under `## Filed`.

### 5. Final message

Three to six lines: issues filed, comments posted, deferred count, open questions still awaiting an
answer, and the workspace path.
