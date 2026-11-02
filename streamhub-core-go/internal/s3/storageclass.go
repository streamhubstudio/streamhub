package s3

import "strings"

// StorageClasses are the S3 storage classes an app may pin its uploads to
// (s3.storage_class ↔ AntMedia s3StorageClass): the PutObject-valid
// members of the SDK's types.StorageClass enum. SNOW / FSX_* / AWS_BACKUP_*
// are left out — they are not targets of a plain bucket PutObject.
var StorageClasses = []string{
	"STANDARD",
	"REDUCED_REDUNDANCY",
	"STANDARD_IA",
	"ONEZONE_IA",
	"INTELLIGENT_TIERING",
	"GLACIER",
	"DEEP_ARCHIVE",
	"GLACIER_IR",
	"OUTPOSTS",
	"EXPRESS_ONEZONE",
}

// NormalizeStorageClass trims and upper-cases raw; ok is false for a
// non-empty value outside StorageClasses. "" (= the bucket/provider
// default) is valid.
func NormalizeStorageClass(raw string) (class string, ok bool) {
	c := strings.ToUpper(strings.TrimSpace(raw))
	if c == "" {
		return "", true
	}
	for _, k := range StorageClasses {
		if c == k {
			return c, true
		}
	}
	return "", false
}
