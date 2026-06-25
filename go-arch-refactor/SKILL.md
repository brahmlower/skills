---
name: go-arch-refactor
description: Plan a Go project package structure refactor following Screaming Architecture and the Dependency Rule. Triggers when the user wants to reorganize Go packages, refactor package structure, or align a Go project with Clean Architecture. Triggers when a Go project has layer-named packages like usecases/, repository/, domain/, handlers/, services/, or models/ at the top level — these signal the project needs this refactor. Triggers when the user says things like "our packages are a mess", "I want to restructure this Go project", "how should I organize these packages", or describes a Go codebase where package names describe the layer (what it is) rather than the domain (what it does). Produces a comprehensive plan document for both human project leads and AI agents, including a frozen go-arch-lint config that serves as the immutable success criterion for the refactor.
---

# Go Architecture Refactor Planner

This skill produces a thorough refactor plan for a Go project's package structure. The plan serves two audiences: human project leads reviewing and directing the work, and AI agents implementing it phase by phase.

See [references/architecture-principles.md](references/architecture-principles.md) for a detailed explanation of the two principles that guide all decisions here. The short version:

- **Screaming Architecture** — top-level package names reveal what the system *does*, not how it's built. `companies/`, `jobs/`, `search/` scream the domain. `usecases/`, `repository/`, `domain/` scream the layer and say nothing about the system.
- **The Dependency Rule** — dependencies point inward. Outer layers (infrastructure, delivery) depend on inner layers (features, domain). In Go, this is enforced at sub-package boundaries: a child package can import its parent, but Go's circular import prevention makes the reverse impossible. Use this to your advantage.

---

## Workflow

### Step 1 — Explore the Codebase

Spawn an **Explore subagent** to inventory every package. The subagent must produce:

- For each package: its responsibilities, key types and interfaces, what it exports, what it imports
- The full import graph (which packages depend on which)
- Any domain concepts buried inside `cmd/` that should live in `internal/`
- Any packages with layer names that hide what they actually do

Do not proceed to design until you have this inventory. The quality of the plan depends entirely on understanding what currently exists.

### Step 2 — Design the Proposed Structure

Using the inventory, map the codebase to the target structure. See [references/architecture-principles.md](references/architecture-principles.md) for the canonical structure, but the core shape is always:

```
internal/
    <feature-a>/          # domain types + use cases + repository interface
        <adapter>/        # implements the interface (sub-package: compiler-enforced)
    <feature-b>/
        <adapter>/
    persistence/          # central DB adapter implementing all repository interfaces
        postgres/         # SQLC-generated code (stays intact)
        testhelpers/
    <infra-concern>/      # config/, proxy/, migrations/, telemetry/

cmd/
    <binary>/
        internal/
            web/          # SSR handlers
            api/          # REST handlers
            cli/          # operator commands
            server/       # shared setup, middleware, auth
```

The key decisions to make:
- What are the domain features? (Name them by what the system does)
- Which current packages are really the same feature split across layer names?
- Which adapters belong as sub-packages of which feature?
- Which domain types are currently buried in delivery (`cmd/`) and should move to `internal/`?
- Does a centralized `persistence/` package make sense, or are per-feature sub-packages better?

### Step 3 — Run the Self-Review Checklist

Before writing the plan, run through this checklist explicitly. Treat it as a TODO list — work through each item and fix anything that fails.

**Naming**
- [ ] Every `internal/` top-level package has a feature/domain name, not a layer name (`usecases/`, `repository/`, `domain/`, `handlers/`, `services/`, `models/` are all red flags)
- [ ] Delivery packages (`web/`, `api/`, `cli/`) are inside `cmd/`, not in `internal/`

**Type co-location**
- [ ] Domain types (entities, value objects) live in the same package as their use cases and repository interface — not in a separate `domain/` package
- [ ] Every interface is defined in the package that *uses* it, not the package that *implements* it (`CompanyRepository` lives in `companies/`, not in `persistence/`)

**Adapter placement**
- [ ] Infrastructure adapters (DB, HTTP clients, external APIs) are sub-packages of the feature they serve, or in a centralized `persistence/` package
- [ ] No adapter is at the same level as the feature package it implements (it should be a child, not a sibling)

**Dependency direction**
- [ ] The proposed import graph flows strictly inward — no inner package imports an outer package
- [ ] Feature packages do not import delivery packages (`cmd/`)
- [ ] Feature packages do not import infrastructure packages (`config/`, `proxy/`) — only `cmd/` and infra packages import those

**Circular import risks**
- [ ] For any use case that touches multiple features (e.g., a Reindexer that reads jobs and writes to search), verify it lives in the *outer* of the two features to avoid a cycle. If A imports B and the use case also needs B to import A, it belongs in A (or in a new package above both).
- [ ] Adapter sub-packages import their parent — verify no parent would need to import its child

**Read path**
- [ ] Feature services expose read methods (`GetX`, `ListX`, `CountX`) — delivery packages do not access the repository directly
- [ ] No handler or workflow directly instantiates or calls a persistence type

**Buried domain concepts**
- [ ] No domain types (User, Account, etc.) live inside `cmd/` — if found, they belong in `internal/<feature>/`
- [ ] `UserFromIdentity`-style adapter functions that map from external SDK types to domain types stay in delivery, not in the domain type's package

**`pkg/` placement**
- [ ] If the project uses `pkg/`, assess whether it's intentional: `pkg/` signals that those packages are intended for external consumers (other modules). If the project is a library or has known external consumers, `pkg/` packages are correct and should stay. Only recommend moving to `internal/` if the project is a single-binary application with no external consumers — in that case `pkg/` creates accidental public API surface with no benefit.

