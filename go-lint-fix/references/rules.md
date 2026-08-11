# golangci-lint Rule Reference

Guidance for specific lint rules encountered in Go projects. Each entry explains
what triggers the rule, the correct fix pattern, and a worked example.

---

## Table of Contents

- [cognitive-complexity / cyclomatic / function-length](#complexity-rules)
- [nilerr](#nilerr)
- [lll / line-length-limit](#line-length)
- [nlreturn](#nlreturn)
- [noinlineerr](#noinlineerr)
- [wsl_v5](#wsl_v5)
- [err113](#err113)
- [goconst](#goconst)
- [godoclint](#godoclint)
- [gosec G115 (integer overflow conversion)](#gosec-g115)
- [revive: function-result-limit](#revive-function-result-limit)
- [revive: file-length-limit](#revive-file-length-limit)
- [revive: import-shadowing](#revive-import-shadowing)
- [godot](#godot)
- [nonamedreturns (and its conflict with gocritic:unnamedResult)](#nonamedreturns)

---

## Complexity Rules

**Rules:** `revive:cognitive-complexity`, `revive:cyclomatic`, `revive:function-length`

### What triggers them

- `cognitive-complexity`: too many nested branches, loops, and logical operators in one function (default limit: 10)
- `cyclomatic`: too many independent paths through a function (default limit: 15)
- `function-length`: too many statements or lines in a function body

These often fire together on the same function.

### Fix pattern

**Extract helpers.** Identify self-contained sub-operations inside the function and move them into named helper functions or methods. Good extraction targets:

- A block that builds a value (request, config, etc.)
- A nested conditional that answers a yes/no question
- The body of a loop iteration
- An error-handling sequence

Do not extract arbitrarily just to hit the number. Each helper should be a coherent, nameable unit of work.

### Worked example

Before — `process` has cognitive complexity ~14:

```go
func (w *worker) process(ctx context.Context, msg llm.Message) ([]llm.Message, error) {
    before := len(w.messages)
    w.messages = append(w.messages, msg)

    for {
        msgs := w.messages
        if w.systemPrompt != "" {
            msgs = append([]llm.Message{{Role: llm.RoleSystem, Content: w.systemPrompt}}, msgs...)
        }
        req := llm.Request{Model: w.model, Messages: msgs, Tools: w.tools}
        // ... build and emit request ...
        resp, err := w.provider.Chat(ctx, req)
        if err != nil { /* emit error event */ return nil, err }
        // ... emit response event ...
        if len(resp.Message.ToolCalls) == 0 && len(w.tools) > 0 {
            trimmed := strings.TrimSpace(resp.Message.Content)
            if len(trimmed) > 0 && trimmed[0] == '{' {
                w.messages = append(w.messages, llm.Message{/* correction */})
                continue
            }
        }
        // ... handle tool calls ...
    }
}
```

After — three helpers extracted, `process` drops to ~7:

```go
// prepareMessages prepends the system prompt if set.
func (w *worker) prepareMessages() []llm.Message {
    msgs := w.messages
    if w.systemPrompt != "" {
        msgs = append([]llm.Message{{Role: llm.RoleSystem, Content: w.systemPrompt}}, msgs...)
    }
    return msgs
}

// chatOnce builds a request, emits events, and calls the provider.
func (w *worker) chatOnce(ctx context.Context, msgs []llm.Message) (*llm.Response, error) {
    req := llm.Request{/* ... */}
    // emit request event
    resp, err := w.provider.Chat(ctx, req)
    if err != nil {
        // emit error event
        return nil, err
    }
    // emit response event
    return resp, nil
}

// isTextualToolCall reports whether the model returned a JSON tool call as text.
func (w *worker) isTextualToolCall(resp *llm.Response) bool {
    if len(resp.Message.ToolCalls) != 0 || len(w.tools) == 0 {
        return false
    }
    trimmed := strings.TrimSpace(resp.Message.Content)
    return len(trimmed) > 0 && trimmed[0] == '{'
}

func (w *worker) process(ctx context.Context, msg llm.Message) ([]llm.Message, error) {
    before := len(w.messages)
    w.messages = append(w.messages, msg)

    for {
        resp, err := w.chatOnce(ctx, w.prepareMessages())
        if err != nil {
            return nil, err
        }
        if w.isTextualToolCall(resp) {
            w.messages = append(w.messages, llm.Message{/* correction */})
            continue
        }
        // ... handle tool calls ...
    }
}
```

### Tips

- Method receivers count — extracting a method on the same struct keeps access to shared state without threading many parameters
- If the loop body is the complexity driver, extracting `processOneTurn` or similar is usually the right move
- Prefer naming helpers after _what they do_ (`buildRequest`, `isRetryable`) not _where they came from_ (`processHelper1`)

---

## nilerr

**Rule:** `nilerr`

### What triggers it

Returning `nil` as the error when a named error variable is non-nil:

```go
err := someFunc()
if err != nil {
    return value, nil  // nilerr: err is non-nil, but nil is returned
}
```

The linter flags this because it looks like a bug — you checked the error and then silently dropped it.

### When it's intentional

Sometimes silently swallowing an error is correct: a parse failure that means "treat this as missing data", an unmarshal that may fail on optional input, etc. The fix depends on whether you control the error variable.

### Fix pattern A — discard with `_ =`

When the call's error is genuinely irrelevant, discard it explicitly so there is no named error variable to trigger `nilerr`:

```go
// Before
if json.Unmarshal(schema, &s) != nil || len(s.Properties) == 0 {
    return args, nil  // nilerr
}

// After — no named error variable; zero-value of s on failure gives same result
_ = json.Unmarshal(schema, &s)
if len(s.Properties) == 0 {
    return args, nil  // fine — no err variable
}
```

This works when a failed unmarshal leaves the target zero-valued, and the subsequent check already handles that case.

### Fix pattern B — bool-returning helper

When you want to attempt an operation and branch on success/failure without propagating the error, wrap it in a helper that returns `(result, bool)`:

```go
// Helper — inline error discarded inside, caller gets a bool
func jsonObject(data json.RawMessage) (map[string]json.RawMessage, bool) {
    var m map[string]json.RawMessage
    return m, json.Unmarshal(data, &m) == nil
}

// Call site — early exit on bool, no error involved
argMap, ok := jsonObject(args)
if !ok {
    return args, nil  // fine — ok is bool, not error
}
```

### When NOT to use these patterns

If the error carries meaningful information (e.g. a database error, a network failure), do not discard it. Either return it or wrap it. `nilerr` is telling you something real in those cases.

---

## Line Length

**Rules:** `lll`, `revive:line-length-limit`

### What triggers it

A source line exceeds the configured maximum (commonly 120–150 characters).

### Fix pattern — string concatenation

For long string literals (JSON schemas, SQL, long messages), split with `+`:

```go
// Before — one long line
var dialogSchema = json.RawMessage(
    `{"type":"object","required":["content"],"properties":{"content":{"type":"string","description":"The plain text message to send"}}}`, //nolint:lll
)

// After — split with concatenation, each segment under the limit
var dialogSchema = json.RawMessage(
    `{"type":"object","required":["content"]` +
        `,"properties":{"content":{"type":"string"` +
        `,"description":"The plain text message to send"}}}`,
)
```

For long function calls or struct literals, break after each argument/field — `gofmt` will preserve the linebreaks.

For long comments, rewrap the text across multiple `//` lines.

---

## nlreturn

**Rule:** `nlreturn`

### What triggers it

A `return` (or other terminating statement) is not preceded by a blank line, making it visually hard to spot:

```go
func foo() int {
    x := compute()
    return x  // nlreturn: no blank line before return
}
```

### Fix

Add a blank line immediately before the `return`:

```go
func foo() int {
    x := compute()

    return x
}
```

Exception: single-statement functions (the return is the only line) do not need a blank line. Most linter configs exclude these automatically.

---

## noinlineerr

**Rule:** `noinlineerr`

### What triggers it

Using the inline `if err := ...; err != nil` form instead of a plain two-line assignment:

```go
if err := json.Unmarshal(data, &v); err != nil {  // noinlineerr
    return err
}
```

### Fix

Separate the assignment from the check:

```go
err := json.Unmarshal(data, &v)
if err != nil {
    return err
}
```

This is a pure mechanical change. When the error variable would shadow an outer `err`, rename it (e.g. `unmarshalErr`) to keep things clear.

---

## wsl_v5

**Rule:** `wsl_v5`

### What triggers it

Various whitespace / blank-line conventions. Common cases:

1. **Missing blank line above an assignment that follows a block-ending statement** (e.g., a `var` declaration immediately followed by `_ = someCall(...)` with no blank line between)
2. **Cuddled assignments** — two logically separate statements with no blank line between them when wsl expects one

### Fix

Add a blank line in the flagged location:

```go
// Before
var s struct {
    Properties map[string]json.RawMessage `json:"properties"`
}
_ = json.Unmarshal(schema, &s)  // wsl_v5: no blank line above

// After
var s struct {
    Properties map[string]json.RawMessage `json:"properties"`
}

_ = json.Unmarshal(schema, &s)
```

Read the specific linter message carefully — it usually identifies exactly which line needs the blank line above or below it.

---

## err113

**Rule:** `err113`

### What triggers it

Creating a dynamic error inline with `errors.New("...")` or `fmt.Errorf("...")` (no `%w`) at the call site,
instead of a package-level sentinel:

```go
func doThing() error {
    return errors.New("boom") // err113
}
```

The concern is `errors.Is`-based comparison: a dynamic error can never be matched by identity from another
package or another test.

### Fix

Declare a package-level (or file-level, for `_test.go` files) `var errXxx = errors.New("...")` and reference it:

```go
var errBoom = errors.New("boom")

func doThing() error {
    return errBoom
}
```

In test files, colocate the sentinel near the top of the file (or near the test that uses it, if the file is
long and the error is specific to one scenario) with an `err`-prefixed name describing what it's simulating,
e.g. `errExecFailed`, `errSignalFailed`. If several tests each need their own distinct simulated failure, one
sentinel per test is fine — don't force them to share one generic `errTest` if that loses the descriptive name
in failure output.

---

## goconst

**Rule:** `goconst`

### What triggers it

The same string literal appears 3+ times (the exact threshold is configured) across a file/package. Repetition
makes typos likely and renames error-prone.

### Fix

Extract to a named constant, scoped to where it's used:

```go
// Before
if category != "hr" { ... }
// ... "hr" used 4 more times in the file

// After
const testCategoryHR = "hr"

if category != testCategoryHR { ... }
```

Naming conventions to match:
- In `_test.go` files, this repo prefixes test-only constants with `test` (e.g. `testOrgName`, `fieldName`) —
  grep the file/package for an existing constants block before adding a new one; many packages already have one
  near the top (see `fieldName`, `fieldRole` in `cmd/yardrail-frontend/internal/api/api_test.go`).
- **Check whether an equivalent constant already exists first** — the linter message says so explicitly when it
  does: `string "name" has 5 occurrences, but such constant "fieldName" already exists (goconst)`. In that case
  just reuse the existing constant at the flagged line; do not declare a second one.
- Group related constants in a single `const ( ... )` block rather than scattering single `const` lines, if the
  file already follows that convention.
- IDs/names that are conceptually the same fixture value reused across many subtests (e.g. `"tmpl1"`, `"run-1"`)
  should become one constant used everywhere in that file, not per-subtest duplicates.

---

## godoclint

**Rule:** `godoclint`

### What triggers it

An exported symbol (function, type, method) has no doc comment, or has one that doesn't start with the symbol's
name.

### Fix

Add a one-line doc comment starting with the exact symbol name, stating what it does — not how:

```go
// ListWorkflowTemplates returns every workflow template in orgID, optionally filtered by category.
func (f *FakeQuerier) ListWorkflowTemplates(...) (...) { ... }
```

For a batch of trivial CRUD-style methods on the same fake/stub type, keep each comment to one short line
consistent with its siblings — don't write a multi-line doc block for a one-line delegation. If the method's
name plus receiver type already makes the behavior obvious (e.g. a fake querier's `CreateWorkflow`), a short
factual sentence restating the signature in English is enough; no need to explain internals.

---

## gosec G115

**Rule:** `gosec` (G115: integer overflow conversion)

### What triggers it

An implicit or explicit narrowing conversion between integer types where the source could exceed the
destination's range, e.g. `int` → `int32`, `int64` → `int`, `uint64` → `int`:

```go
var x int = someLen()
y := int32(x) // gosec G115: integer overflow conversion int -> int32
```

### Fix

Do **not** silence with `//nolint:gosec` — add an explicit, narrow bounds check (or use a stdlib helper that
already does one) so the conversion is provably safe, and the reader can see why:

```go
if x < math.MinInt32 || x > math.MaxInt32 {
    return fmt.Errorf("value %d out of int32 range", x)
}

y := int32(x) //nolint:gosec // bounds-checked above
```

If the value is a slice/map length being narrowed to fit a wire format (very common — `len(x)` is `int` but a
protobuf/SQL column field is `int32`), and the practical bound is already enforced elsewhere (e.g. paginated
lists, capped batch sizes), a bounds check is still the correct fix — it documents the invariant instead of
silently trusting it. Only use `//nolint` on the conversion line itself, immediately after adding the guard,
never as a substitute for it.

---

## revive: function-result-limit

**Rule:** `revive` (function-result-limit)

### What triggers it

A function returns more than the configured maximum number of results (this repo: 3, including the trailing
`error`).

### Fix

Bundle the non-error results into a single named struct:

```go
// Before
func parseRun(row Row) (id string, status string, endedAt time.Time, err error) { ... }

// After
type parsedRun struct {
    ID      string
    Status  string
    EndedAt time.Time
}

func parseRun(row Row) (parsedRun, error) { ... }
```

Pick a struct name that describes the value, not the function (`parsedRun`, not `parseRunResult`). Update every
call site to destructure the struct fields it needs. If the values are genuinely unrelated (not naturally one
"thing"), that's a sign the function itself is doing too much — consider whether splitting it is more honest
than bundling unrelated values into a struct purely to dodge the linter.

---

## revive: file-length-limit

**Rule:** `revive` (file-length-limit)

### What triggers it

A file exceeds the configured line-count limit (this repo: 800 lines). Common in `_test.go` files that
accumulate table-driven cases over time.

### Fix

Split along an existing seam in the file — do not split arbitrarily by line count. Good seams:

- By the production type/concern under test: `store_test.go` → `store_test.go` (core CRUD) +
  `store_templates_test.go` (template-specific cases), if the file mixes concerns for more than one exported
  type.
- Shared test doubles/fixtures (`stubQuerier`, fixture builders like `testWorkflowRow()`) stay in one file
  (often the smallest/first alphabetically, or a dedicated `_helpers_test.go`) and are used unqualified by the
  others — they're in the same package, so no import changes needed, only moving code between files.
- Keep one `TestXxx` function fully inside a single file — never split a function's body across files.

After splitting, re-run the build (`go build ./...` doesn't compile `_test.go` files — use
`go vet ./...` or `go test -run NONE ./pkg/...` to typecheck test files) to confirm nothing was left orphaned
(unused imports in either half is the most common mistake).

---

## revive: import-shadowing

**Rule:** `revive` (import-shadowing)

### What triggers it

A local variable, parameter, or receiver name is identical to an imported package name, shadowing it within
that scope:

```go
import "github.com/example/workflows"

func handle(workflows []Item) { // shadows the "workflows" package
    ...
}
```

### Fix

Rename the local identifier — never the import. Pick a name that reflects what the local value actually is,
not a generic disambiguator:

```go
func handle(items []Item) { ... }
```

If the shadowing variable is a package-level field or receiver already threaded through many call sites, prefer
the smallest rename that resolves the conflict at that one shadowing scope (e.g. rename just the parameter, not
every local variable that happens to reuse the word) — check first whether the package is even used in that
function; if not, the safest fix is often just picking a more specific local name.

---

## gocritic: nilValReturn

**Rule:** `gocritic` (nilValReturn)

### What triggers it

A `return x, nil` where `x` is a variable that a preceding `if x == nil` (or similar) branch already proved
is always nil by the time this return executes — so the variable name is misleading dead weight.

### Fix

Replace the variable with the literal `nil` at that return site:

```go
// Before
if teamID == nil {
    return teamID, nil // nilValReturn: teamID is always nil here
}

// After
if teamID == nil {
    return nil, nil
}
```

Do not touch the variable's declaration or other return sites — only the flagged one.

---

## gocritic: httpNoBody

**Rule:** `gocritic` (httpNoBody)

### What triggers it

Passing a literal `nil` as the body argument to `http.NewRequest`/`http.NewRequestWithContext`.

### Fix

Use `http.NoBody` instead — it's the documented sentinel for "no body" and behaves identically at the type
level (`io.Reader`), but is self-documenting:

```go
// Before
req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)

// After
req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, http.NoBody)
```

---

## gocritic: unnamedResult

**Rule:** `gocritic` (unnamedResult)

### What triggers it

A function returns two or more values of the same or ambiguous type without named return parameters, making
call sites hard to read (`(string, []byte, error)` — which string? which bytes?).

### Fix

Add names to the result list matching what each value represents. You do not have to use naked `return` — keep
explicit `return keyID, secret, nil` statements, the names just document the signature:

```go
// Before
func parseKeyEntry(entry string) (string, []byte, error) { ... }

// After
func parseKeyEntry(entry string) (keyID string, secret []byte, err error) { ... }
```

Do not switch the function body to naked returns purely because parameters are now named — only do so if the
function already used naked returns elsewhere in the same file/style.

---

## gocritic: rangeValCopy

**Rule:** `gocritic` (rangeValCopy)

### What triggers it

`for _, x := range list` (or `for i, x := range list`) where `list` holds structs heavier than gocritic's
threshold (~128 bytes default) — each iteration copies the whole struct into `x`.

### Fix

Index into the slice instead of copying the value out. If the loop only reads fields, this is a pure mechanical
change:

```go
// Before
for _, p := range list {
    result = append(result, ToRelay(p))
}

// After
for i := range list {
    result = append(result, ToRelay(list[i]))
}
```

If the original loop already had an index (`for i, row := range rows`), just replace remaining uses of `row`
with `rows[i]` and drop `row` from the range clause. If the loop body takes `&x` (address of the loop variable)
to build a pointer slice, indexing fixes a latent aliasing bug too — every `&x` used to point at the same
reused loop variable.

Note: this pairs naturally with `hugeParam` fixes on the same struct — if you're converting `ToRelay(p Foo)` to
`ToRelay(p *Foo)` in the same pass, update the call site to `ToRelay(&list[i])` instead of introducing an extra
copy.

---

## gocritic: hugeParam

**Rule:** `gocritic` (hugeParam)

### What triggers it

A function parameter is a struct passed by value that exceeds gocritic's size threshold (default 80 bytes) —
each call copies the whole struct onto the stack.

### Fix

Change the parameter to a pointer, then update every call site (production code, other packages, and tests) to
pass a pointer instead of a value:

```go
// Before
func ToRelay(p persistence.EmailProvider) relay.EmailProvider { ... uses p.Field ... }

// After
func ToRelay(p *persistence.EmailProvider) relay.EmailProvider { ... uses p.Field ... }
```

Call-site update rules:
- A call passing an addressable variable: `ToRelay(provider)` → `ToRelay(&provider)`.
- A call passing a struct literal or a range/map value directly: bind it to a local first, or (if the source is
  a slice) index into the slice — see the `rangeValCopy` entry above, since these two rules often hit the same
  loop.
- A call passing another function's return value directly (e.g. `ToRelay(fetchRow())`) where that return isn't
  addressable: introduce a local variable to take its address.
- If the same value is also passed to *other* functions that still expect a value (not a pointer), dereference
  at those call sites (`otherFunc(*p)`) rather than changing every sibling function's signature — scope the
  pointer conversion to exactly the flagged function unless multiple flagged functions share the same call
  chain, in which case threading the pointer through is cleaner.

### Caution

Do NOT change a function signature if the parameter is mutated by value intentionally (copy-on-write semantics)
or if the struct is part of an exported interface implemented elsewhere (check for interface satisfaction
assertions like `var _ SomeInterface = (*Type)(nil)` before changing a method's signature — a method fix must
keep it satisfying the interface, which usually means the interface itself is not exported/shared, or all
implementations need the same change). If a struct is defined in a package this codebase doesn't own (e.g.
directly from `persistence` sqlc-generated types passed through unchanged elsewhere), grep for all callers first
— sqlc-generated types are heavily reused, so scope of a signature change can be larger than it first appears.

### Known unfixable case: `persistence.Querier` stub/fake implementations

This repo has many hand-written test doubles (`stubQuerier`, `internalDBStub`, `workflowstest.FakeQuerier`, etc.)
that implement `internal/persistence`'s `Querier` interface — 100% sqlc-generated, never hand-edited (see
CLAUDE.md). Every `Querier` method takes its params struct **by value** (`arg FooParams`), so a stub method like:

```go
func (s *stubQuerier) UpdateIntegration(ctx context.Context, arg internaldb.UpdateIntegrationParams) (...) {
```

cannot be changed to a pointer — it would no longer satisfy `persistence.Querier`, breaking every place the
stub is passed where that interface is expected. This is a real, structural exception, not laziness.

**Recognize it:** the flagged parameter's type is a `persistence.*Params` (or a same-shaped type from a
sibling generated package like `internaldb`), and the enclosing method name/signature matches a
`persistence.Querier` method exactly (same name, same param type, same returns). Check `internal/persistence/querier.go`
if unsure.

**Fix:** add a scoped `//nolint:gocritic` directly on the flagged line, with a comment naming the interface:

```go
func (s *stubQuerier) UpdateIntegration(
	ctx context.Context,
	arg internaldb.UpdateIntegrationParams, //nolint:gocritic // must match persistence.Querier's by-value signature
) (internaldb.Integration, error) {
```

Do NOT apply this shortcut to anything else — only to methods whose signature is pinned by satisfying a
generated interface. A plain helper function or a service's own `CreateParams` type (defined in the same
package, not implementing an external interface) should still get the real pointer-conversion fix.

---

## godot

**Rule:** `godot`

### What triggers it

A top-level doc comment (the kind directly above a func/type/var/const declaration) doesn't end in a period.
Godot only checks the *last* line of the comment block.

### Fix

Add a trailing `.`:

```go
// FetchJWKS is the default JWKSFetchFunc. It makes a real HTTP GET to uri
func FetchJWKS(uri string) (*JWKSet, error) { ... }

// After
// FetchJWKS is the default JWKSFetchFunc. It makes a real HTTP GET to uri.
func FetchJWKS(uri string) (*JWKSet, error) { ... }
```

If the comment ends in a code span (`` `foo()` ``), a closing paren, or a URL, still add the period after it
unless doing so reads oddly — godot's default scope is `declarations`, so only the doc-comment's final line
needs the period; inline `//` comments elsewhere in a function body are not checked.

---

## nonamedreturns

**Rule:** `nonamedreturns`

### What triggers it

Any function/method with **named return parameters** in its signature, e.g. `func f() (id string, err error)`,
unless a `defer` inside the function mutates one of those names (the linter default-excludes that pattern,
since removing the name there would break the mutation).

### The conflict with `gocritic:unnamedResult`

This repo also runs `gocritic:unnamedResult`, which requires names on functions that return **2+ ambiguous
non-error values** (see that entry above). A function like `func f() (host, port string, err error)` is
required to be named by `unnamedResult` and forbidden from being named by `nonamedreturns` — the two rules
directly conflict on the same signature. Stripping the names re-triggers `unnamedResult`; keeping them
triggers `nonamedreturns`. Neither a nolint nor picking one side is the fix.

### Fix — bundle the non-error results into a small struct

Same resolution as `revive: function-result-limit` above: give the ambiguous return values a struct type. A
single struct return (plus a trailing `error` if present) is unambiguous on its own — `unnamedResult` doesn't
flag `(T, error)` shapes, and there's nothing left to name, so `nonamedreturns` has nothing to flag either.

```go
// Before — violates unnamedResult if unnamed, nonamedreturns if named
func peekHeaderAndIssuer(tokenStr string) (alg, iss string, err error) { ... }

// After
type tokenHeader struct {
	Alg    string
	Issuer string
}

func peekHeaderAndIssuer(tokenStr string) (tokenHeader, error) { ... }
```

Update every call site to destructure the struct fields it needs (`h.Alg`, `h.Issuer`) instead of two bare
locals. Pick a struct name that describes the value (`tokenHeader`), not the function.

**Accumulator-pattern named returns** (fields built up across a loop/switch, e.g. `space = space ||
flows[i].Context[...] != ""`) convert the same way — declare the struct as a local (`var needs nameNeeds`) at
the top of the function, mutate its fields in place of the named-return locals, and `return needs, nil` (or
just `return needs` if there's no error) at the end:

```go
// Before
func setupNameNeeds(flows []relay.SetupFlowStep) (space, template, connector bool) {
	for i := range flows { space = space || ...; }
	return space, template, connector
}

// After
type nameNeeds struct{ Space, Template, Connector bool }

func setupNameNeeds(flows []relay.SetupFlowStep) nameNeeds {
	var needs nameNeeds
	for i := range flows { needs.Space = needs.Space || ...; }
	return needs
}
```

**Two-non-error-value, no-error case** (e.g. `func (h *Hub) Register(clientID string) (events <-chan string,
unsubscribe func())`): same treatment — bundle into a struct (`type Subscription struct { Events <-chan
string; Unsubscribe func() }`), return it unnamed. Update callers from `ch, unsub := h.Register(id)` to
`sub := h.Register(id)` and use `sub.Events`/`sub.Unsubscribe()`.

**Do not** just strip the names and leave the ambiguous multi-value return as-is — that trades one violation
for the other. If a function only has a single named non-error return plus `error` (already unambiguous, e.g.
`func f() (n int, err error)` where `unnamedResult` doesn't fire on 2-value `(T, error)` shapes), the flag only
came from the name being present for no reason — just strip the name and use a plain `return n, err`.

---

_Add new rules here as they are encountered. If a subagent struggled with a rule not documented here, describe the violation pattern and the fix that eventually worked._
