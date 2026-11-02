package channel

import (
	"errors"
	"net"
	"sync"
)

// PortPool hands out loopback UDP ports for the TS buses and output inputs.
type PortPool struct {
	mu       sync.Mutex
	min, max int
	used     map[int]bool
	next     int
}

// NewPortPool covers [min, max].
func NewPortPool(min, max int) *PortPool {
	return &PortPool{min: min, max: max, used: map[int]bool{}, next: min}
}

// Allocate returns a free port (verified bindable on 127.0.0.1).
func (p *PortPool) Allocate() (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := p.max - p.min + 1
	for i := 0; i < n; i++ {
		port := p.next
		p.next++
		if p.next > p.max {
			p.next = p.min
		}
		if p.used[port] {
			continue
		}
		c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
		if err != nil {
			continue
		}
		c.Close()
		p.used[port] = true
		return port, nil
	}
	return 0, errors.New("no free loopback UDP port in the configured range")
}

// Release returns a port to the pool.
func (p *PortPool) Release(port int) {
	if port == 0 {
		return
	}
	p.mu.Lock()
	delete(p.used, port)
	p.mu.Unlock()
}

// InUse is the number of allocated ports.
func (p *PortPool) InUse() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.used)
}
