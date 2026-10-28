package yamljs

import (
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// JSNumberString is Number.prototype.toString() for a float64: the shortest
// round-trip digits, fixed notation for 1e-7 <= |x| < 1e21, otherwise
// exponential ("1e+21", "1.5e-7"); NaN, Infinity, -Infinity; -0 is "0".
func JSNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// Shortest digits d1.d2...dk e±X; JS's n is X+1 (value = 0.d × 10^n).
	mant, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mant, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	k, n := len(digits), x+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	e := n - 1
	es := "+"
	if e < 0 {
		es, e = "-", -e
	}
	if k == 1 {
		return sign + digits + "e" + es + strconv.Itoa(e)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(e)
}

// isNegativeZero is common.isNegativeZero.
func isNegativeZero(f float64) bool { return f == 0 && math.Signbit(f) }

// ---- !!null -----------------------------------------------------------------

// resolveNull is resolveYamlNull for a non-null string.
func resolveNull(s string) bool {
	return s == "~" || s == "null" || s == "Null" || s == "NULL"
}

// ---- !!bool -----------------------------------------------------------------

func resolveBool(s string) bool {
	switch s {
	case "true", "True", "TRUE", "false", "False", "FALSE":
		return true
	}
	return false
}

func constructBool(s string) bool { return s == "true" || s == "True" || s == "TRUE" }

// ---- !!int ------------------------------------------------------------------
// This js-yaml copy has no "_" digit separators (1_000 stays a string).

func isHexCode(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'A' && c <= 'F' || c >= 'a' && c <= 'f'
}

// resolveInt is resolveYamlInteger.
func resolveInt(data string) bool {
	max := len(data)
	if max == 0 {
		return false
	}
	at := func(i int) byte { // data[i], 0 standing in for undefined
		if i < max {
			return data[i]
		}
		return 0
	}
	index := 0
	hasDigits := false
	ch := at(index)
	if ch == '-' || ch == '+' {
		index++
		ch = at(index)
	}
	if ch == '0' {
		if index+1 == max {
			return true
		}
		index++
		ch = at(index)
		var ok func(byte) bool
		switch ch {
		case 'b':
			ok = func(c byte) bool { return c == '0' || c == '1' }
		case 'x':
			ok = isHexCode
		case 'o':
			ok = func(c byte) bool { return c >= '0' && c <= '7' }
		}
		if ok != nil {
			for index++; index < max; index++ {
				if !ok(data[index]) {
					return false
				}
				hasDigits = true
			}
			return hasDigits && isFinite(parseInt(data))
		}
	}
	for ; index < max; index++ {
		if c := data[index]; c < '0' || c > '9' {
			return false
		}
		hasDigits = true
	}
	return hasDigits && isFinite(parseInt(data))
}

// parseInt is parseYamlInteger (input already validated by resolveInt).
func parseInt(data string) float64 {
	value := data
	sign := 1.0
	if value != "" && (value[0] == '-' || value[0] == '+') {
		if value[0] == '-' {
			sign = -1
		}
		value = value[1:]
	}
	if value == "0" {
		return 0 // not sign*0: "-0" loads as +0 through the int type
	}
	if len(value) > 1 && value[0] == '0' {
		switch value[1] {
		case 'b':
			return sign * radixToFloat(value[2:], 2)
		case 'x':
			return sign * radixToFloat(value[2:], 16)
		case 'o':
			return sign * radixToFloat(value[2:], 8)
		}
	}
	f, _ := strconv.ParseFloat(value, 64) // all-decimal digits; ±Inf on overflow
	return sign * f
}

// radixToFloat is parseInt(digits, radix) for power-of-two radixes: the exact
// integer rounded to the nearest double.
func radixToFloat(digits string, radix int) float64 {
	n, ok := new(big.Int).SetString(digits, radix)
	if !ok {
		return math.NaN()
	}
	f, _ := new(big.Float).SetInt(n).Float64()
	return f
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// ---- !!float ----------------------------------------------------------------

var (
	floatPattern = regexp.MustCompile(`^(?:[-+]?(?:[0-9]+)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?` +
		`|\.[0-9]+(?:[eE][-+]?[0-9]+)?` +
		`|[-+]?\.(?:inf|Inf|INF)` +
		`|\.(?:nan|NaN|NAN))$`)
	floatSpecialPattern = regexp.MustCompile(`^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$`)
)

// jsParseFloat is parseFloat for strings already matching floatPattern's
// numeric branches (NaN for anything else).
func jsParseFloat(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !isRangeErr(err) {
		return math.NaN()
	}
	return f
}

// resolveFloat is resolveYamlFloat.
func resolveFloat(data string) bool {
	if !floatPattern.MatchString(data) {
		return false
	}
	if isFinite(jsParseFloat(data)) {
		return true
	}
	return floatSpecialPattern.MatchString(data)
}

// constructFloat is constructYamlFloat.
func constructFloat(data string) float64 {
	value := strings.ToLower(data)
	sign := 1.0
	if value != "" && value[0] == '-' {
		sign = -1
	}
	if value != "" && (value[0] == '+' || value[0] == '-') {
		value = value[1:]
	}
	switch value {
	case ".inf":
		return math.Inf(int(sign))
	case ".nan":
		return math.NaN()
	}
	return sign * jsParseFloat(value)
}

// representFloat is representYamlFloat with the default "lowercase" style.
func representFloat(f float64) string {
	switch {
	case math.IsNaN(f):
		return ".nan"
	case math.IsInf(f, 1):
		return ".inf"
	case math.IsInf(f, -1):
		return "-.inf"
	case isNegativeZero(f):
		return "-0.0"
	}
	res := JSNumberString(f)
	if scientificWithoutDot.MatchString(res) {
		return strings.Replace(res, "e", ".e", 1)
	}
	return res
}

var scientificWithoutDot = regexp.MustCompile(`^[-+]?[0-9]+e`)

// representNumber picks the int (decimal) or float representer like the
// dumper's detectType: integers that are not -0 go through toString(10).
func representNumber(f float64) string {
	if isFinite(f) && f == math.Trunc(f) && !isNegativeZero(f) {
		return JSNumberString(f)
	}
	return representFloat(f)
}

// ---- !!timestamp --------------------------------------------------------------

var (
	dateRegexp      = regexp.MustCompile(`^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$`)
	timestampRegexp = regexp.MustCompile(`^([0-9][0-9][0-9][0-9])` +
		`-([0-9][0-9]?)` +
		`-([0-9][0-9]?)` +
		`(?:[Tt]|[ \t]+)` +
		`([0-9][0-9]?)` +
		`:([0-9][0-9])` +
		`:([0-9][0-9])` +
		`(?:\.([0-9]*))?` +
		`(?:[ \t]*(Z|([-+])([0-9][0-9]?)` +
		`(?::([0-9][0-9]))?))?$`)
)

func resolveTimestamp(data string) bool {
	return dateRegexp.MatchString(data) || timestampRegexp.MatchString(data)
}

// constructTimestamp is constructYamlTimestamp: Date.UTC with its overflow
// normalisation (month 13, day 32, ...) and 0..99 → 1900+year mapping.
func constructTimestamp(data string) (time.Time, error) {
	m := dateRegexp.FindStringSubmatch(data)
	if m == nil {
		m = timestampRegexp.FindStringSubmatch(data)
	}
	if m == nil {
		return time.Time{}, fmt.Errorf("yamljs: date resolve error")
	}
	num := func(s string) int { n, _ := strconv.Atoi(s); return n }
	year, month, day := num(m[1]), num(m[2])-1, num(m[3])
	if year >= 0 && year <= 99 {
		year += 1900 // Date.UTC quirk
	}
	if len(m) < 5 || m[4] == "" {
		return time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC).AddDate(0, month, day-1), nil
	}
	hour, minute, second := num(m[4]), num(m[5]), num(m[6])
	fraction := 0
	if m[7] != "" {
		f := m[7]
		if len(f) > 3 {
			f = f[:3]
		}
		for len(f) < 3 {
			f += "0"
		}
		fraction = num(f)
	}
	t := time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC).AddDate(0, month, day-1).
		Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute +
			time.Duration(second)*time.Second + time.Duration(fraction)*time.Millisecond)
	if m[9] != "" {
		delta := time.Duration(num(m[10])*60+num(m[11])) * time.Minute
		if m[9] == "-" {
			delta = -delta
		}
		t = t.Add(-delta)
	}
	return t, nil
}

