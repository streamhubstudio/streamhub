package apps

import (
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/s3"
)

// s3.storage_class (AntMedia s3StorageClass, 3.4.0): the S3 storage class
// every upload of the app is written with. OFF when absent — the key is
// written only when set, so an existing config.yaml and every pre-3.4
// response are unchanged.

var storageClassMessage = "storageClass must be empty (provider default) or one of " + strings.Join(s3.StorageClasses, ", ")

// storageClassOf resolves s3.storage_class: a known class (upper-cased),
// anything else — unset, garbage — is "" (provider default).
func storageClassOf(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	class, _ := s3.NormalizeStorageClass(s)
	return class
}
