package apps

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Register implements api.Module (apps.controller.ts: /apps, 22 routes).
func (s *Service) Register(a huma.API) {
	s.registerCrud(a)
	s.registerRawConfig(a)
	s.registerPresets(a)
	s.registerBlocks(a)
}

func op(id, method, path, summary, resource, action string, status int) huma.Operation {
	o := authz.Require(api.Bearer(&huma.Operation{
		OperationID: "AppsController_" + id, Method: method, Path: api.Prefix + "/apps" + path,
		Summary: summary, Tags: []string{"apps"},
	}), resource, action)
	o.DefaultStatus = status
	return *o
}

type nameInput struct {
	Name string `path:"name"`
}

type nameBodyInput struct {
	Name string `path:"name"`
	api.RawBodyInput
}

type tsInput struct {
	Name string `path:"name"`
	TS   string `path:"ts"`
}

type presetInput struct {
	Name   string `path:"name"`
	Preset string `path:"preset"`
}

// auditChange appends a config/lifecycle change to the audit trail.
func (s *Service) auditChange(ctx context.Context, action, app string, meta any) {
	s.audit.RecordCtx(ctx, audit.Event{Action: action, TargetType: audit.Str("app"), TargetID: audit.Str(app), Meta: meta})
}

type yamlText struct {
	YAML string `json:"yaml"`
}

func (s *Service) registerCrud(a huma.API) {
	huma.Register(a, op("list", http.MethodGet, "", "List apps visible to the caller (own tenant; superadmin/global sees all).", "app", "read", 200),
		func(ctx context.Context, _ *struct{}) (*api.Out[[]contracts.AppRecord], error) {
			list, err := s.List(ctx, auth.From(ctx))
			if err != nil {
				return nil, err
			}
			return api.JSON(list), nil
		})

	type tenantMeta struct {
		TenantID string `json:"tenantId"`
	}
	huma.Register(a, op("create", http.MethodPost, "", "Create an app: scaffolds dirs/config.yaml/vods.db + sample pages.", "app", "create", 201),
		func(ctx context.Context, in *api.RawBodyInput) (*api.Out[*contracts.AppRecord], error) {
			dto, err := parseCreateApp(in.RawBody)
			if err != nil {
				return nil, err
			}
			p := auth.From(ctx)
			if err := s.quotas.EnforceCreateApp(ctx, p); err != nil {
				return nil, err
			}
			tenant := auth.PlatformTenantID
			if p != nil && !p.IsSuperadmin && p.Scope != auth.ScopeGlobal && p.TenantID != "" {
				tenant = p.TenantID
			}
			rec, err := s.Create(ctx, contracts.CreateAppInput{
				Name: dto.Name, DisplayName: dto.DisplayName, RoomPrefix: dto.RoomPrefix, TenantID: tenant,
			})
			if err != nil {
				return nil, err
			}
			s.auditChange(ctx, "app.create", dto.Name, tenantMeta{tenant})
			return api.JSON(rec), nil
		})

	huma.Register(a, op("get", http.MethodGet, "/{name}", "Get one app by name.", "app", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[*contracts.AppRecord], error) {
			rec, err := s.mustGet(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.JSON(rec), nil
		})

	huma.Register(a, op("getSizes", http.MethodGet, "/{name}/sizes", "This app's storage footprint: app.db size + total VOD bytes.", "app", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[db.AppSizes]], error) {
			if _, err := s.mustGet(ctx, in.Name); err != nil {
				return nil, err
			}
			return api.OK(s.store.AppSizes(ctx, in.Name)), nil
		})

	type patchMeta struct {
		Via    string   `json:"via"`
		Fields []string `json:"fields"`
	}
	huma.Register(a, op("patch", http.MethodPatch, "/{name}", "Edit an app's config.yaml; returns the merged resolved config.", "config", "write", 200),
		func(ctx context.Context, in *nameBodyInput) (*api.Out[*contracts.AppConfig], error) {
			cp, err := parseUpdateAppConfig(in.RawBody)
			if err != nil {
				return nil, err
			}
			merged, err := s.UpdateConfig(ctx, in.Name, cp.patch)
			if err != nil {
				return nil, err
			}
			fields := cp.fields
			if fields == nil {
				fields = []string{}
			}
			s.auditChange(ctx, "config.update", in.Name, patchMeta{"PATCH /apps/:name", fields})
			// The resolved MQTT password is never returned in clear.
			if merged.Mqtt.Password != "" {
				merged.Mqtt.Password = "****"
			}
			return api.JSON(merged), nil
		})

	type deleteInput struct {
		Name string `path:"name"`
	}
	type deleted struct {
		Deleted bool   `json:"deleted"`
		Name    string `json:"name"`
	}
	type deleteMeta struct {
		DeleteVods bool `json:"deleteVods"`
	}
	huma.Register(a, op("remove", http.MethodDelete, "/{name}", "Delete an app. Optionally purge its VODs/local files.", "app", "delete", 200),
		func(ctx context.Context, in *deleteInput) (*api.Out[deleted], error) {
			deleteVods := boolQuery(api.Request(ctx), "deleteVods")
			if err := s.Delete(ctx, in.Name, contracts.DeleteAppOptions{DeleteVods: deleteVods}); err != nil {
				return nil, err
			}
			s.auditChange(ctx, "app.delete", in.Name, deleteMeta{deleteVods})
			return api.JSON(deleted{true, in.Name}), nil
		})
}

