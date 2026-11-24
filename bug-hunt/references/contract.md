# Contract template

Contracts are the single source of truth that keeps independently written plans consistent. The
synthesizer returns them as string fields (`contract_md` per cluster, `cross_contract_md`,
`summary_md`); nothing is written to files.
Plans conform to the contract; when a plan needs the contract to change, it lists a contract
delta instead of diverging. Later rulings go in a dated "Rulings" section that supersedes earlier
text, so the history of decisions stays visible.

## Cluster contract (`contract_md`)

```markdown
# Contract: <cluster name> (F04, F05, F07)

Pinned SHA: <sha7>. Landing order: F04 → F07 → F05.

## 1. Chosen direction
Per finding: the option picked, one-line rationale, options rejected and why.

## 2. Shared types and signatures
Go declarations for every type, function signature, constant and interface more than one plan
touches, with the finding that introduces each and the ones that extend it. Be complete: planners
should never have to invent a shared name or shape. Zero values must be meaningful.

## 3. Ordering and precedence
Where several conditions can be true at once (status classification, error mapping, check
order), the full ordered table, with the owning finding per row.

## 4. Errors and retry semantics
| Sentinel / type | Introduced by | Matched with | Retryable | Surfaced as |
One mapping location. No per-name special cases unless justified here.

## 5. Ownership of edge cases
Every edge case that more than one plan could handle, and which plan handles it.

## 6. Removed or renamed code
What each plan deletes or renames, and which other plans depended on it (they must carry the
behavior over, including tests).

## 7. Config, chart, permissions, lint
Settings, flags, chart values, RBAC verbs and lint-config changes, and which plan adds each.
No `//nolint`; fix the config or the code.

## 8. Cross-cluster dependencies
References to cross-cluster contract items.

## 9. Rulings
Dated entries: alignment item id → decision → affected findings.
```

## Cross-cluster contract (`cross_contract_md`)

Only what spans clusters: shared types or helpers used by more than one cluster, a global
landing order, a shared error/retry table if clusters share one, and conflicts the synthesizer
resolved between clusters. Keep it short; per-cluster detail stays in cluster contracts.

## Summary (`summary_md`)

At most 30 lines: clusters with their findings, the chosen option per finding with a one-line
reason, the landing order, findings recommended to merge into one issue, and choices needing the
user's judgment (with the provisional choice applied).
