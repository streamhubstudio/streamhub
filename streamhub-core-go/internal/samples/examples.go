package samples

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Port of examples.service.ts: the downloadable example catalogue + zips.

// ExampleListItem is one entry of the examples list endpoint.
type ExampleListItem struct {
	ExampleDescriptor
	DownloadURL string `json:"downloadUrl"`
}

// BuiltZip is a zip ready to send.
type BuiltZip struct {
	Filename string
	Data     []byte
}

const combinedID = "all"

var safeID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// ListExamples lists the catalogue with per-app download URLs.
func (s *Service) ListExamples(ctx context.Context, app string) ([]ExampleListItem, error) {
	ec, err := s.ExampleContextFor(ctx, app)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(ec.BaseURL, "/")
	out := make([]ExampleListItem, 0, len(ExampleBundles))
	for _, d := range ExampleBundles {
		out = append(out, ExampleListItem{d, fmt.Sprintf("%s/api/v1/apps/%s/examples/%s.zip", base, jsx.EncodeURIComponent(app), d.ID)})
	}
	return out, nil
}

// ZipOne builds the zip of one example, configured for the app.
func (s *Service) ZipOne(ctx context.Context, app, id string) (*BuiltZip, error) {
	if !safeID.MatchString(id) {
		return nil, httpx.BadRequest(fmt.Sprintf(`invalid example id "%s"`, id))
	}
	ec, err := s.ExampleContextFor(ctx, app)
	if err != nil {
		return nil, err
	}
	if GetExample(id) == nil {
		return nil, httpx.NotFound(fmt.Sprintf(`example "%s" not found`, id))
	}
	_, files, _ := BuildExampleBundle(id, ec)
	entries := make([]ZipEntry, 0, len(files))
	for _, f := range files {
		entries = append(entries, ZipEntry{f.Name, []byte(f.Data)})
	}
	return &BuiltZip{id + ".zip", CreateZip(entries)}, nil
}

// ZipAll builds the combined zip (every example under its own folder).
func (s *Service) ZipAll(ctx context.Context, app string) (*BuiltZip, error) {
	ec, err := s.ExampleContextFor(ctx, app)
	if err != nil {
		return nil, err
	}
	return &BuiltZip{"streamhub-examples.zip", zipAllFor(ec)}, nil
}

func zipAllFor(ec *ExampleContext) []byte {
	entries := []ZipEntry{{"README.md", []byte(rootReadme(ec))}}
	for _, b := range BuildAllBundles(ec) {
		for _, f := range b.Files {
			entries = append(entries, ZipEntry{b.ID + "/" + f.Name, []byte(f.Data)})
		}
	}
	return CreateZip(entries)
}

var zipSuffix = regexp.MustCompile(`(?i)\.zip$`)

// ZipByName resolves a route :name (`<id>.zip` or `all.zip`) to a zip.
func (s *Service) ZipByName(ctx context.Context, app, name string) (*BuiltZip, error) {
	id := zipSuffix.ReplaceAllString(name, "")
	if id == combinedID {
		return s.ZipAll(ctx, app)
	}
	return s.ZipOne(ctx, app, id)
}

var rootReadmeTmpl = bt(`# StreamHub examples

Self-contained, statically-hostable examples for your StreamHub app
§%[1]s§. Each folder is independent: edit its §config.js§, then host the
folder on any static host (S3, Netlify, nginx, GitHub Pages) or open
§index.html§ locally. No build step.

## Examples

%[2]s

Every §config.js§ is pre-filled with this app's public URLs
(§%[3]s§). Change §baseUrl§/§wsUrl§/§app§/§room§ to retarget.
`)

func rootReadme(ec *ExampleContext) string {
	lines := make([]string, 0, len(ExampleBundles))
	for _, d := range ExampleBundles {
		lines = append(lines, fmt.Sprintf("- **%s/** — %s: %s", d.ID, d.Title, d.Description))
	}
	return fmt.Sprintf(rootReadmeTmpl, ec.App, strings.Join(lines, "\n"), ec.BaseURL)
}
