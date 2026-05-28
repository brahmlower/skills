---
name: go-embedded-fs
description: Triggers when embedding files in a go binary or working with `embed.FS`.
---

## Simple Embedded Templates

An example package can contain a `templates.go` file like:

```go
package mypackage

import "embed"

//go:embed all:templates
var templateFS embed.FS
```

The template files then live in the `templates` subdirectory. Templates are then
parsed via `ParseFS` like so:

```go
tmpls, err = template.ParseFS(templateFS, "templates/*.tmpl")
```

The [overlayed-fs](overlayed-fs.md) may be helpful if you want/need to check
multiple filesystems while accessing a file.

## Overlayed FS

Filesystem overlays are useful when we have a filepath that may refer to an
embedded asset, or an external asset. This is merely a wrapper around existing
`fs.FS` instances which attempts to read those files from the filesystems in
the order they were provided.

This is a **readonly** solution though. The current implemenation does not
support writing to the filesystem.

```go
package pkg

import (
	"io/fs"
)

func NewLayeredFS(layers ...fs.FS) *LayeredFS {
	return &LayeredFS{
		layers: layers,
	}
}

type LayeredFS struct {
	layers []fs.FS
}

var _ fs.FS = (*LayeredFS)(nil)
var _ fs.GlobFS = (*LayeredFS)(nil)
var _ fs.ReadFileFS = (*LayeredFS)(nil)

func (l *LayeredFS) Open(name string) (fs.File, error) {
	var lastErr error
	var f fs.File
	for _, layer := range l.layers {
		f, lastErr = layer.Open(name)
		if lastErr == nil {
			return f, nil
		}
	}

	return nil, lastErr
}

func (l *LayeredFS) Glob(name string) ([]string, error) {
	return []string{name}, nil
}

func (l *LayeredFS) ReadFile(name string) ([]byte, error) {
	var lastErr error
	var b []byte
	for _, layer := range l.layers {
		b, lastErr = fs.ReadFile(layer, name)
		if lastErr == nil {
			return b, nil
		}
	}

	return nil, lastErr
}
```

For example, this can be instantiated with the embedded filesystem first and
the external filesystem second, so that the embedded fs is checked first when
filepaths are accessed.

```go
layeredFs := pkg.NewLayeredFS(templateFS, root.FS())
```

However if the desired behavior is to use the embedded fs as a backup/default
when a path is absent from the external filesystem, the arguments to the
constructure can merely be reversed:

```go
layeredFs := pkg.NewLayeredFS(root.FS(), templateFS)
```
