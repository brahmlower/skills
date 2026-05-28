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

_Add new rules here as they are encountered. If a subagent struggled with a rule not documented here, describe the violation pattern and the fix that eventually worked._
