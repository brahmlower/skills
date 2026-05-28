# Typed Nil in Interface

## The Problem

A nil pointer of a concrete type stored in an interface variable is **not** a nil interface. Go encodes interface values as a `(type, value)` pair. A nil `*T` produces `(type=*T, value=nil)` — the interface itself is non-nil and nil checks pass, but any method call that dereferences the pointer panics.

```go
type Doer interface{ Do() }

type Thing struct{}
func (t *Thing) Do() { _ = t.Field } // dereferences t

var concrete *Thing = nil          // nil pointer
var iface Doer = concrete          // interface is NOT nil

fmt.Println(iface == nil)          // false — type info is present
iface.Do()                         // PANIC: nil pointer dereference
```

This is one of Go's most common footguns. No standard linter (including golangci-lint's full suite) reliably catches it — it requires whole-program nil flow analysis (e.g. Uber's `nilaway`, which is not in golangci-lint).

## The Fix: Store as the Interface Type

Wherever a value will be used as an interface, store it as that interface type from the point of construction. The zero value of an interface is a proper nil — `(type=nil, value=nil)` — and nil checks behave correctly.

```go
// bad — concrete type stored in a struct, later passed as interface
type config struct {
    cache *scancache.Cache // nil when disabled
}

func build(noCache bool) config {
    var c config
    if !noCache {
        c.cache, _ = scancache.Load(path)
    }
    return c // c.cache may be (*scancache.Cache)(nil)
}

// Later: passing c.cache to a func expecting Cache interface
// → interface is non-nil, nil check passes, method call panics

// good — store as the interface type
type config struct {
    cache discovery.Cache // nil interface when disabled
}

func build(noCache bool) config {
    var c config
    if !noCache {
        loaded, _ := scancache.Load(path)
        c.cache = loaded // assigned as interface: nil check will work correctly
    }
    return c // c.cache is nil interface when not set
}
```

## The Rule

**When a field or variable will be consumed as an interface, declare it as that interface type — not the concrete type.**

This also applies to function parameters and return values used as interfaces. Assign the concrete value to the interface variable at the earliest opportunity so the nil is "interface-nil" from the start.

## Interface Assertion as a Compile-Time Check

Pair this pattern with an explicit compile-time interface assertion in the package that defines the concrete type, so structural drift is caught immediately:

```go
// in scancache/cache.go
var _ discovery.Cache = (*Cache)(nil)
```

This ensures `*Cache` always satisfies `discovery.Cache`, and is already recommended in SKILL.md under Object Oriented Programming.
