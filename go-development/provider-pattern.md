# Provider Pattern (Service Composition & Transactions)

## The Problem

Hand-wiring dependencies breaks down as a service graph grows:

```go
catalogSvc := catalog.New(db)
cartSvc := cart.New(db, catalogSvc)
ordersSvc := orders.New(db, cartSvc, catalogSvc)

checkoutHandler := web.NewCheckout(cartSvc, ordersSvc, billingSvc, logger)
```

Every consumer's constructor lists concrete service pointers, threaded by
hand from wherever wiring happens. No single place owns "how do I get
service X" — adding or changing a dependency means touching every call site.

## The Pattern

- Each service package declares a `Provider` interface with just an
  accessor: `type Provider interface { Cart() *Service }`.
- One composition-root type (`Server` or similar) holds what every service
  is built from and implements *every* service's `Provider` interface,
  constructing each service on demand.
- Composite provider methods call other provider methods on the same root
  (`s.Cart()` calls `s.Catalog()`) — never hold pre-built pointers.
- Consumers depend on the narrowest `Provider` interface(s) they need, not
  the concrete root and not individual service pointers.

## Why This Was Useful

- Consumers stay decoupled from the composition root — they take an
  interface and are trivially testable with a stub.
- Only the root needs to know how to wire the full graph. Adding or
  changing a service touches the root, not every consumer.

## Implementation Details

1. **Name interfaces `Provider`, not `CatalogProvider`.**

   The qualified name (`catalog.Provider`) already reads clearly at call sites,
   and a stutter linter will flag the redundant version. Interface embedding is
   a method-set union, not struct-field embedding, so composing several
   same-named `Provider` interfaces never collides.

2. **Hold the provider in a *named* field, never embed it:**

   ```go
   // do this
   type Handler struct { p checkoutProviders }
   func (h *Handler) X() { h.p.Cart().Checkout(...) }

   // not this — two embedded Provider types collide on field name
   type Handler struct { checkoutProviders }
   func (h *Handler) X() { h.Cart().Checkout(...) }
   ```

   Struct embedding derives the field name from the unqualified type name,
   so two embedded `Provider` types won't compile. A named field also reads
   more honestly: `Cart()` is clearly an injected dependency.

## Minimal Reproducible Example

```go
// ---- package catalog ----
package catalog

type Querier interface {
	Query(sql string, args ...any) (string, error)
}

type Service struct{ q Querier }

func New(q Querier) *Service { return &Service{q: q} }

func (s *Service) GetPrice(sku string) (int, error) {
	_, err := s.q.Query("SELECT price FROM items WHERE sku = ?", sku)
	return 0, err
}

type Provider interface {
	Catalog() *Service
}
```

```go
// ---- package cart ----
package cart

import "example.com/app/catalog"

type Service struct {
	q       catalog.Querier
	catalog *catalog.Service
}

func New(q catalog.Querier, cat *catalog.Service) *Service {
	return &Service{q: q, catalog: cat}
}

func (s *Service) Checkout(userID string) error {
	_, err := s.catalog.GetPrice("sku-1") // composes with catalog
	if err != nil {
		return err
	}
	_, err = s.q.Query("INSERT INTO orders (user_id) VALUES (?)", userID)
	return err
}

type Provider interface {
	Cart() *Service
}
```

```go
// ---- package app: the composition root ----
package app

import (
	"example.com/app/cart"
	"example.com/app/catalog"
)

type Server struct {
	q catalog.Querier
}

func New(q catalog.Querier) *Server { return &Server{q: q} }

func (s *Server) Catalog() *catalog.Service { return catalog.New(s.q) }
func (s *Server) Cart() *cart.Service       { return cart.New(s.q, s.Catalog()) }
```

```go
// ---- a consumer that needs two services ----
package web

import (
	"example.com/app/cart"
	"example.com/app/catalog"
)

type checkoutProviders interface {
	cart.Provider
	catalog.Provider
}

type CheckoutHandler struct {
	p checkoutProviders
}

func NewCheckoutHandler(p checkoutProviders) *CheckoutHandler {
	return &CheckoutHandler{p: p}
}

func (h *CheckoutHandler) Price(sku string) (int, error) {
	return h.p.Catalog().GetPrice(sku)
}
```

