package yamljs

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Dump is yaml.dump(v, { lineWidth }) with js-yaml's defaults otherwise
// (indent 2, flowLevel -1, single quotes, compat mode on, no sortKeys).
// lineWidth 0 means js-yaml's default 80 and -1 means unlimited. The result
// ends with "\n"; a top-level Undefined dumps as "".
//
// Repeated *Map/[]any references are written out in full (js-yaml would
// emit &ref_N / *ref_N anchors). Values outside the value model panic, like
// js-yaml throwing "unacceptable kind of an object to dump".
func Dump(v any, lineWidth int) string {
	if lineWidth == 0 {
		lineWidth = 80
	}
	d := &dumper{lineWidth: lineWidth}
	if s, ok := d.writeNode(0, v, true, true, false); ok {
		return s + "\n"
	}
	return ""
}

const dumpIndent = 2 // state.indent

type dumper struct {
	lineWidth int
}

func generateNextLine(level int) string {
	return "\n" + strings.Repeat(" ", dumpIndent*level)
}

// writeNode serializes v; ok=false is js-yaml's "invalid object" (undefined).
func (d *dumper) writeNode(level int, v any, block, compact, iskey bool) (string, bool) {
	switch x := v.(type) {
	case undefinedT:
		return "", false
	case nil:
		return "null", true
	case bool:
		if x {
			return "true", true
		}
		return "false", true
	case float64:
		return representNumber(x), true
	case time.Time:
		return isoString(x), true
	case string:
		return d.writeScalar(x, level, iskey, block), true
	case *Map:
		if x == nil {
			return "null", true
		}
		if block && x.Len() != 0 {
			return d.writeBlockMapping(level, x, compact), true
		}
		return d.writeFlowMapping(level, x), true
	case []any:
		if block && len(x) != 0 {
			return d.writeBlockSequence(level, x, compact), true
		}
		return d.writeFlowSequence(level, x), true
	case []string:
		arr := make([]any, len(x))
		for i, s := range x {
			arr[i] = s
		}
		return d.writeNode(level, arr, block, compact, iskey)
	}
	if f, ok := toFloat(v); ok {
		return representNumber(f), true
	}
	panic(fmt.Sprintf("yamljs: unacceptable kind of an object to dump %T", v))
}

func (d *dumper) writeFlowSequence(level int, arr []any) string {
	var b strings.Builder
	for _, v := range arr {
		s, ok := d.writeNode(level, v, false, false, false)
		if !ok && IsUndefined(v) {
			s, ok = d.writeNode(level, nil, false, false, false)
		}
		if !ok {
			continue
		}
		if b.Len() != 0 {
			b.WriteString(", ")
		}
		b.WriteString(s)
	}
	return "[" + b.String() + "]"
}

func (d *dumper) writeBlockSequence(level int, arr []any, compact bool) string {
	var b strings.Builder
	for _, v := range arr {
		s, ok := d.writeNode(level+1, v, true, true, false)
		if !ok && IsUndefined(v) {
			s, ok = d.writeNode(level+1, nil, true, true, false)
		}
		if !ok {
			continue
		}
		if !compact || b.Len() != 0 {
			b.WriteString(generateNextLine(level))
		}
		if strings.HasPrefix(s, "\n") {
			b.WriteString("-")
		} else {
			b.WriteString("- ")
		}
		b.WriteString(s)
	}
	if b.Len() == 0 {
		return "[]"
	}
	return b.String()
}

func (d *dumper) writeFlowMapping(level int, m *Map) string {
	var b strings.Builder
	for _, k := range m.Keys() {
		pair := ""
		if b.Len() != 0 {
			pair = ", "
		}
		ks, _ := d.writeNode(level, k, false, false, false)
		if jsx.UTF16Len(ks) > 1024 {
			pair += "? "
		}
		pair += ks + ": "
		vs, ok := d.writeNode(level, m.vals[k], false, false, false)
		if !ok {
			continue
		}
		b.WriteString(pair + vs)
	}
	return "{" + b.String() + "}"
}

