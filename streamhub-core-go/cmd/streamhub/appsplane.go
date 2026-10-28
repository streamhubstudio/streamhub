package main

import (
	"context"
	"os"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/admin"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/apps"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/s3"
)

// The apps plane: s3 (+ the secrets.json store), the app registry and the
// admin controller. Seeds the default `live` app at wiring time
// (AppsService.onModuleInit).
//
// Provides: "s3" (*s3.Service, also a contracts.S3Service), "s3.secrets"
// (*s3.SecretsStore), "apps" (*apps.Service, also a contracts.AppsService).
func init() {
	registerPlane(20, "apps", func(ctx context.Context, c *core) error {
		secrets := s3.NewSecretsStore(c.cfg.DataDir, nil)
		s3svc := s3.New()
		appsSvc := apps.New(apps.Deps{
			Config: c.cfg, Store: c.store, Global: c.global, S3: s3svc, Secrets: secrets,
			Quotas: need[*quotas.Service](c, "quotas"), Audit: need[*audit.Service](c, "audit"), Log: c.log,
		})
		appsSvc.Init(ctx)

		provide(c, "s3", s3svc)
		provide(c, "s3.secrets", secrets)
		provide(c, "apps", appsSvc)
		var _ contracts.AppsService = appsSvc
		var _ contracts.S3Service = s3svc

		c.modules = append(c.modules, appsSvc, admin.New(os.Getenv, admin.ShellRunner{}, c.log))
		return nil
	})
}
