package samples

import (
	"context"
	"net/http"
	"strconv"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// Register implements api.Module: SamplesController + ExamplesController.
func (s *Service) Register(a huma.API) {
	op := func(id, method, path, summary, tag, action string) *huma.Operation {
		return authz.Require(api.Bearer(&huma.Operation{
			OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{tag},
		}), "sample", action)
	}
	type appIn struct {
		App string `path:"app"`
	}
	type fileIn struct {
		App  string `path:"app"`
		File string `path:"file"`
	}
	type fileData struct {
		File    string `json:"file"`
		Content string `json:"content"`
	}
	type savedData struct {
		File  string `json:"file"`
		Saved bool   `json:"saved"`
	}
	type regenData struct {
		Regenerated []string `json:"regenerated"`
	}

	huma.Register(a, *op("SamplesController_list", http.MethodGet, "/apps/{app}/samples",
		"List the app sample files (+ embed URLs).", "samples", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]SampleFileInfo]], error) {
			list, err := s.List(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	regen := op("SamplesController_regenerate", http.MethodPost, "/apps/{app}/samples/regenerate",
		"Regenerate the standard sample set from templates (this app only).", "samples", "write")
	regen.DefaultStatus = http.StatusCreated
	huma.Register(a, *regen, func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[regenData]], error) {
		files, err := s.GenerateFiles(ctx, in.App)
		if err != nil {
			return nil, err
		}
		return api.OK(regenData{files}), nil
	})

	huma.Register(a, *op("SamplesController_read", http.MethodGet, "/apps/{app}/samples/{file}",
		"Raw contents of one sample file.", "samples", "read"),
		func(ctx context.Context, in *fileIn) (*api.Out[api.Envelope[fileData]], error) {
			content, err := s.Read(ctx, in.App, in.File)
			if err != nil {
				return nil, err
			}
			return api.OK(fileData{in.File, content}), nil
		})

	type writeIn struct {
		App     string `path:"app"`
		File    string `path:"file"`
		RawBody []byte
	}
	huma.Register(a, *op("SamplesController_write", http.MethodPut, "/apps/{app}/samples/{file}",
		"Overwrite one sample file (only this app is affected).", "samples", "write"),
		func(ctx context.Context, in *writeIn) (*api.Out[api.Envelope[savedData]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			WriteSampleDto(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := s.Write(ctx, in.App, in.File, b.String("content")); err != nil {
				return nil, err
			}
			return api.OK(savedData{in.File, true}), nil
		})

	huma.Register(a, *op("ExamplesController_list", http.MethodGet, "/apps/{app}/examples",
		"List the downloadable example bundles (+ per-app download URLs).", "examples", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]ExampleListItem]], error) {
			list, err := s.ListExamples(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	type nameIn struct {
		App  string `path:"app"`
		Name string `path:"name"`
	}
	type zipOut struct {
		ContentType        string `header:"Content-Type"`
		ContentDisposition string `header:"Content-Disposition"`
		ContentLength      string `header:"Content-Length"`
		CacheControl       string `header:"Cache-Control"`
		Body               []byte
	}
	dl := op("ExamplesController_download", http.MethodGet, "/apps/{app}/examples/{name}",
		"Download one example bundle as a zip (or `all.zip` for the combined archive), pre-configured for this app.",
		"examples", "read")
	huma.Register(a, *dl, func(ctx context.Context, in *nameIn) (*zipOut, error) {
		z, err := s.ZipByName(ctx, in.App, in.Name)
		if err != nil {
			return nil, err
		}
		return &zipOut{
			ContentType: "application/zip", ContentDisposition: `attachment; filename="` + z.Filename + `"`,
			ContentLength: strconv.Itoa(len(z.Data)), CacheControl: "no-store", Body: z.Data,
		}, nil
	})
}

// WriteSampleDto is @IsString() @MaxLength(500_000) content (rules run
// bottom-up, as class-validator reports them).
func WriteSampleDto(b *validate.Body) {
	b.Field("content").MaxLength(500000).IsString()
}