func (d *dumper) writeBlockMapping(level int, m *Map, compact bool) string {
	var b strings.Builder
	for _, k := range m.Keys() {
		pair := ""
		if !compact || b.Len() != 0 {
			pair = generateNextLine(level)
		}
		ks, _ := d.writeNode(level+1, k, true, true, true)
		explicitPair := jsx.UTF16Len(ks) > 1024
		if explicitPair {
			if strings.HasPrefix(ks, "\n") {
				pair += "?"
			} else {
				pair += "? "
			}
		}
		pair += ks
		if explicitPair {
			pair += generateNextLine(level)
		}
		vs, ok := d.writeNode(level+1, m.vals[k], true, explicitPair, false)
		if !ok {
			continue // undefined values are skipped
		}
		if strings.HasPrefix(vs, "\n") {
			pair += ":"
		} else {
			pair += ": "
		}
		b.WriteString(pair + vs)
	}
	if b.Len() == 0 {
		return "{}"
	}
	return b.String()
}

// ---- scalars ------------------------------------------------------------------

const (
	charBOM         = 0xFEFF
	charTab         = 0x09
	charLineFeed    = 0x0A
	charCarriageRet = 0x0D
	charSpace       = 0x20
	charSharp       = 0x23
	charComma       = 0x2C
	charColon       = 0x3A
	charLeftSquare  = 0x5B
	charRightSquare = 0x5D
	charLeftCurly   = 0x7B
	charRightCurly  = 0x7D
	styleUnsetPrev  = -1 // "prevChar = null"
	maxIndentPerLvl = 9
)

var escapeSequences = map[int]string{
	0x00: `\0`, 0x07: `\a`, 0x08: `\b`, 0x09: `\t`, 0x0A: `\n`, 0x0B: `\v`, 0x0C: `\f`,
	0x0D: `\r`, 0x1B: `\e`, 0x22: `\"`, 0x5C: `\\`, 0x85: `\N`, 0xA0: `\_`,
	0x2028: `\L`, 0x2029: `\P`,
}

var deprecatedBooleans = map[string]bool{
	"y": true, "Y": true, "yes": true, "Yes": true, "YES": true, "on": true, "On": true, "ON": true,
	"n": true, "N": true, "no": true, "No": true, "NO": true, "off": true, "Off": true, "OFF": true,
}

var deprecatedBase60 = regexp.MustCompile(`^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$`)

type scalarStyle int

const (
	stylePlain scalarStyle = iota + 1
	styleSingle
	styleLiteral
	styleFolded
	styleDouble
)

func isWhitespace(c int) bool { return c == charSpace || c == charTab }

// isPrintable: nb-char - \t - #x85 - #xA0 - #x2028 - #x2029.
func isPrintable(c int) bool {
	return (c >= 0x20 && c <= 0x7E) ||
		(c >= 0xA1 && c <= 0xD7FF && c != 0x2028 && c != 0x2029) ||
		(c >= 0xE000 && c <= 0xFFFD && c != charBOM) ||
		(c >= 0x10000 && c <= 0x10FFFF)
}

func isNsCharOrWhitespace(c int) bool {
	return isPrintable(c) && c != charBOM && c != charCarriageRet && c != charLineFeed
}

func isPlainSafe(c, prev int, inblock bool) bool {
	cIsNsCharOrWhitespace := isNsCharOrWhitespace(c)
	cIsNsChar := cIsNsCharOrWhitespace && !isWhitespace(c)
	var safe bool
	if inblock {
		safe = cIsNsCharOrWhitespace
	} else {
		safe = cIsNsCharOrWhitespace && c != charComma && c != charLeftSquare &&
			c != charRightSquare && c != charLeftCurly && c != charRightCurly
	}
	return (safe && c != charSharp && !(prev == charColon && !cIsNsChar)) ||
		(isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c == charSharp) ||
		(prev == charColon && cIsNsChar)
}

func isPlainSafeFirst(c int) bool {
	if !isPrintable(c) || c == charBOM || isWhitespace(c) {
		return false
	}
	switch c {
	case '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '=', '>', '\'', '"', '%', '@', '`':
		return false
	}
	return true
}

func isPlainSafeLast(c int) bool { return !isWhitespace(c) && c != charColon }