**Completeness**
- [ ] Every current package has a clear destination in the proposed structure
- [ ] No packages that are doing too much (should be split into two features)
- [ ] No packages that are too granular (a single type warrants merging with a sibling)
- [ ] Dead/unused packages are explicitly marked for deletion

**go-arch-lint**
- [ ] The proposed `.go-arch-lint.yml` config captures every dependency relationship in the proposed structure
- [ ] No implicit dependencies are missing from the config
- [ ] The config accurately reflects the dependency direction table

### Step 4 — Generate the go-arch-lint Config

The `.go-arch-lint.yml` config is the **single source of truth** for the target architecture. It defines which packages are allowed to import which, and it is written during planning and **never modified during implementation**.

Generate it now, before writing the plan. Structure it like this:

```yaml
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
  feature-b:
    mayDependOn: [feature-a]
  persistence:
    mayDependOn: [feature-a, feature-b]
  binary:
    anyVendorDeps: true
    mayDependOn: [feature-a, feature-b, feature-c]
```

Rules for generating the config:
- `components:` maps short names to package paths via `in:` — use the package's directory name as the component name
- `deps:` uses those short names as keys, not package paths
- `mayDependOn` lists only *direct* dependencies — do not list transitive ones
- Leaf packages (no internal imports) are **omitted from `deps`** entirely — `mayDependOn: []` is invalid syntax and will error
- Packages that import third-party vendors (cobra, viper, yaml, etc.) need `anyVendorDeps: true` — typically `cmd/<binary>` and any package that wraps an external library
- Infrastructure packages (`config/`, `proxy/`, `migrations/`) are typically only imported by `cmd/` and other infrastructure — list them explicitly if feature packages need them
- Sub-packages (adapters) inherit their parent's dependencies — you don't need to list them separately unless they have additional dependencies

### Step 5 — Write the Plan Document

Write the plan to `docs/refactor-plan.md` (or update it if it already exists). See [references/plan-template.md](references/plan-template.md) for the full template. Every section is required — do not skip any.

The go-arch-lint config belongs in its own section of the plan document, clearly labelled as frozen.

### Step 6 — Implementation Guidance

The plan includes a phased migration sequence. Each phase is designed to be implemented by a subagent working in an isolated worktree. The project lead reviews each phase before proceeding.

**Phase ordering rule:** inner packages must exist and compile before outer packages can import them. Always sequence:
1. Create new inner feature packages (no internal dependencies)
2. Add read methods to feature services
3. Move persistence adapter
4. Consolidate any infrastructure adapters (sub-packages)
5. Update delivery (`cmd/`) — handlers, workflows, CLI
6. Delete orphaned packages

Each phase ends with a validation step:
```
go build ./...
go test ./...
go-arch-lint check --arch-file .go-arch-lint.yml
```

The go-arch-lint check will fail until the phase introduces the packages it covers. That's expected. What is **not** acceptable is modifying the config to make it pass.

---

## go-arch-lint Enforcement

This is critical and must be communicated clearly in the plan:

**The `.go-arch-lint.yml` config is written once during planning and is frozen for the entire implementation.** It defines the target architecture. Agents implementing phases must not modify it.

If an agent encounters a go-arch-lint violation it cannot resolve:
- It must **stop and report** the violation to the project lead
- It must **not** edit `.go-arch-lint.yml` to suppress the violation
- The project lead reviews whether the violation reveals a flaw in the implementation (most likely) or a genuine gap in the plan (rare)
- If the work needed to fix the violation is substantial, the project lead should break it into a sub-phase and delegate to a new subagent

A go-arch-lint violation during implementation means one of two things:
1. The agent took a shortcut and imported something it shouldn't have — fix the implementation
2. The plan has a gap (an edge case missed during planning) — fix the plan, update the config, and document why

Option 2 should be rare if the self-review checklist was followed carefully.

Include this checklist in the plan document under a "Success Criteria" section:

```
The refactor is complete when all of the following are checked off:

- [ ] `go build ./...` passes with no errors
- [ ] `go test ./...` passes with no failures
- [ ] `go-arch-lint check --arch-file .go-arch-lint.yml` passes with zero violations
- [ ] No package named after a layer (`domain`, `usecases`, `repository`, `handlers`, `services`, `models`) remains under `internal/`
- [ ] Every `internal/` top-level package name describes a business capability or domain concept

The go-arch-lint config must not be modified after the planning phase. Any violation is an implementation problem, not a config problem.
```

---

## Subagent Delegation Pattern

Include this guidance in the plan for the project lead:

Each migration phase is a unit of work suitable for a single subagent. When delegating:

- Give the subagent the plan document and tell it which phase to implement
- Require worktree isolation (`isolation: "worktree"`)
- Tell it the go-arch-lint config is frozen and must not be changed
- Tell it to stop and report if it cannot pass go-arch-lint without changing the config
- Tell it to run `go build ./...`, `go test ./...`, and `go-arch-lint` before reporting done

If a subagent stops due to context compaction or gets stuck:
- Stop it and create a new subagent
- Give the new subagent the same plan + phase, plus a summary of what the previous agent completed
- The new agent picks up where the previous one left off

If a phase is too large (subagent reports it needs to change the config or the scope is overwhelming):
- Break the phase into two sub-phases in the plan
- Delegate each sub-phase separately
- Review the intermediate state before proceeding
