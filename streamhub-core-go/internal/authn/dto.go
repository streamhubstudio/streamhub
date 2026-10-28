package authn

import (
	"regexp"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// Request DTOs of the auth module (dto/*.ts). Rules are listed in the order
// class-validator reports them (decorators bottom-up); the validate package
// tests lock every message against Node-generated vectors.

var codeRe = regexp.MustCompile(`^\s*\d{6}\s*$`)

// DTOs maps each Node DTO class to its rules.
var DTOs = map[string]func(*validate.Body){
	"CreateTokenDto": func(b *validate.Body) {
		b.Field("name").MaxLength(100).IsString()
		b.Field("scope").IsIn("global", "app")
		b.Optional("appId").IsInt()
		b.Optional("allowedIps").EachIsString().IsArray()
	},
	"SignupDto": func(b *validate.Body) {
		b.Field("email").MaxLength(200).IsEmail()
		b.Field("password").MaxLength(200).MinLength(8).IsString()
		b.Optional("teamName").MaxLength(200).IsString()
	},
	"LoginDto": func(b *validate.Body) {
		b.Field("user").MaxLength(200).MinLength(1).IsString()
		b.Field("password").MaxLength(200).MinLength(1).IsString()
		b.Optional("code").MaxLength(10).IsString()
	},
	"MagicLinkRequestDto": func(b *validate.Body) {
		b.Field("email").MaxLength(200).IsEmail()
	},
	"MagicVerifyDto": func(b *validate.Body) {
		b.Field("token").MaxLength(512).MinLength(10).IsString()
		b.Optional("code").MaxLength(10).IsString()
	},
	"UpdateAccountDto": func(b *validate.Body) {
		b.Optional("name").MaxLength(120).IsString()
		b.Optional("email").MaxLength(200).IsEmail()
	},
	"ChangePasswordDto": func(b *validate.Body) {
		b.Field("currentPassword").MaxLength(200).IsString()
		b.Field("newPassword").MaxLength(200).MinLength(8).IsString()
	},
	"TwoFaCodeDto": func(b *validate.Body) {
		b.Field("code").Matches(codeRe, "code must be a 6-digit number").IsString()
	},
	"SetAccountSmtpDto": func(b *validate.Body) {
		b.Optional("enabled").IsBoolean()
		b.Optional("host").MaxLength(255).IsString()
		b.Optional("port").Max(65535).Min(1).IsInt()
		b.Optional("user").MaxLength(255).IsString()
		b.Optional("pass").MaxLength(512).IsString()
		b.Optional("from").MaxLength(255).IsString()
	},
	"TestSmtpDto": func(b *validate.Body) {
		b.Field("to").MaxLength(200).IsEmail()
	},
	"InviteMemberDto": func(b *validate.Body) {
		b.Field("email").MaxLength(200).IsEmail()
		b.Optional("role").IsIn("owner", "editor", "viewer")
	},
}

// body parses raw and applies the named DTO's rules.
func body(raw []byte, dto string) (*validate.Body, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	DTOs[dto](b)
	if err := b.Err(); err != nil {
		return nil, err
	}
	return b, nil
}