// boolQuery is what a `boolean` @Query param resolves to: the global
// ValidationPipe (transform) maps it to `value === 'true'` before
// ParseBoolPipe sees it, so anything but a single "true" — absent, "yes",
// a repeated key — is false and the pipe never answers 400.
func boolQuery(r *http.Request, key string) bool {
	vals := r.URL.Query()[key]
	return len(vals) == 1 && vals[0] == "true"
}

func (s *Service) registerRawConfig(a huma.API) {
	huma.Register(a, op("getRawConfig", http.MethodGet, "/{name}/config/raw", "Raw config.yaml of the app (wave-4 §1).", "config", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[yamlText]], error) {
			raw, err := s.GetRawConfig(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(yamlText{raw}), nil
		})

	type rawMeta struct {
		Via   string `json:"via"`
		Bytes int    `json:"bytes"`
	}
	huma.Register(a, op("putRawConfig", http.MethodPut, "/{name}/config/raw",
		"Validate + backup + write config.yaml then hot-reload the app (wave-4 §1, fold-2 backup). 400 on parse error (no write).", "config", "write", 200),
		func(ctx context.Context, in *nameBodyInput) (*api.Out[api.Envelope[*ReloadResult]], error) {
			text, err := parseRawConfig(in.RawBody)
			if err != nil {
				return nil, err
			}
			res, err := s.PutRawConfig(ctx, in.Name, text)
			if err != nil {
				return nil, err
			}
			// Size only — raw YAML may embed secrets.
			s.auditChange(ctx, "config.update", in.Name, rawMeta{"PUT /apps/:name/config/raw", jsx.UTF16Len(text)})
			return api.OK(res), nil
		})

	huma.Register(a, op("validateRawConfig", http.MethodPost, "/{name}/config/raw/validate",
		"Fold-2 dry-run: validate proposed config.yaml + return the diff vs current, WITHOUT writing.", "config", "read", 201),
		func(ctx context.Context, in *nameBodyInput) (*api.Out[api.Envelope[*ConfigDryRun]], error) {
			text, err := parseRawConfig(in.RawBody)
			if err != nil {
				return nil, err
			}
			res, err := s.DryRunRawConfig(ctx, in.Name, text)
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})

	huma.Register(a, op("listConfigBackups", http.MethodGet, "/{name}/config/backups", "Fold-2: list timestamped config backups (newest first).", "config", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[[]ConfigBackup]], error) {
			list, err := s.ListConfigBackups(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, op("getConfigBackup", http.MethodGet, "/{name}/config/backups/{ts}", "Fold-2: read one backup's verbatim config.yaml (for preview/diff).", "config", "read", 200),
		func(ctx context.Context, in *tsInput) (*api.Out[api.Envelope[yamlText]], error) {
			raw, err := s.ReadConfigBackup(ctx, in.Name, in.TS)
			if err != nil {
				return nil, err
			}
			return api.OK(yamlText{raw}), nil
		})

	type revertMeta struct {
		Backup string `json:"backup"`
	}
	huma.Register(a, op("revertConfigBackup", http.MethodPost, "/{name}/config/backups/{ts}/revert",
		"Fold-2: restore a backup as the live config.yaml + hot-reload (current is backed up first).", "config", "write", 201),
		func(ctx context.Context, in *tsInput) (*api.Out[api.Envelope[*ReloadResult]], error) {
			res, err := s.RevertConfigBackup(ctx, in.Name, in.TS)
			if err != nil {
				return nil, err
			}
			s.auditChange(ctx, "config.revert", in.Name, revertMeta{in.TS})
			return api.OK(res), nil
		})

	huma.Register(a, op("reload", http.MethodPost, "/{name}/reload",
		"Hot-reload an app: re-read config + re-init its S3 client, without restarting the process (wave-4 §1).", "config", "write", 201),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[*ReloadResult]], error) {
			res, err := s.Reload(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
}

func (s *Service) registerPresets(a huma.API) {
	huma.Register(a, op("listPresets", http.MethodGet, "/{name}/presets",
		"List the built-in config presets (low-latency / high-quality-recording / mass-audience-HLS / rtmp-passthrough), each flagged `applied` when its keys currently match the app config.", "config", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[[]ConfigPresetInfo]], error) {
			list, err := s.ListConfigPresets(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	type presetMeta struct {
		Preset string `json:"preset"`
	}
	huma.Register(a, op("applyPreset", http.MethodPost, "/{name}/presets/{preset}/apply",
		"Apply a config preset to the app's config.yaml (deep-merge + backup + hot-reload). Never overwrites S3 credentials/secrets. Returns the diff.", "config", "write", 201),
		func(ctx context.Context, in *presetInput) (*api.Out[api.Envelope[*ApplyPresetResult]], error) {
			res, err := s.ApplyConfigPreset(ctx, in.Name, in.Preset)
			if err != nil {
				return nil, err
			}
			s.auditChange(ctx, "config.preset_apply", in.Name, presetMeta{in.Preset})
			return api.OK(res), nil
		})

	huma.Register(a, op("deactivatePreset", http.MethodPost, "/{name}/presets/{preset}/deactivate",
		"Deactivate a config preset: reverts every key it sets to the app's factory default (backup + hot-reload). Keys with no factory default (distribution/hls) are removed. Never touches S3 credentials/secrets.", "config", "write", 201),
		func(ctx context.Context, in *presetInput) (*api.Out[api.Envelope[*ApplyPresetResult]], error) {
			res, err := s.DeactivateConfigPreset(ctx, in.Name, in.Preset)
			if err != nil {
				return nil, err
			}
			s.auditChange(ctx, "config.preset_deactivate", in.Name, presetMeta{in.Preset})
			return api.OK(res), nil
		})
}

func (s *Service) registerBlocks(a huma.API) {
	huma.Register(a, op("getS3", http.MethodGet, "/{name}/s3", "Get the app S3 config (credentials masked) (wave-4 §2).", "s3", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[*AppMaskedS3]], error) {
			v, err := s.GetS3(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	type s3Meta struct {
		Bucket   *string `json:"bucket,omitempty"`
		Endpoint *string `json:"endpoint"`
	}
	huma.Register(a, op("setS3", http.MethodPut, "/{name}/s3",
		"Set the app S3 block in config.yaml + key/secret in secrets.json, then re-init the S3 client (wave-4 §2). Fold-3: enabling public_url needs confirmPublic=true.", "s3", "write", 200),
		func(ctx context.Context, in *nameBodyInput) (*api.Out[api.Envelope[*AppMaskedS3]], error) {
			dto, err := parseSetS3(in.RawBody)
			if err != nil {
				return nil, err
			}
			v, err := s.SetS3(ctx, in.Name, dto.in)
			if err != nil {
				return nil, err
			}
			s.auditChange(ctx, "s3.update", in.Name, s3Meta{dto.bucket, dto.endpoint})
			return api.OK(v), nil
		})

	huma.Register(a, op("getMqtt", http.MethodGet, "/{name}/mqtt", "Get the app MQTT config (broker password masked).", "config", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[*AppMaskedMqtt]], error) {
			v, err := s.GetMqtt(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	type mqttMeta struct {
		URL *string `json:"url"`
	}
	huma.Register(a, op("setMqtt", http.MethodPut, "/{name}/mqtt",
		"Set the app MQTT block in config.yaml + broker password in secrets.json, then reconnect the MQTT client. Omit password to keep the stored one.", "config", "write", 200),
		func(ctx context.Context, in *nameBodyInput) (*api.Out[api.Envelope[*AppMaskedMqtt]], error) {
			dto, err := parseSetMqtt(in.RawBody)
			if err != nil {
				return nil, err
			}
			v, err := s.SetMqtt(ctx, in.Name, *dto)
			if err != nil {
				return nil, err
			}
			s.auditChange(ctx, "mqtt.update", in.Name, mqttMeta{dto.URL})
			return api.OK(v), nil
		})

	huma.Register(a, op("getSmtp", http.MethodGet, "/{name}/smtp", "Get the app SMTP config (password masked).", "config", "read", 200),
		func(ctx context.Context, in *nameInput) (*api.Out[api.Envelope[*AppMaskedSmtp]], error) {
			v, err := s.GetSmtp(ctx, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	type smtpMeta struct {
		Host    *string `json:"host"`
		Enabled *bool   `json:"enabled"`
	}
	huma.Register(a, op("setSmtp", http.MethodPut, "/{name}/smtp",
		"Set the app SMTP block in config.yaml + password in secrets.json. Omit pass to keep the stored one.", "config", "write", 200),
		func(ctx context.Context, in *nameBodyInput) (*api.Out[api.Envelope[*AppMaskedSmtp]], error) {
			dto, err := parseSetSmtp(in.RawBody)
			if err != nil {
				return nil, err
			}
			v, err := s.SetSmtp(ctx, in.Name, *dto)
			if err != nil {
				return nil, err
			}
			s.auditChange(ctx, "smtp.update", in.Name, smtpMeta{dto.Host, dto.Enabled})
			return api.OK(v), nil
		})
}
