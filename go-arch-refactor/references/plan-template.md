# Refactor Plan Document Template

The plan is written to `docs/refactor-plan.md`. Every section below is required.

---

## Section 1: Architecture Principles

Two short paragraphs explaining the two principles (Screaming Architecture, Dependency Rule) and how Go's circular import prevention enforces the latter at sub-package boundaries. This orients anyone reading the plan who isn't familiar with the principles.

---

## Section 2: Module Path

State the Go module name from `go.mod`. Agents need this to write correct import paths.

```
The Go module is `<module-name>` (defined in `go.mod`).
All internal import paths are rooted there, e.g. `<module>/internal/companies`.
```

---

## Section 3: Current Package Inventory

For every package in the project, document:
- Its stated purpose / what it actually does
- Key exported types, interfaces, and functions
- What it imports (dependencies)
- What imports it (dependents)

Group by: feature packages, infrastructure packages, cmd packages. Be thorough — missing a package here means missing it in the plan.

**Useful tools:**
- `go list ./...` — enumerate all packages in the module
- `go list -f '{{.ImportPath}}: {{.Imports}}' ./...` — show direct imports per package
- `actiongraph top` — identify which packages contribute most to build time (expensive packages often signal a tangled dependency web worth untangling)
- Glob/Grep — find where specific types and interfaces are defined

---

## Section 4: Current Import Graph

A text diagram showing the current dependency direction. Example:

```
cmd/app/server_app
    → internal/search
    → internal/domain
    → internal/repository

internal/usecases
    → internal/domain
    → internal/repository
    → internal/ats
```

**Useful tools:**
- `actiongraph tree <package>` — show the full dependency tree for a package; useful for tracing why an unexpected package is being pulled in
- `actiongraph graph --why <pkg-a> <pkg-b>` — explain the import path between two packages; useful when a dependency relationship seems wrong and you want to find where it originates
- `go list -f '{{.ImportPath}} → {{join .Imports ", "}}' ./...` — flat list of all direct import relationships; good for constructing the diagram
- `go-arch-lint check --arch-file .go-arch-lint.yml` — if a lint config already exists, running it against the current structure shows existing violations that confirm the import graph

---

## Section 5: Identified Issues

Numbered list. Each issue should have:
- A bold title
- One paragraph explaining what's wrong and why it matters

Draw from the self-review checklist. Common issues:
1. Layer names instead of feature names
2. Domain types separated from their feature
3. Two packages for one concern (e.g., `search/` and `solr/`)
4. Domain concepts buried in `cmd/`
5. Displaced adapters (e.g., Brave client not under ATS)
6. Scattered workflow implementations
7. Read path bypassing service layer
8. Missing delivery mechanisms
9. Dead packages
10. Unclear package naming

---

## Section 6: Proposed Structure

A full directory tree with inline annotations. Show every package and every significant file. Annotations should explain:
- Which existing file/package this came from (if a move/merge)
- What's new (if new code)
- Why something is placed here (if non-obvious)

Example:
```
internal/
    # ── features ──────────────────────────────────────────────
    companies/
        company.go          # Company, CompanyATS types       (from domain/)
        service.go          # CompanySearcher + read methods  (from usecases/ + direct repo calls)
        repository.go       # CompanyRepository interface     (from usecases/interfaces)

    persistence/            # adapter: implements all repository interfaces
        companies.go        # (from repository/repository.go, company methods)
        postgres/           # SQLC-generated, intact          (from repository/postgres/)
        testhelpers/        # (from repository/repotest/)
```

---

## Section 7: Dependency Direction

A table showing the allowed dependency graph. Every package listed. This becomes the source of truth for the go-arch-lint config.

```
<package>              →  <what it may import>
companies/             →  (nothing internal)
jobs/                  →  companies/
search/                →  jobs/
persistence/           →  companies/, jobs/      (implements their interfaces)
search/solr/           →  search/                (child imports parent)
cmd/app/               →  users/, companies/, jobs/, search/
```

---

## Section 8: Special Package Notes

