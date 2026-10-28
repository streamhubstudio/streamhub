package timezone

import "testing"

// Vectors checked against Node 24 (isValidTimezone = Intl.supportedValuesOf
// ∪ new Intl.DateTimeFormat(..., { timeZone })).
func TestIsValid(t *testing.T) {
	valid := []string{"", "UTC", "utc", "Etc/UTC", "US/Eastern", "america/new_york", "+05:00", "-0330", "+05",
		"GMT", "Etc/GMT+5", "EST5EDT", "Asia/Calcutta", "America/Buenos_Aires", "CET", "Zulu", "UCT",
		"America/Argentina/ComodRivadavia", "America/Argentina/Buenos_Aires", "Europe/Madrid"}
	invalid := []string{"Local", "GMT+5", "Factory", "posixrules", "Not/AZone", "GMT+25", "+24:00", "+05:60", "Mars/Olympus_Mons", " UTC"}
	for _, tz := range valid {
		if !IsValid(tz) {
			t.Errorf("%q should be valid", tz)
		}
	}
	for _, tz := range invalid {
		if IsValid(tz) {
			t.Errorf("%q should be invalid", tz)
		}
	}
	if l := List(); len(l) < 400 || l[0] > l[1] {
		t.Errorf("list = %d entries", len(l))
	}
}
