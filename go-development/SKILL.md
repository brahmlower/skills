---
name: go-development
description: Triggers when writing go code, or reviewing go code for quality.
---

The abridged list of Go proverbs is:

- Don't communicate by sharing memory, share memory by communicating.
- Channels orchestrate; mutexes serialize.
- The bigger the interface, the weaker the abstraction.
- Make the zero value useful.
- interface{} says nothing.
- A little copying is better than a little dependency.
- Clear is better than clever.
- Reflection is never clear.
- Errors are values.
- Don't just check errors, handle them gracefully.
- Design the architecture, name the components, document the details.
- Documentation is for users.
- Don't panic.

Go is an object oriented language. Be sure to follow object oriented design and
control flows for best results.

## Object Oriented Programming

Go has simple but powerful object oriented language features. Make use of
interface design and pointer recievers as much as possible. This improves
testability and module architecture.

Explicitly assert interfaces on structs:
```go
var _ InterfaceName = (*TypeName)(nil)
```

Keep the public interface on structs as minimal as possible.

Structs for data transfer objects (DTOs) should be seprate from control structs.

### Planning

Before writing any code:

- [ ] Find any relevant interfaces
- [ ] Consider if an interface would help keep changes maintainable and testable
- [ ] Consider if composition of existing functions can achieve the goal rather than adding new functions

## Control Flows

Deeply nested control structures are a code smell, and generally mean logic can
be simplified or the function should be broken up into smaller pieces.

Find ways to early exit (or break).

The `else` block on `if` statements is rarely needed.

### Redundant range guards

Don't guard a `for range` loop with a length or nil check when the loop already
handles the empty/nil case correctly — an empty slice simply produces zero
iterations.

```go
// bad — guard is redundant
if len(items) == 0 {
    return nil
}
for _, item := range items {
    ...
}

// good
for _, item := range items {
    ...
}
```

The exception is when the early return has meaningfully different semantics
— e.g., returning a distinct sentinel, logging, or when a non-nil empty result
matters to callers.

## Useful Patterns

- [Options Pattern](options-pattern.md)
- [Typed Nil in Interface](typed-nil-in-interface.md)
- [Assert Errors in Tests with require.NoError](require-no-error-in-tests.md)
