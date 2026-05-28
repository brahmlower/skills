# Architecture Principles for Go Package Structure

## Screaming Architecture

Robert C. Martin's "Screaming Architecture" principle: the top-level structure of a project should immediately communicate what the system *does*, not what framework or layer pattern it uses.

**Bad — communicates nothing about the domain:**
```
internal/
    domain/
    usecases/
    repository/
    handlers/
```

**Good — communicates what the system does:**
```
internal/
    companies/
    jobs/
    search/
    notifications/
```

The test: show the top-level package list to someone who doesn't know the codebase. Can they tell what the system does? If they see `usecases/` and `repository/`, no. If they see `companies/`, `jobs/`, `search/`, yes.

## The Dependency Rule

From Clean Architecture: dependencies point inward. The inner layers (domain types, use cases) define interfaces. The outer layers (infrastructure, delivery) implement those interfaces. Inner layers never know about outer layers.

```
[delivery: cmd/]  →  [features: internal/]  →  [nothing]
[adapters]        →  [features]
```

Arrows mean "depends on / imports". The feature packages define interfaces; adapters implement them; delivery wires them together.

## How Go Mechanics Enforce This

Go's circular import prevention is the enforcement mechanism. **A child package can import its parent, but a parent cannot import its child without a compiler error.**

This means: put the interface in the parent package, put the adapter implementation in a child package. The compiler ensures the parent never accidentally imports the child.

```
companies/              # defines CompanyRepository interface
    postgres/           # implements CompanyRepository — imports companies/
                        # companies/ cannot import companies/postgres/ (circular)
```

The dependency rule is only mechanically enforced at this sub-package boundary. Within a single package (across multiple files), it's convention enforced by code review.

## The Canonical Package Structure

```
internal/
    # ── features ────────────────────────────────────────
    <feature>/
        <entity>.go         # domain types (structs, value objects)
        service.go          # use cases (both read and write paths)
        repository.go       # repository interface (defined here, not in adapter)
        <adapter>/          # implements the interface — sub-package for enforcement
            <impl>.go

    # ── shared persistence adapter ───────────────────────
    persistence/            # implements all repository interfaces in one place
        <feature>.go        # methods for each feature
        postgres/           # SQLC-generated or raw SQL — stays intact
        testhelpers/        # shared test helpers for db access

    # ── infrastructure ───────────────────────────────────
    config/                 # configuration loading
    proxy/                  # HTTP proxy management (if applicable)
    migrations/             # schema migration files + runner
    telemetry/              # observability setup

cmd/
    <binary>/
        main.go             # wires dependencies, starts server/worker
        internal/
            web/            # SSR route handlers
            api/            # REST route handlers
            server/         # HTTP server setup, middleware, auth
            cli/            # operator commands (migrate, etc.)
            config/         # binary-specific config
```

## The `persistence/` Pattern

Rather than per-feature `postgres/` sub-packages, a centralized `persistence/` adapter:

- Keeps SQLC-generated code in one place (no need to split generation)
- Enables cross-entity transactions naturally (shared db connection)
- Implements all repository interfaces defined across feature packages

The dependency direction is preserved: `persistence/` imports `companies/` and `jobs/` (to satisfy their interfaces), but those packages never import `persistence/`.

The trade-off: `persistence/` is a layer name. Accept it — the practical benefits outweigh the naming purity.

## Dependency Direction Reference

| Package | May import |
|---|---|
| `internal/<feature>/` | nothing internal (only stdlib + external) |
| `internal/<feature>/<adapter>/` | its parent feature package |
| `internal/persistence/` | all feature packages (to implement their interfaces) |
| `internal/ats/` | `internal/proxy/` |
| `internal/search/` | `internal/<jobs-feature>/` (for entity types) |
| `cmd/<binary>/` | feature packages, infrastructure packages |
| `cmd/<binary>/internal/web/` | feature packages via `cmd/<binary>/internal/server/` |

## What Belongs Where

**Feature package (`internal/<feature>/`):**
- Domain entity structs and value objects
- Repository interface (the contract the adapter must satisfy)
- Service struct with both write use cases AND read methods (never bypass service for reads)
- Sentinel errors for the domain

**Adapter sub-package (`internal/<feature>/<adapter>/`):**
- Concrete implementation of the repository interface
- Any technology-specific types (SQL row structs, HTTP response structs)
- Translation logic between external representation and domain types

**Delivery package (`cmd/<binary>/internal/web/` etc.):**
- HTTP handlers (thin — delegate to feature services)
- Request parsing, response rendering
- Auth/session adapters (e.g., `UserFromOryIdentity()` — maps external SDK type to domain type)

**Infrastructure (`internal/config/`, etc.):**
- No domain logic
- Only imported by `cmd/` and other infrastructure packages
- Feature packages do not import infrastructure
