package mqtt

import "strings"

// Event → topic-category mapping (mqtt-events.ts). Topic layout:
//
//	<topicPrefix>/<category>/<event>   e.g. streamhub/live/vod/vod_ready
//	<topicPrefix>/log/<level>          app log lines (mqtt.logs)

// EventCategory classifies a callback event into its MQTT topic category:
// alert | iot | plugin | vod | interaction | connection.
func EventCategory(event string) string {
	switch {
	case strings.HasPrefix(event, "stream.latency"), strings.HasPrefix(event, "health."):
		return "alert"
	case event == "iot.data", strings.HasPrefix(event, "iot."):
		return "iot"
	case strings.HasPrefix(event, "plugin_worker"):
		return "plugin"
	case strings.HasPrefix(event, "recording_"), strings.HasPrefix(event, "vod_"),
		strings.HasPrefix(event, "egress_"), event == "snapshot_taken":
		return "vod"
	case event == "chat_message", event == "reaction":
		return "interaction"
	}
	// room_*, participant_*, track_*, ingress_*, stream_*, hls_*, restream_*
	return "connection"
}

// EventTopic is <prefix>/<category>/<event>.
func EventTopic(prefix, event string) string {
	return NormalizePrefix(prefix) + "/" + EventCategory(event) + "/" + event
}

// LogTopic is <prefix>/log/<level>.
func LogTopic(prefix, level string) string {
	return NormalizePrefix(prefix) + "/log/" + level
}

// NormalizePrefix drops trailing slashes.
func NormalizePrefix(prefix string) string { return strings.TrimRight(prefix, "/") }
