---
name: go-build-profiler
description: Profile Go build performance and trace package dependencies using `-debug-actiongraph` and the `actiongraph` CLI. Trigger this skill whenever Go compilation is slow or taking too long — in CI, locally, or after adding new dependencies. Also trigger when the user wants to find which packages are the compile-time bottleneck, trace why an unexpected package is being included in the binary, diagnose why incremental builds recompile too much, or already has an `actiongraph.json` file and wants to analyze it. Trigger on any mention of `actiongraph top`, `actiongraph tree`, `actiongraph graph --why`, `-debug-actiongraph`, slow `go build`, compile time profiling, or Go build dependency graphs.
---

# Go Build Profiler

The primary tool for diagnosing slow Go builds is the **action graph** — a JSON file capturing per-package dependency and timing data, analyzed with the `actiongraph` CLI.

**Prerequisites** (check if present, install if not):
```bash
go install github.com/icio/actiongraph@latest
# brew install graphviz  # only needed if rendering SVGs
```

## Step 1: Check build cache health

Before profiling, understand whether the build is cold or warm:

```bash
go env GOCACHE
du -sh $(go env GOCACHE)
```

A missing or unusually small cache means every build is cold. A very large cache (10GB+) can slow lookups. Then clear it to get clean profiling data:

```bash
go clean -cache
```

## Step 2: Generate the action graph

```bash
go build -debug-actiongraph=actiongraph.json ./your/package
```

This captures per-package timing (`CmdReal`, `CmdUser`, `CmdSys`) and dependency edges for everything compiled.

## Step 3: Find the slowest packages

```bash
actiongraph top -f actiongraph.json
```

Lists packages ranked by wall-clock compile time with cumulative percentages. Add `-n0` to show all results instead of the default top 20.

## Step 4: Understand the namespace breakdown

```bash
actiongraph tree -f actiongraph.json
```

Aggregates compile time hierarchically by package path prefix. Useful for seeing which org/module is responsible for the most build time. Filter to a subtree:

```bash
actiongraph tree -f actiongraph.json -L 2 github.com
```

## Step 5: Trace why a specific package is compiled

If a package appears unexpectedly in `top` output, find every dependency path pulling it in:

```bash
actiongraph graph --why <package> -f actiongraph.json > why.dot
dot -Tsvg -Grankdir=LR < why.dot > why.svg
open why.svg
```

Each path in the graph is an import chain from the binary back to the package. Follow the chains to identify which of your direct or indirect dependencies is responsible.

## Interpreting results and finding wins

Once you know which packages are slow and why they're included:

1. **Split large packages** — a fat package that's frequently modified forces everything depending on it to recompile. Smaller packages limit the cascade.
2. **Eliminate unnecessary transitive dependencies** — if `graph --why` shows a heavy package pulled in for something minor, see if that dependency can be scoped or replaced.
3. **Isolate frequently-changing code** — put hot code in packages with few dependents so a change only triggers a small recompile.

## Quick reference

| Goal | Command |
|------|---------|
| Check cache | `du -sh $(go env GOCACHE)` |
| Cold build | `go clean -cache && go build ./...` |
| Generate action graph | `go build -debug-actiongraph=actiongraph.json ./pkg` |
| Top slow packages | `actiongraph top -f actiongraph.json` |
| Namespace breakdown | `actiongraph tree -f actiongraph.json` |
| Why is X compiled? | `actiongraph graph --why X -f actiongraph.json \| dot -Tsvg > out.svg` |