For any package whose placement or structure isn't immediately obvious, write a short explanation of the tradeoff. Common candidates:
- `persistence/` — why centralized rather than per-feature sub-packages
- `search/` — why Reindexer lives here and not in `jobs/` (circular import risk)
- Any package where a naming compromise was made

---

## Section 9: go-arch-lint Configuration

This section contains the complete `.go-arch-lint.yml` config. It is written here during planning and is **immutable** for the entire implementation.

```yaml
# THIS CONFIG IS FROZEN. DO NOT MODIFY DURING IMPLEMENTATION.
# Violations during implementation are implementation problems, not config problems.
version: 2
workdir: .
allow:
  depOnAnyVendor: false
components:
  feature-a:   { in: internal/<feature-a> }
  feature-b:   { in: internal/<feature-b> }
  persistence: { in: internal/persistence }
  binary:      { in: cmd/<binary> }
deps:
  # Leaf packages (no internal imports) are omitted — mayDependOn: [] is invalid.
  # Packages with vendor deps (cobra, viper, yaml, etc.) need anyVendorDeps: true.
  feature-b:
    mayDependOn: [feature-a]
  persistence:
    mayDependOn: [feature-a, feature-b]
  binary:
    anyVendorDeps: true
    mayDependOn: [feature-a, feature-b]
```

After writing the plan, also write this config to `.go-arch-lint.yml` in the project root.

**Useful tools:**
- `go-arch-lint check --arch-file .go-arch-lint.yml` — validate the config is syntactically correct and check what violations exist against the *current* structure (expected to be many; this is the baseline)
- `go list ./...` — verify all package paths used in the config actually exist in the module

---

## Section 10: Migration Sequence

Ordered phases. The rule: inner packages first, outer packages later. Format each phase as:

**Phase N — Description**
- [ ] Specific task 1
- [ ] Specific task 2
- [ ] _Validate: `go build ./... && go test ./... && go-arch-lint check --arch-file .go-arch-lint.yml`_

Use checkbox format for tasks so implementors (human or agent) can track progress. The validate step is always a checkbox — it must be checked before the phase is considered done.

Note: go-arch-lint will report violations for packages not yet migrated. That's expected. Focus on ensuring no *new* violations are introduced that weren't there at the start of the phase.

---

## Section 11: File Mappings

Two tables:

### Moves and Merges

| Source | Destination | Notes |
|---|---|---|
| `internal/domain/company.go` | `internal/companies/company.go` | |
| `internal/domain/company_ats.go` | `internal/companies/company.go` | merge |
| `internal/usecases/interfaces.go` | split | `CompanyRepository` → `companies/repository.go`; `JobRepository` → `jobs/repository.go` |

### Deletions

| Path | Reason |
|---|---|
| `internal/domain/` | types distributed into feature packages |
| `internal/usecases/` | logic distributed into feature packages |

---

## Section 12: New Code Required

| What | Where | Description |
|---|---|---|
| Read methods | `internal/companies/service.go` | `GetCompany()`, `ListCompanies()`, etc. — currently called directly from handlers |
| REST handlers | `cmd/app/internal/api/` | New; call same services as web handlers |

---

## Section 13: Interface Contract Changes

For each interface that moves packages, document:
- Where it moves from → to
- How its type references change (e.g., `domain.Company` → `Company` now that they're in the same package)
- Which adapter packages need to update their interface satisfaction

Also document any interfaces that are eliminated (e.g., a `repoReader` interface in handlers that gets replaced by a direct service dependency).

---

## Section 14: Success Criteria

The refactor is complete when all of the following are checked off:

- [ ] `go build ./...` passes with no errors
- [ ] `go test ./...` passes with no failures
- [ ] `go-arch-lint check --arch-file .go-arch-lint.yml` passes with zero violations
- [ ] No package named after a layer (`domain`, `usecases`, `repository`, `handlers`, `services`, `models`) remains under `internal/`
- [ ] Every `internal/` top-level package name describes a business capability or domain concept

The go-arch-lint config must not be modified after the planning phase. Any violation is an implementation problem, not a config problem.
