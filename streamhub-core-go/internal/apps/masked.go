package apps

import (
	"context"
	"math"
	"unicode/utf16"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// The S3 / MQTT / SMTP blocks: non-secret fields in config.yaml, the secret
// in data/secrets.json, and a masked view on read (credentials are never
// returned in clear).

// publicVodsWarning is shown whenever public_url is enabled (fold-3).
const publicVodsWarning = "VODs públicos: con public_url activo las grabaciones quedan accesibles " +
	"sin firma. Preferí una URL firmada de CDN sobre un bucket abierto."

// AppMaskedS3 is the S3 block with credentials masked.
type AppMaskedS3 struct {
	Provider       string  `json:"provider"`
	Bucket         string  `json:"bucket"`
	Region         string  `json:"region"`
	Endpoint       string  `json:"endpoint"`
	ForcePathStyle bool    `json:"forcePathStyle"`
	Prefix         string  `json:"prefix"`
	PublicURL      string  `json:"public_url"`
	AccessKeyEnv   string  `json:"accessKeyEnv"`
	SecretKeyEnv   string  `json:"secretKeyEnv"`
	Key            string  `json:"key"`
	Secret         string  `json:"secret"`
	Configured     bool    `json:"configured"`
	KeyMasked      string  `json:"keyMasked"`
	SecretMasked   string  `json:"secretMasked"`
	HasKey         bool    `json:"hasKey"`
	HasSecret      bool    `json:"hasSecret"`
	PublicVods     bool    `json:"publicVods"`
	PublicWarning  *string `json:"publicWarning"`
}

// SetS3Input is PUT /apps/:app/s3 (nil = leave untouched).
type SetS3Input struct {
	Provider       *string
	Bucket         *string
	Region         *string
	Endpoint       *string
	ForcePathStyle *bool
	Prefix         *string
	PublicURL      *string
	Key            string
	Secret         string
	ConfirmPublic  bool
}

// AppMaskedMqtt is the MQTT block with the broker password masked.
type AppMaskedMqtt struct {
	Enabled      bool                         `json:"enabled"`
	URL          string                       `json:"url"`
	Username     string                       `json:"username"`
	TopicPrefix  string                       `json:"topicPrefix"`
	Qos          int                          `json:"qos"`
	TLS          bool                         `json:"tls"`
	Events       []string                     `json:"events"`
	Logs         contracts.MqttLogsConfig     `json:"logs"`
	PasswordEnv  string                       `json:"passwordEnv"`
	Password     string                       `json:"password"`
	HasPassword  bool                         `json:"hasPassword"`
	Configured   bool                         `json:"configured"`
	LatencyAlert contracts.LatencyAlertConfig `json:"latencyAlert"`
}

// SetMqttInput is PUT /apps/:app/mqtt.
type SetMqttInput struct {
	Enabled      *bool
	URL          *string
	Username     *string
	Password     string
	TopicPrefix  *string
	Qos          *float64
	TLS          *bool
	Events       []string // nil = untouched
	Logs         *contracts.MqttLogsPatch
	LatencyAlert *contracts.LatencyAlertPatch
}

// AppMaskedSmtp is the SMTP block with the password masked.
type AppMaskedSmtp struct {
	Enabled    bool    `json:"enabled"`
	Host       string  `json:"host"`
	Port       float64 `json:"port"`
	User       string  `json:"user"`
	From       string  `json:"from"`
	PassEnv    string  `json:"passEnv"`
	Pass       string  `json:"pass"`
	HasPass    bool    `json:"hasPass"`
	Configured bool    `json:"configured"`
}

// SetSmtpInput is PUT /apps/:app/smtp.
type SetSmtpInput struct {
	Enabled *bool
	Host    *string
	Port    *float64
	User    *string
	From    *string
	Pass    string
}

// mask keeps the first and last 2 UTF-16 units of a secret.
func mask(v string) string {
	if v == "" {
		return ""
	}
	u := utf16.Encode([]rune(v))
	if len(u) <= 4 {
		return "****"
	}
	return string(utf16.Decode(u[:2])) + "***" + string(utf16.Decode(u[len(u)-2:]))
}

// --- S3 -------------------------------------------------------------------

// GetS3 is the masked S3 block.
func (s *Service) GetS3(ctx context.Context, name string) (*AppMaskedS3, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	return s.maskedS3(disk), nil
}

// SetS3 writes the S3 block to config.yaml and key/secret to secrets.json,
// then re-inits the S3 clients. Enabling public_url needs ConfirmPublic.
func (s *Service) SetS3(ctx context.Context, name string, in SetS3Input) (*AppMaskedS3, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	b := sub(disk, "s3")
	setStr(b, "provider", in.Provider)
	setStr(b, "bucket", in.Bucket)
	setStr(b, "region", in.Region)
	if in.Endpoint != nil {
		b.Set("endpoint", *in.Endpoint)
	} else if in.Provider != nil && *in.Provider == "aws" {
		// aws without an explicit endpoint clears the scaffold's Wasabi one.
		b.Set("endpoint", "")
	}
	setBool(b, "force_path_style", in.ForcePathStyle)
	setStr(b, "prefix", in.Prefix)
	if in.PublicURL != nil {
		next := trimTrailingSlashes(*in.PublicURL)
		if next != "" && !y.Truthy(b.Get("public_url")) && !in.ConfirmPublic {
			return nil, httpx.BadRequest("enabling public_url makes recordings publicly accessible; " +
				"resend with confirmPublic=true to proceed")
		}
		b.Set("public_url", next)
	}
	if err := s.writeDisk(name, disk); err != nil {
		return nil, err
	}
	s.storeSecret(b.Get("access_key_env"), in.Key)
	s.storeSecret(b.Get("secret_key_env"), in.Secret)
	s.secrets.Invalidate()
	s.s3.Evict(nil)
	return s.maskedS3(disk), nil
}

// storeSecret is the setters' writeSecret + secrets.set pair (no-op for an
// empty value).
func (s *Service) storeSecret(ref any, value string) {
	if value == "" {
		return
	}
	s.writeSecret(ref, value)
	s.secrets.Invalidate()
	if err := s.secrets.Set(y.ToString(ref), value); err != nil {
		s.log.Error("secrets store failed: " + err.Error())
	}
}

func (s *Service) maskedS3(disk *y.Map) *AppMaskedS3 {
	b := disk.Get("s3")
	key := s.resolveSecret(prop(b, "access_key_env"))
	secret := s.resolveSecret(prop(b, "secret_key_env"))
	publicVods := y.Truthy(prop(b, "public_url")) && len(str(prop(b, "public_url"))) > 0
	out := &AppMaskedS3{
		Provider:       str(prop(b, "provider")),
		Bucket:         str(prop(b, "bucket")),
		Region:         str(prop(b, "region")),
		Endpoint:       str(prop(b, "endpoint")),
		ForcePathStyle: boolOf(prop(b, "force_path_style")),
		Prefix:         str(prop(b, "prefix")),
		PublicURL:      orEmpty(prop(b, "public_url")),
		AccessKeyEnv:   str(prop(b, "access_key_env")),
		SecretKeyEnv:   str(prop(b, "secret_key_env")),
		Key:            mask(key),
		Secret:         mask(secret),
		Configured:     key != "" && secret != "",
		KeyMasked:      mask(key),
		SecretMasked:   mask(secret),
		HasKey:         key != "",
		HasSecret:      secret != "",
		PublicVods:     publicVods,
	}
	if publicVods {
		w := publicVodsWarning
		out.PublicWarning = &w
	}
	return out
}

// --- MQTT -------------------------------------------------------------------

// GetMqtt is the masked MQTT block (+ latency alert).
func (s *Service) GetMqtt(ctx context.Context, name string) (*AppMaskedMqtt, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	return s.maskedMqtt(disk), nil
}

// SetMqtt writes the mqtt + latency_alert blocks and the broker password,
// then drops the app's live MQTT client.
func (s *Service) SetMqtt(ctx context.Context, name string, in SetMqttInput) (*AppMaskedMqtt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	m := sub(disk, "mqtt")
	setBool(m, "enabled", in.Enabled)
	if in.URL != nil {
		m.Set("url", y.Trim(*in.URL))
	}
	setStr(m, "username", in.Username)
	if in.TopicPrefix != nil {
		m.Set("topic_prefix", y.Trim(*in.TopicPrefix))
	}
	if in.Qos != nil {
		q := 0.0
		if *in.Qos == 1 || *in.Qos == 2 {
			q = *in.Qos
		}
		m.Set("qos", q)
	}
	setBool(m, "tls", in.TLS)
	if in.Events != nil {
		events := []any{}
		for _, e := range in.Events {
			if t := y.Trim(e); t != "" {
				events = append(events, t)
			}
		}
		if len(events) == 0 {
			events = []any{"all"}
		}
		m.Set("events", events)
	}
	if in.Logs != nil {
		logs := sub(m, "logs")
		setBool(logs, "enabled", in.Logs.Enabled)
		if in.Logs.Level != nil {
			level := "info"
			if mqttLogLevels[*in.Logs.Level] {
				level = *in.Logs.Level
			}
			logs.Set("level", level)
		}
	}
	if la := in.LatencyAlert; la != nil {
		b := sub(disk, "latency_alert")
		setBool(b, "enabled", la.Enabled)
		setNum(b, "threshold_ms", la.ThresholdMs)
		setNum(b, "cooldown_seconds", la.CooldownSeconds)
		setNum(b, "interval_seconds", la.IntervalSeconds)
	}
	if err := s.writeDisk(name, disk); err != nil {
		return nil, err
	}
	s.storeSecret(m.Get("password_env"), in.Password)
	s.secrets.Invalidate()
	s.disconnectMqtt(name)
	return s.maskedMqtt(disk), nil
}

func (s *Service) maskedMqtt(disk *y.Map) *AppMaskedMqtt {
	r := s.resolveMqtt(disk)
	return &AppMaskedMqtt{
		Enabled: r.Enabled, URL: r.URL, Username: r.Username, TopicPrefix: r.TopicPrefix,
		Qos: r.Qos, TLS: r.TLS, Events: r.Events, Logs: r.Logs,
		PasswordEnv:  str(prop(disk.Get("mqtt"), "password_env")),
		Password:     mask(r.Password),
		HasPassword:  r.Password != "",
		Configured:   r.Enabled && r.URL != "",
		LatencyAlert: resolveLatencyAlert(disk.Get("latency_alert")),
	}
}

// --- SMTP -------------------------------------------------------------------

// GetSmtp is the masked SMTP block.
func (s *Service) GetSmtp(ctx context.Context, name string) (*AppMaskedSmtp, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	return s.maskedSmtp(disk), nil
}

// SetSmtp writes the smtp block and the password (omit Pass to keep it).
func (s *Service) SetSmtp(ctx context.Context, name string, in SetSmtpInput) (*AppMaskedSmtp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	b := sub(disk, "smtp")
	setBool(b, "enabled", in.Enabled)
	if in.Host != nil {
		b.Set("host", y.Trim(*in.Host))
	}
	if in.Port != nil {
		p := *in.Port
		if !(p == math.Trunc(p) && p > 0 && p < 65536) {
			p = 587
		}
		b.Set("port", p)
	}
	setStr(b, "user", in.User)
	if in.From != nil {
		b.Set("from", y.Trim(*in.From))
	}
	if err := s.writeDisk(name, disk); err != nil {
		return nil, err
	}
	s.storeSecret(b.Get("pass_env"), in.Pass)
	s.secrets.Invalidate()
	return s.maskedSmtp(disk), nil
}

func (s *Service) maskedSmtp(disk *y.Map) *AppMaskedSmtp {
	r := s.resolveSmtp(disk)
	return &AppMaskedSmtp{
		Enabled: r.Enabled, Host: r.Host, Port: r.Port, User: r.User, From: r.From,
		PassEnv:    str(prop(disk.Get("smtp"), "pass_env")),
		Pass:       mask(r.Pass),
		HasPass:    r.Pass != "",
		Configured: r.Enabled && r.Host != "" && r.Pass != "",
	}
}