// codePointAt is String#codePointAt over UTF-16 code units.
func codePointAt(s []uint16, pos int) int {
	first := int(s[pos])
	if first >= 0xD800 && first <= 0xDBFF && pos+1 < len(s) {
		second := int(s[pos+1])
		if second >= 0xDC00 && second <= 0xDFFF {
			return (first-0xD800)*0x400 + second - 0xDC00 + 0x10000
		}
	}
	return first
}

// needIndentIndicator is /^\n* /.test(s).
func needIndentIndicator(s string) bool {
	return strings.HasPrefix(strings.TrimLeft(s, "\n"), " ")
}

// chooseScalarStyle picks the preferred scalar style (see dumper.js);
// lineWidth -1 means no limit.
func chooseScalarStyle(s []uint16, singleLineOnly bool, indentPerLevel, lineWidth int,
	ambiguous func() bool, inblock bool) scalarStyle {
	char := 0
	prev := styleUnsetPrev
	hasLineBreak := false
	hasFoldableLine := false
	shouldTrackWidth := lineWidth != -1
	previousLineBreak := -1
	plain := isPlainSafeFirst(codePointAt(s, 0)) && isPlainSafeLast(codePointAt(s, len(s)-1))
	notSpaceAt := func(i int) bool { return i >= len(s) || s[i] != ' ' }
	step := func(i int) int {
		if char >= 0x10000 {
			return i + 2
		}
		return i + 1
	}

	i := 0
	if singleLineOnly {
		for ; i < len(s); i = step(i) {
			char = codePointAt(s, i)
			if !isPrintable(char) {
				return styleDouble
			}
			plain = plain && isPlainSafe(char, prev, inblock)
			prev = char
		}
	} else {
		for ; i < len(s); i = step(i) {
			char = codePointAt(s, i)
			if char == charLineFeed {
				hasLineBreak = true
				if shouldTrackWidth {
					hasFoldableLine = hasFoldableLine ||
						(i-previousLineBreak-1 > lineWidth && notSpaceAt(previousLineBreak+1))
					previousLineBreak = i
				}
			} else if !isPrintable(char) {
				return styleDouble
			}
			plain = plain && isPlainSafe(char, prev, inblock)
			prev = char
		}
		hasFoldableLine = hasFoldableLine || (shouldTrackWidth &&
			(i-previousLineBreak-1 > lineWidth && notSpaceAt(previousLineBreak+1)))
	}
	if !hasLineBreak && !hasFoldableLine {
		if plain && !ambiguous() {
			return stylePlain
		}
		return styleSingle
	}
	if indentPerLevel > maxIndentPerLvl && needIndentIndicator(string(utf16.Decode(s))) {
		return styleDouble
	}
	if hasFoldableLine {
		return styleFolded
	}
	return styleLiteral
}

// writeScalar is dumper.js writeScalar for a string value.
func (d *dumper) writeScalar(str string, level int, iskey, inblock bool) string {
	if str == "" {
		return "''"
	}
	if deprecatedBooleans[str] || deprecatedBase60.MatchString(str) {
		return "'" + str + "'"
	}
	indent := dumpIndent * max(1, level) // no 0-indent scalars
	lineWidth := -1
	if d.lineWidth != -1 {
		lineWidth = max(min(d.lineWidth, 40), d.lineWidth-indent)
	}
	u := utf16.Encode([]rune(str))
	switch chooseScalarStyle(u, iskey, dumpIndent, lineWidth, func() bool { return testImplicitResolving(str) }, inblock) {
	case stylePlain:
		return str
	case styleSingle:
		return "'" + strings.ReplaceAll(str, "'", "''") + "'"
	case styleLiteral:
		return "|" + blockHeader(str, dumpIndent) + dropEndingNewline(indentString(str, indent))
	case styleFolded:
		folded := string(utf16.Decode(foldString(u, lineWidth)))
		return ">" + blockHeader(str, dumpIndent) + dropEndingNewline(indentString(folded, indent))
	default:
		return `"` + escapeString(u) + `"`
	}
}

