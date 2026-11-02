// Package fsperm holds the directory modes the core creates under DATA_DIR
// (security 3.3.4). They were 0o777 & umask (775 in prod): any local user
// could list and read every app's config, recordings and snapshots.
//
// The modes are tight but keep the two other processes that share the tree
// working. In both deploy shapes egress runs as uid 1001 / gid 0 and the
// DATA_DIR is group root (root-owned in Docker; setgid + group root on the
// native host), so egress gets the GROUP bits. On the native host nginx's
// HLS direct-serve reads apps/<app>/hls/** as OTHER (install.sh only grants
// it traverse on DATA_DIR and apps/). The process umask (002) keeps these as
// they are.
package fsperm

import "os"

const (
	// Private is a core-only dir (samples, transcode/DRM work dirs).
	Private os.FileMode = 0o750
	// EgressWritable is a dir egress writes into (recordings, snapshots —
	// the MP4s and the periodic recording images): group rwx, nothing for
	// other.
	EgressWritable os.FileMode = 0o770
	// AppRoot is DATA_DIR/apps/<app> (and the DB dirs): group r-x so egress
	// can reach its outputs, other traverse-only (no listing) so nginx can
	// reach hls/ below it.
	AppRoot os.FileMode = 0o751
	// PublicHLS is the live HLS tree (apps/<app>/hls/<room>): egress writes
	// the segments and nginx serves them as other. Its content is the public
	// /hls surface anyway.
	PublicHLS os.FileMode = 0o775
)
