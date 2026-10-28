package authn

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// ../platform/validate/testdata/class_validator.json is produced by running
// the real ValidationPipe({transform, whitelist}) over the compiled DTOs.
// Historical generator — needs the retired NestJS core (branch legacy/node-2.x,
// tag 2.24.0); run from its streamhub-core/, dist built (`node - < gen.js`):
//
//	require('reflect-metadata');
//	const { ValidationPipe } = require('@nestjs/common');
//	const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
//	const D = (p, n) => require('./dist/' + p)[n];
//	// dtos = { LoginDto: D('modules/auth/dto/login.dto','LoginDto'), …, CreateIpRuleDto, UpdateQuotasDto, TestSmtpDto }
//	// cases = { LoginDto: [{}, {user:'a',password:'b'}, …], … }  (valid + invalid bodies per DTO)
//	for (const [name, list] of Object.entries(cases)) for (const body of list) {
//	  try { out.dtos[name].push({ body, ok: true, value: await pipe.transform(body, { type: 'body', metatype: dtos[name] }) }); }
//	  catch (e) { out.dtos[name].push({ body, ok: false, messages: e.getResponse().message }); }
//	}
//	for (const e of emails) out.isEmail[e] = require('class-validator').isEmail(e);
type dtoVectors struct {
	DTOs map[string][]struct {
		Body     json.RawMessage `json:"body"`
		OK       bool            `json:"ok"`
		Messages []string        `json:"messages"`
	} `json:"dtos"`
	IsEmail map[string]bool `json:"isEmail"`
}

func TestDTOValidationMatchesClassValidator(t *testing.T) {
	raw, err := os.ReadFile("../platform/validate/testdata/class_validator.json")
	if err != nil {
		t.Fatal(err)
	}
	var v dtoVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	rules := map[string]func(*validate.Body){
		"CreateIpRuleDto": security.ValidateCreateIPRule,
		"UpdateQuotasDto": func(b *validate.Body) { _, _ = quotas.ParseUpdate(b) },
	}
	for k, f := range DTOs {
		rules[k] = f
	}
	for name, cases := range v.DTOs {
		apply, ok := rules[name]
		if !ok {
			t.Fatalf("no Go rules for %s", name)
		}
		for i, c := range cases {
			b, err := validate.Parse(c.Body)
			if err != nil {
				t.Fatalf("%s[%d]: parse: %v", name, i, err)
			}
			apply(b)
			got := b.Messages()
			if c.OK && len(got) != 0 {
				t.Errorf("%s[%d] %s: want valid, got %q", name, i, c.Body, got)
			}
			if !c.OK && !reflect.DeepEqual(got, c.Messages) {
				t.Errorf("%s[%d] %s:\n got %q\nwant %q", name, i, c.Body, got, c.Messages)
			}
		}
	}
	for email, want := range v.IsEmail {
		if got := validate.IsEmail(email); got != want {
			t.Errorf("IsEmail(%q) = %v, want %v", email, got, want)
		}
	}
}