## Database Transactions

The composition root also solves running an operation across several
services inside one DB transaction (e.g. create an order, bump an install
count, clear the cart — all-or-nothing).

Without it, each service is bound to its own query handle at startup, and
giving a consumer two services bound to the *same* transaction needs a
`WithTx` clone method on every service. With the root in place, an
`Atomic` method begins a transaction and calls the caller's function with a
**new root instance** whose query handle is transaction-bound — every
provider reached through it is automatically transaction-scoped.

### Implementation Details

1. **Composite provider methods must call sibling methods on the same
   instance, never a pre-built pointer** — this is what makes transactions
   free:

   ```go
   func (s *Server) Cart() *cart.Service     { return cart.New(s.q, s.Catalog()) }
   func (s *Server) Orders() *orders.Service { return orders.New(s.q, s.Cart(), s.Catalog()) }
   ```

   not

   ```go
   type Server struct {
       cartSvc *cart.Service // WRONG: built once, frozen to the original q
   }
   ```

   Because `Cart()` always asks `s` for `Catalog()`, a transaction-bound `s`
   produces a transaction-bound `Cart()` and `Catalog()` recursively, with
   no manual rebinding.

2. **`Atomic` returns a whole new root, not just the query handle** — so
   callers use the same provider methods (`tp.Orders()`) inside or outside
   a transaction.

3. **Thread `ctx` through the callback explicitly, don't close over it:**

   ```go
   func (s *Server) Atomic(ctx context.Context, fn func(ctx context.Context, tp *Server) error) error
   ```

   A closure over an outer `ctx` gets flagged by linters like
   golangci-lint's `contextcheck`.

4. **Only the root needs begin-capability.**

   Leaf services take just the query-handle interface; that capability never
   leaks into consumers that don't use `Atomic`.

### Extending the Example with Transactions

```go
// ---- package app: add begin-capability and Atomic ----
package app

import (
	"context"

	"example.com/app/cart"
	"example.com/app/catalog"
)

// TxBeginner is whatever can start a transaction and also serves as a
// Querier itself — a *sql.DB / *pgxpool.Pool satisfy this in a real app.
type TxBeginner interface {
	catalog.Querier
	Begin() (Tx, error)
}

type Tx interface {
	catalog.Querier
	Commit() error
	Rollback() error
}

type Server struct {
	q    catalog.Querier
	pool TxBeginner // only needed to start a transaction
}

func New(pool TxBeginner) *Server { return &Server{q: pool, pool: pool} }

func (s *Server) Catalog() *catalog.Service { return catalog.New(s.q) }
func (s *Server) Cart() *cart.Service       { return cart.New(s.q, s.Catalog()) }

// Atomic runs fn inside one transaction: every provider method called on
// the Server fn receives is bound to that transaction.
func (s *Server) Atomic(ctx context.Context, fn func(ctx context.Context, tp *Server) error) error {
	tx, err := s.pool.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op once fn has committed

	if err := fn(ctx, &Server{q: tx, pool: s.pool}); err != nil {
		return err
	}

	return tx.Commit()
}
```

```go
// ---- the consumer: add a field for Atomic, and a method that uses it ----
package web

import (
	"context"

	"example.com/app"
)

type CheckoutHandler struct {
	p   checkoutProviders
	srv *app.Server // held only because this handler needs Atomic
}

// Complete is the multi-service write that needs atomicity.
func (h *CheckoutHandler) Complete(ctx context.Context, userID string) error {
	return h.srv.Atomic(ctx, func(ctx context.Context, tp *app.Server) error {
		return tp.Cart().Checkout(userID)
	})
}
```

`CheckoutHandler.Price` (the read-only method above) still depends only on
`checkoutProviders` — only the method needing atomicity pulls in the
concrete root.
