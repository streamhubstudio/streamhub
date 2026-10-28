package tags

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Register implements api.Module: TagsController + StreamTagsController.
func (r *Repository) Register(a huma.API) {
	op := func(id, method, path, summary, resource, action string, status int) *huma.Operation {
		o := authz.Require(api.Bearer(&huma.Operation{
			OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"tags"},
		}), resource, action)
		if status != 0 {
			o.DefaultStatus = status
		}
		return o
	}
	type listIn struct {
		App  string `path:"app"`
		Kind string `query:"kind"`
	}
	type slugIn struct {
		App  string `path:"app"`
		Slug string `path:"slug"`
	}
	type bodyIn struct {
		App     string `path:"app"`
		RawBody []byte
	}
	type slugBodyIn struct {
		App     string `path:"app"`
		Slug    string `path:"slug"`
		RawBody []byte
	}
	type roomBodyIn struct {
		App     string `path:"app"`
		Room    string `path:"room"`
		RawBody []byte
	}
	type streamIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	type streamBodyIn struct {
		App     string `path:"app"`
		ID      string `path:"id"`
		RawBody []byte
	}

	huma.Register(a, *op("TagsController_list", http.MethodGet, "/apps/{app}/tags", "List tags", "config", "read", 0),
		func(ctx context.Context, in *listIn) (*api.Out[api.Data[[]TagRecord]], error) {
			list, err := r.List(ctx, in.App, jsTrim(in.Kind))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[[]TagRecord]{Data: list}), nil
		})

	huma.Register(a, *op("TagsController_create", http.MethodPost, "/apps/{app}/tags", "Create a tag", "config", "write", http.StatusCreated),
		func(ctx context.Context, in *bodyIn) (*api.Out[api.Data[*TagRecord]], error) {
			b, ordered, err := parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			CreateTagDto(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			tag, err := r.Create(ctx, in.App, CreateInput{
				Slug: b.String("slug"), Label: b.String("label"), Kind: b.StringPtr("kind"), ConfigJSON: objectField(ordered, "config_json"),
			})
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*TagRecord]{Data: tag}), nil
		})

	huma.Register(a, *op("TagsController_setRoomTags", http.MethodPatch, "/apps/{app}/tags/room/{room}", "Apply tags to a room's streams", "stream", "write", 0),
		func(ctx context.Context, in *roomBodyIn) (*api.Out[api.Data[*RoomTagsState]], error) {
			b, _, err := parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			ApplyTagsDto(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			st, err := r.SetRoomTags(ctx, in.App, in.Room, rawArray(b, "tags"))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*RoomTagsState]{Data: st}), nil
		})

	huma.Register(a, *op("TagsController_get", http.MethodGet, "/apps/{app}/tags/{slug}", "Get a tag", "config", "read", 0),
		func(ctx context.Context, in *slugIn) (*api.Out[api.Data[*TagRecord]], error) {
			tag, err := r.Get(ctx, in.App, in.Slug)
			if err != nil {
				return nil, err
			}
			if tag == nil {
				return nil, httpx.NotFound("tag '" + in.Slug + "' not found")
			}
			return api.JSON(api.Data[*TagRecord]{Data: tag}), nil
		})

	huma.Register(a, *op("TagsController_update", http.MethodPatch, "/apps/{app}/tags/{slug}", "Update a tag", "config", "write", 0),
		func(ctx context.Context, in *slugBodyIn) (*api.Out[api.Data[*TagRecord]], error) {
			b, ordered, err := parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			UpdateTagDto(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			tag, err := r.Update(ctx, in.App, in.Slug, UpdateInput{
				Label: b.StringPtr("label"), Kind: b.StringPtr("kind"), ConfigJSON: objectField(ordered, "config_json"),
			})
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*TagRecord]{Data: tag}), nil
		})

	huma.Register(a, *op("TagsController_remove", http.MethodDelete, "/apps/{app}/tags/{slug}", "Delete a tag", "config", "write", http.StatusNoContent),
		func(ctx context.Context, in *slugIn) (*struct{}, error) {
			return nil, r.Remove(ctx, in.App, in.Slug)
		})

	huma.Register(a, *op("StreamTagsController_getStreamTags", http.MethodGet, "/apps/{app}/streams/{id}/tags", "Get a stream's applied tags", "stream", "read", 0),
		func(ctx context.Context, in *streamIn) (*api.Out[api.Data[*StreamTagsState]], error) {
			st, err := r.GetStreamTags(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*StreamTagsState]{Data: st}), nil
		})

	huma.Register(a, *op("StreamTagsController_setStreamTags", http.MethodPatch, "/apps/{app}/streams/{id}/tags", "Set a stream's applied tags", "stream", "write", 0),
		func(ctx context.Context, in *streamBodyIn) (*api.Out[api.Data[*StreamTagsState]], error) {
			b, _, err := parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			ApplyTagsDto(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			st, err := r.SetStreamTags(ctx, in.App, in.ID, rawArray(b, "tags"))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*StreamTagsState]{Data: st}), nil
		})
}

// parse decodes the body twice: for validation (validate.Body) and in JS key
// order (config_json must round-trip with its original property order).
func parse(raw []byte) (*validate.Body, *y.Map, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, nil, err
	}
	var ordered *y.Map
	if v, err := y.ParseJSON(raw); err == nil {
		ordered, _ = v.(*y.Map)
	}
	return b, ordered, nil
}

// objectField is body[name] when it is a plain object (validated by IsObject).
func objectField(m *y.Map, name string) *y.Map {
	if m == nil {
		return nil
	}
	v, _ := m.Get(name).(*y.Map)
	return v
}

func rawArray(b *validate.Body, name string) []any {
	arr, _ := b.Raw(name).([]any)
	return arr
}

// CreateTagDto: slug @IsString @MinLength(1) @MaxLength(64) @Matches(kebab);
// label @IsString @MinLength(1) @MaxLength(200); kind? @IsString
// @MaxLength(64); config_json? @IsObject. Rules run bottom-up.
func CreateTagDto(b *validate.Body) {
	b.Field("slug").Matches(SlugRE, "slug must be kebab-case (lowercase a-z, 0-9, hyphen-separated)").MaxLength(64).MinLength(1).IsString()
	b.Field("label").MaxLength(200).MinLength(1).IsString()
	b.Optional("kind").MaxLength(64).IsString()
	b.Optional("config_json").IsObject()
}

// UpdateTagDto: every field optional (slug immutable).
func UpdateTagDto(b *validate.Body) {
	b.Optional("label").MaxLength(200).MinLength(1).IsString()
	b.Optional("kind").MaxLength(64).IsString()
	b.Optional("config_json").IsObject()
}

// ApplyTagsDto: tags @IsArray @IsString({each}) @ArrayUnique.
func ApplyTagsDto(b *validate.Body) {
	r := b.Field("tags")
	r.Check(ArrayUnique(b.Raw("tags")), "All tags's elements must be unique")
	r.EachIsString().IsArray()
}

// ArrayUnique is class-validator arrayUnique: an array whose elements are
// pairwise distinct under ===/indexOf (objects/arrays are never equal); a
// non-array fails.
func ArrayUnique(v any) bool {
	arr, ok := v.([]any)
	if !ok {
		return false
	}
	for i := range arr {
		for j := 0; j < i; j++ {
			if strictEqual(arr[i], arr[j]) {
				return false
			}
		}
	}
	return true
}

func strictEqual(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case string:
		s, ok := b.(string)
		return ok && s == x
	case float64:
		f, ok := b.(float64)
		return ok && f == x
	case bool:
		v, ok := b.(bool)
		return ok && v == x
	}
	return false
}
