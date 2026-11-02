package apps

import (
	"context"
	"fmt"
	"strings"

	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// The idempotent boot pass of security 3.3.3 (C3): every config.yaml whose
// *_env names something other than the derived ref is rewritten (after a
// config.yaml.bak.<ts> backup) to SecretRef. A ref the pre-3.3.3 scaffold
// wrote for that very app (legacySecretRef — it differs from the derived one
// only for names with hyphen runs) carries its secrets.json value over and,
// when no registered app derives it, is removed so a later app never
// inherits it. A foreign ref is dropped with a warning; its value is never
// copied. A second run finds every yaml derived and does nothing.

type refMigration struct {
	app     string
	tree    *y.Map
	dropped []string
}

// MigrateSecretRefs runs the pass (Init calls it; never fails boot).
func (s *Service) MigrateSecretRefs(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.List(ctx, nil)
	if err != nil {
		s.log.Error("secret-ref migration skipped: " + err.Error())
		return
	}
	owned := map[string]bool{}
	for _, a := range list {
		for _, f := range secretFields {
			owned[SecretRef(a.Name, f.kind)] = true
		}
	}
	stored := s.secrets.ReadFresh()
	var plans []refMigration
	var moves [][2]string
	legacy := map[string]bool{}
	for _, a := range list {
		raw, err := s.readRaw(a.Name)
		if err != nil {
			continue
		}
		parsed, err := y.Load(raw)
		tree, ok := parsed.(*y.Map)
		if err != nil || !ok || tree == nil {
			continue // unparseable: the raw editor reports it; nothing to rewrite
		}
		plan := refMigration{app: a.Name, tree: tree}
		changed := false
		for _, f := range secretFields {
			b := blockAt(tree, f.path)
			if b == nil {
				continue
			}
			cur := b.Get(f.key)
			if y.IsUndefined(cur) || cur == nil {
				continue
			}
			ref, isStr := cur.(string)
			want := SecretRef(a.Name, f.kind)
			if isStr && (ref == want || y.Trim(ref) == "") {
				continue
			}
			b.Set(f.key, want)
			changed = true
			if isStr && ref == legacySecretRef(a.Name, f.kind) {
				if v := stored[ref]; v != "" && stored[want] == "" {
					moves = append(moves, [2]string{want, v})
				}
				legacy[ref] = true
				continue
			}
			plan.dropped = append(plan.dropped, f.label()+"="+y.ToString(cur))
		}
		if changed {
			plans = append(plans, plan)
		}
	}
	if len(plans) == 0 {
		return
	}
	if len(moves) > 0 {
		if err := s.secrets.SetMany(moves); err != nil {
			s.log.Error("secret-ref migration: secrets.json write failed; config.yaml left as is: " + err.Error())
			return
		}
	}
	for ref := range legacy {
		if owned[ref] {
			continue
		}
		if err := s.secrets.Remove(ref); err != nil {
			s.log.Warn(fmt.Sprintf("secret-ref migration: could not remove legacy key %s: %s", ref, err))
		}
	}
	for _, p := range plans {
		if w := s.backupCurrent(p.app); len(w) > 0 {
			s.log.Warn(fmt.Sprintf(`secret-ref migration of "%s": %s`, p.app, strings.Join(w, "; ")))
		}
		if err := s.writeConfigText(p.app, y.Dump(p.tree, configLineWidth)); err != nil {
			s.log.Error(fmt.Sprintf(`secret-ref migration of "%s" failed: %s`, p.app, err))
			continue
		}
		if len(p.dropped) > 0 {
			s.log.Warn(fmt.Sprintf(`secret-ref migration of "%s": dropped foreign refs (%s); `+
				`set those credentials again with PUT /apps/%s/{s3,mqtt,smtp}`, p.app, strings.Join(p.dropped, ", "), p.app))
		} else {
			s.log.Info(fmt.Sprintf(`secret-ref migration of "%s": legacy refs moved to the derived names`, p.app))
		}
	}
	s.secrets.Invalidate()
	s.s3.Evict(nil)
}
