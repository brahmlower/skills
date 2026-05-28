# skills

A collection of skills for AI agents, installable via [vercel-labs/skills](https://github.com/vercel-labs/skills).

## Skills

### `go-development`
Go coding best practices: OOP with interfaces and pointer receivers, control flow patterns, and Go proverbs. Includes reference docs on the options pattern, typed nil in interfaces, and test error assertions.

### `go-arch-refactor`
Plans a Go project package structure refactor following Screaming Architecture and the Dependency Rule. Produces a comprehensive plan document and a frozen `go-arch-lint` config that serves as the immutable success criterion. Triggers when a project has layer-named packages (`usecases/`, `repository/`, `domain/`, etc.) that should be renamed to reflect domain concepts.

### `go-build-profiler`
Profiles Go build performance using `-debug-actiongraph` and the `actiongraph` CLI. Identifies the slowest packages, aggregates compile time by namespace, and traces why an unexpected package is being compiled.

### `go-lint-fix`
Fixes `golangci-lint` violations by grouping them by rule and delegating each group to a focused subagent. Avoids `//nolint` suppression in favor of proper structural fixes.

### `go-embedded-fs`
Guidance for embedding files in a Go binary, covering both simple and overlayed filesystem approaches.

## Installation

```bash
skills install brahmlower/skills
```
