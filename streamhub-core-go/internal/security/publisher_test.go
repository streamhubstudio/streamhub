package security

import "testing"

func TestPublisherAllowed(t *testing.T) {
	list := []string{"203.0.113.0/24", "198.51.100.7", "2001:db8::/32"}
	for _, c := range []struct {
		cidrs []string
		ip    string
		want  bool
	}{
		{nil, "8.8.8.8", true}, // off: everyone publishes
		{[]string{}, "", true},
		{list, "203.0.113.200", true},
		{list, "::ffff:203.0.113.9", true}, // v4-mapped folds to v4
		{list, "198.51.100.7", true},       // bare IP = /32
		{list, "198.51.100.8", false},
		{list, "2001:db8:1::5", true},
		{list, "8.8.8.8", false},
		{list, "", false},                                  // unknown source: fail closed
		{list, "not-an-ip", false},                         // garbage source: fail closed
		{[]string{"203.0.113.0/33"}, "203.0.113.1", false}, // invalid entry matches nothing
		{[]string{"bogus", "10.0.0.0/8"}, "10.1.2.3", true},
		{[]string{"0.0.0.0/0"}, "8.8.8.8", true},
	} {
		if got := PublisherAllowed(c.cidrs, c.ip); got != c.want {
			t.Fatalf("PublisherAllowed(%v, %q) = %v, want %v", c.cidrs, c.ip, got, c.want)
		}
	}
}