// blockHeader is the block scalar indentation + chomping indicator line.
func blockHeader(s string, indentPerLevel int) string {
	indicator := ""
	if needIndentIndicator(s) {
		indicator = fmt.Sprint(indentPerLevel)
	}
	clip := strings.HasSuffix(s, "\n")
	keep := clip && (strings.HasSuffix(s, "\n\n") || s == "\n")
	chomp := "-"
	switch {
	case keep:
		chomp = "+"
	case clip:
		chomp = ""
	}
	return indicator + chomp + "\n"
}

func dropEndingNewline(s string) string { return strings.TrimSuffix(s, "\n") }

// indentString indents every line except empty ("\n"-only) ones.
func indentString(s string, spaces int) string {
	ind := strings.Repeat(" ", spaces)
	var b strings.Builder
	for len(s) > 0 {
		line := s
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			line = s[:i+1]
		}
		s = s[len(line):]
		if line != "\n" {
			b.WriteString(ind)
		}
		b.WriteString(line)
	}
	return b.String()
}

// foldString folds every content line to width; k newlines between two
// normal lines become k+1 (see dumper.js).
func foldString(s []uint16, width int) []uint16 {
	nextLF := indexU16(s, '\n', 0)
	if nextLF == -1 {
		nextLF = len(s)
	}
	result := append([]uint16(nil), foldLine(s[:nextLF], width)...)
	prevMoreIndented := len(s) > 0 && (s[0] == '\n' || s[0] == ' ')

	// lineRe = /(\n+)([^\n]*)/g starting at nextLF.
	pos := nextLF
	for pos < len(s) {
		start := pos
		for pos < len(s) && s[pos] == '\n' {
			pos++
		}
		prefix := s[start:pos]
		lineStart := pos
		for pos < len(s) && s[pos] != '\n' {
			pos++
		}
		line := s[lineStart:pos]
		moreIndented := len(line) > 0 && line[0] == ' '
		result = append(result, prefix...)
		if !prevMoreIndented && !moreIndented && len(line) != 0 {
			result = append(result, '\n')
		}
		result = append(result, foldLine(line, width)...)
		prevMoreIndented = moreIndented
	}
	return result
}

// foldLine is the greedy line breaker: the longest line under the limit,
// otherwise the shortest over it. More-indented lines are never folded.
func foldLine(line []uint16, width int) []uint16 {
	if len(line) == 0 || line[0] == ' ' {
		return line
	}
	var result []uint16
	start, curr := 0, 0
	// breakRe = / [^ ]/g: every space followed by a non-space.
	for next := 0; next+1 < len(line); next++ {
		if line[next] != ' ' || line[next+1] == ' ' {
			continue
		}
		if next-start > width {
			end := next
			if curr > start {
				end = curr
			}
			result = append(result, '\n')
			result = append(result, line[start:end]...)
			start = end + 1
		}
		curr = next
	}
	result = append(result, '\n')
	if len(line)-start > width && curr > start {
		result = append(result, line[start:curr]...)
		result = append(result, '\n')
		result = append(result, line[curr+1:]...)
	} else {
		result = append(result, line[start:]...)
	}
	return result[1:]
}

func indexU16(s []uint16, c uint16, from int) int {
	for i := from; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// escapeString escapes a double-quoted scalar.
func escapeString(s []uint16) string {
	var b strings.Builder
	char := 0
	for i := 0; i < len(s); {
		char = codePointAt(s, i)
		seq, ok := escapeSequences[char]
		switch {
		case !ok && isPrintable(char):
			if char >= 0x10000 {
				b.WriteRune(rune(char))
			} else {
				b.WriteRune(rune(s[i]))
			}
		case ok:
			b.WriteString(seq)
		default:
			b.WriteString(encodeHex(char))
		}
		if char >= 0x10000 {
			i += 2
		} else {
			i++
		}
	}
	return b.String()
}

// encodeHex is \xXX, \uXXXX or \UXXXXXXXX (uppercase hex).
func encodeHex(c int) string {
	switch {
	case c <= 0xFF:
		return fmt.Sprintf(`\x%02X`, c)
	case c <= 0xFFFF:
		return fmt.Sprintf(`\u%04X`, c)
	}
	return fmt.Sprintf(`\U%08X`, c)
}