// isoString is Date#toISOString, including the ±YYYYYY extended years.
func isoString(t time.Time) string {
	t = t.UTC()
	y := t.Year()
	rest := t.Format("-01-02T15:04:05.000Z")
	switch {
	case y >= 0 && y <= 9999:
		return fmt.Sprintf("%04d%s", y, rest)
	case y < 0:
		return fmt.Sprintf("-%06d%s", -y, rest)
	}
	return fmt.Sprintf("+%06d%s", y, rest)
}

// ---- implicit resolution -----------------------------------------------------

// Resolved tags of the implicit types, in DEFAULT_SCHEMA order.
const (
	tagNull      = "!!null"
	tagBool      = "!!bool"
	tagInt       = "!!int"
	tagFloat     = "!!float"
	tagTimestamp = "!!timestamp"
	tagMerge     = "!!merge"
	tagStr       = "!!str"
	tagMap       = "!!map"
	tagSeq       = "!!seq"
)

// resolveImplicit runs the DEFAULT_SCHEMA implicit resolvers (null, bool,
// int, float, timestamp, merge) over a plain scalar; no match is a string.
func resolveImplicit(s string) (any, string, error) {
	switch {
	case resolveNull(s):
		return nil, tagNull, nil
	case resolveBool(s):
		return constructBool(s), tagBool, nil
	case resolveInt(s):
		return parseInt(s), tagInt, nil
	case resolveFloat(s):
		return constructFloat(s), tagFloat, nil
	case resolveTimestamp(s):
		t, err := constructTimestamp(s)
		return t, tagTimestamp, err
	case s == "<<":
		return s, tagMerge, nil
	}
	return s, tagStr, nil
}

// testImplicitResolving is the dumper's ambiguity check: would s load back as
// something other than a string?
func testImplicitResolving(s string) bool {
	return resolveNull(s) || resolveBool(s) || resolveInt(s) || resolveFloat(s) ||
		resolveTimestamp(s) || s == "<<"
}
