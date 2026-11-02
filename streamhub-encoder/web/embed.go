// Package web embeds the local operator UI (static, no build step).
package web

import (
	"embed"
	"io/fs"
)

//go:embed index.html
var files embed.FS

// FS returns the UI file system.
func FS() fs.FS { return files }
