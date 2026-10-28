package api

import (
	"math"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// ParseNumberIntParam is ParseIntPipe on a param declared `id: number`: the
// global ValidationPipe (transform + implicit conversion) runs Number(v)
// first, so "1e3", " 12 " and "0x10" pass while "abc" / "1.5" are 400.
func ParseNumberIntParam(v string) (int64, error) {
	n := y.StringToNumber(v)
	if math.IsNaN(n) || math.IsInf(n, 0) || !intParam.MatchString(y.JSNumberString(n)) {
		return 0, httpx.BadRequest("Validation failed (numeric string is expected)")
	}
	return int64(n), nil
}
