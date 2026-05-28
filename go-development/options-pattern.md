# Options Pattern

The options pattern is useful for configuration structs in public packages. It enables devs to either hardcode or dynamically select which values/features to set on a struct via its constructor.

```go
package structure

type houseOption func(*House)

func WithConcrete() houseOption {
	return func(h *House) {
		h.Material = "concrete"
	}
}

func WithoutFireplace() houseOption {
	return func(h *House) {
		h.HasFireplace = false
	}
}

func WithFloors(floors int) houseOption {
    return func(h *House) {
		h.floors = floors
	}
}

func NewHouse(opts ...houseOption) *House {
	h := &House{
		material:     "wood",
		hasFireplace: true,
		floors:       2,
	}

	// Call each option, letting it mutate the new instance
	for _, opt := range opts {
		opt(h)
	}

	return h
}

type House struct {
    material     string
    hasFireplace bool
    floors       int
}
```

This is use like:

```go
package main

import "structure"

func main() {
    structure.NewHouse(
        WithoutFireplace(),
        WithFloors(4),
    )
}
```

**Important details**
- The struct fields are private to protect internal state. The options pattern enables the caller to initialize the internal state via controlled channels (the `houseOptions`).
- The `houseOption` type is private to prevent external callers from creating their own options functions. This protects internal state from invalid configurations.
- All options functions are named with a leading `With` (or `Without` in the case of negative boolean values)
