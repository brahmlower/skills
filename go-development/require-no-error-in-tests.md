# Assert Errors in Tests with require.NoError

## The Problem

Ignoring errors in tests with `_, _` or `x, _` is a common shortcut that creates hidden risks:

```go
// bad — if Load returns (nil, err), c is nil and the next call panics
c, _ := scancache.Load(p)
c.SetDigest("sha256:x", nil)

// bad — info is nil if Stat fails; info.ModTime() panics
info, _ := os.Stat(p)
fmt.Println(info.ModTime())
```

The test appears to pass (or panics with a confusing message) rather than clearly reporting the actual failure. Static analysis tools like `nilaway` flag these as potential nil panics.

## The Fix

Use `require.NoError` from `github.com/stretchr/testify/require` to assert the error is nil. If it isn't, the test fails immediately with a clear message and the correct stack frame.

```go
import "github.com/stretchr/testify/require"

// good
c, err := scancache.Load(p)
require.NoError(t, err)
c.SetDigest("sha256:x", nil)

info, err := os.Stat(p)
require.NoError(t, err)
fmt.Println(info.ModTime())
```

## require vs assert

Both come from `testify`. The distinction has two lenses that usually agree:

**By consequence:** `require` calls `t.FailNow()` (stops immediately); `assert` calls `t.Fail()` (marks failure, continues). Use `require` when subsequent code would panic or produce meaningless noise if the assertion fails. Use `assert` to collect all failures in one run.

**By role:** `require` is for preconditions — things that must be true for the test itself to run correctly. `assert` is for the actual test outcome — the thing you are verifying.

In practice:

```go
c, err := scancache.Load(p)
require.NoError(t, err)  // precondition: c must be non-nil to continue
c.SetDigest("sha256:x", nil)

// ...later, the actual assertion being tested:
assert.Equal(t, want, got)
```

For error-guarded variables (anything you'll dereference), always prefer `require`.

For terminal assertions that are the point of the test, prefer `assert`:

## Variable Scope

When converting `x, _ :=` to `x, err :=`, watch for subsequent `:=` declarations of `err` in the same scope — they must become `=`:

```go
// before
c, _ := Load(p)
// ...
err := c.Save()  // first declaration of err

// after
c, err := Load(p)  // err declared here
require.NoError(t, err)
// ...
err = c.Save()  // = not :=
```

If the subsequent call introduces a new variable on the left side, `:=` remains valid even when `err` is already in scope:

```go
c, err := Load(p)
require.NoError(t, err)

agents, err := Discover(...)  // valid: agents is new
require.NoError(t, err)
```

## Expected Errors Should Be Asserted, Not Ignored

If a test expects an error, assert it positively — don't silently discard it. Ignoring an error with `_, _` and a comment is still poor practice: it makes the test weaker and hides regressions.

Use the appropriate testify assertion. Since these are the point of the test (not preconditions), prefer `assert`:

```go
// assert any error occurred
_, err := doSomething()
assert.Error(t, err)

// assert a specific sentinel error
_, err := doSomething()
assert.ErrorIs(t, err, ErrNotFound)

// assert an error of a specific type
var target *MyError
_, err := doSomething()
assert.ErrorAs(t, err, &target)
```

Applied to the cancelled-context example:

```go
ctx, cancel := context.WithCancel(context.Background())
cancel()

// Must not hang; context cancellation produces an error — assert it.
_, err := discovery.Discover(ctx, host, 2, 1, false, nil, inf(), opts...)
assert.Error(t, err)
```

## `_, _` Is Never Acceptable in Tests

There is no case in test code where silently discarding an error is correct. Even in concurrency or "must not hang" tests, the error is still meaningful:

```go
done := make(chan struct{})
go func() {
    _, err := fn(ctx)
    assert.NoError(t, err)
    close(done)
}()
select {
case <-done:
case <-time.After(time.Second):
    t.Fatal("fn did not return")
}
```

If you find yourself reaching for `_, _`, ask: should this be `require.NoError`, `assert.NoError`, `assert.Error`, or `assert.ErrorIs`? One of those is always the right answer.
