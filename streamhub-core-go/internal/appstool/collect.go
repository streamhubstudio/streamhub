package appstool

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// Sha256Hex is the hex SHA-256 of b.
func Sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// excludedDirs are build/cache/VCS noise, never source.
var excludedDirs = map[string]bool{
	"__pycache__": true, ".pytest_cache": true, ".mypy_cache": true, ".ruff_cache": true, ".git": true,
	".venv": true, "venv": true, "env": true, "node_modules": true, ".idea": true, ".vscode": true, "build": true, "dist": true,
}

// maxFileBytes: anything bigger is a model/weights binary — skipped (source-only).
const maxFileBytes = 5 * 1024 * 1024

var (
	pycRE  = regexp.MustCompile(`\.py[cod]$`)
	dbRE   = regexp.MustCompile(`\.db(-journal|-wal|-shm)?$`)
	testRE = regexp.MustCompile(`\.(spec|test)\.(ts|tsx|js|jsx)$`)
)

func isJunkFile(name string) bool {
	return name == ".DS_Store" || pycRE.MatchString(name) || dbRE.MatchString(name)
}

// IsWorkerFileExcluded drops caches, compiled python and databases.
func IsWorkerFileExcluded(name string) bool { return isJunkFile(name) }

// IsFrontendFileExcluded additionally drops tests (they run in the app repo).
func IsFrontendFileExcluded(name string) bool { return isJunkFile(name) || testRE.MatchString(name) }

// NoExclude keeps every file.
func NoExclude(string) bool { return false }

// collator orders directory entries like V8's String#localeCompare (ICU root
// collation): case-insensitive first, punctuation before letters, `_` before
// `-` before `.` — NOT byte order. The pinned tars depend on this order.
var collator = collate.New(language.Und)

// localeLess is a.localeCompare(b) < 0.
func localeLess(a, b string) bool { return collator.CompareString(a, b) < 0 }

// CollectDir walks absDir into entries named prefix/<rel>, each directory's
// children sorted with localeCompare (appcompose.mjs collectDir): excluded dirs
// (+ *.egg-info) and excludeFile(name) are skipped, as are files over 5 MiB
// and anything that is neither a directory nor a regular file (symlinks).
func CollectDir(absDir, prefix string, excludeFile func(string) bool) ([]Entry, error) {
	if excludeFile == nil {
		excludeFile = NoExclude
	}
	var out []Entry
	var walk func(abs, rel string) error
	walk = func(abs, rel string) error {
		ents, err := os.ReadDir(abs)
		if err != nil {
			return err
		}
		sort.SliceStable(ents, func(i, j int) bool { return localeLess(ents[i].Name(), ents[j].Name()) })
		for _, d := range ents {
			name := d.Name()
			switch {
			case d.IsDir():
				if excludedDirs[name] || strings.HasSuffix(name, ".egg-info") {
					continue
				}
				sub := name
				if rel != "" {
					sub = rel + "/" + name
				}
				if err := walk(filepath.Join(abs, name), sub); err != nil {
					return err
				}
			case d.Type().IsRegular():
				if excludeFile(name) {
					continue
				}
				full := filepath.Join(abs, name)
				st, err := os.Stat(full)
				if err != nil {
					return err
				}
				if st.Size() > maxFileBytes {
					continue
				}
				body, err := os.ReadFile(full)
				if err != nil {
					return err
				}
				entry := prefix + "/" + name
				if rel != "" {
					entry = prefix + "/" + rel + "/" + name
				}
				out = append(out, Entry{Name: entry, Body: body})
			}
		}
		return nil
	}
	return out, walk(absDir, "")
}

// jsSpace is JS \s (ECMAScript WhiteSpace + LineTerminator).
const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var importRE = regexp.MustCompile(`(\bfrom` + jsSpace + `+['"]|\bimport` + jsSpace + `*\(` + jsSpace + `*['"]|\bimport` + jsSpace + `+['"])\.\./`)

// RewriteVendorImports retargets a vendored frontend file's single-`../`
// imports (which point INTO the sibling src/plugins/) at ../../plugins/;
// `../../…` specifiers resolve the same from streamhub-web/src/plugins-vendor/<id>/ and are
// left alone (appcompose.mjs rewriteVendorImports, whose (?!\.\.) look-ahead
// this reproduces).
func RewriteVendorImports(src string) string {
	var b strings.Builder
	pos := 0
	for pos <= len(src) {
		loc := importRE.FindStringSubmatchIndex(src[pos:])
		if loc == nil {
			break
		}
		start, end := pos+loc[0], pos+loc[1]
		groupEnd := pos + loc[3]
		if strings.HasPrefix(src[end:], "..") {
			// look-ahead failed at this position: retry one byte later
			b.WriteString(src[pos : start+1])
			pos = start + 1
			continue
		}
		b.WriteString(src[pos:groupEnd])
		b.WriteString("../../plugins/")
		pos = end
	}
	b.WriteString(src[pos:])
	return b.String()
}
