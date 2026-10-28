package streamflow

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/dop251/goja"
	mysqldrv "github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/crypto/ssh"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of boxes/danger-exec.ts — the code / shell / ssh / db primitives
// behind the flag-gated execution boxes (streamflow.dangerousNodes, default
// OFF). Each returns an ExecResult object in Node's key order and never
// fails the run on its own.
//
//   - runCode: a fresh goja runtime (the node:vm sandbox counterpart): no
//     require/process/host objects, eval + Function constructors removed, the
//     input frozen, a hard timeout and an output size cap. A GUARDRAIL for
//     trusted operators, not a hard boundary.
//   - runShell: os/exec with an argv array (never a shell), scrubbed env,
//     timeout and output truncation.
//   - runSSH: x/crypto/ssh, key resolved from a secret ref by the runner.
//   - runDB: pgx / go-sql-driver with PARAMETERIZED queries only, row-limited.

const truncSuffix = "...[truncated]"

// truncate is `s.length > max ? s.slice(0, max) + '...[truncated]' : s`.
func truncate(s string, max int) string {
	if jsx.UTF16Len(s) > max {
		return jsx.UTF16Slice(s, max) + truncSuffix
	}
	return s
}

func failed(msg string) *y.Map { return obj("ok", false, "error", msg) }

// ---------------------------------------------------------------------------
// code sandbox
// ---------------------------------------------------------------------------

const sandboxBootstrap = `(function(g){
  var lock = function(o){ if (o) { try { Object.defineProperty(o, 'constructor', {value: undefined, writable: false, configurable: false}); } catch (e) {} } };
  lock(Function.prototype);
  lock(Object.getPrototypeOf(function*(){}));
  lock(Object.getPrototypeOf(async function(){}));
  delete g.eval; delete g.Function;
})(this);
var output;
var console = {log: function(){}, error: function(){}, warn: function(){}};`

// RunCode runs JS source with `input` (frozen JSON copy) and returns
// {ok, output} | {ok:false, error}.
func RunCode(ctx context.Context, in CodeInput) *y.Map {
	rt := goja.New()
	if _, err := rt.RunString(sandboxBootstrap); err != nil {
		return failed(err.Error())
	}
	inJSON := jsonString(y.Coalesce(in.Input, y.NewMap()))
	if _, err := rt.RunString("Object.defineProperty(this,'input',{value:Object.freeze(JSON.parse(" +
		strconv.Quote(inJSON) + ")),writable:false,configurable:false});"); err != nil {
		return failed(jsErrMessage(rt, err))
	}
	timeout := in.Timeout
	timer := time.AfterFunc(timeout, func() {
		rt.Interrupt(fmt.Sprintf("Script execution timed out after %dms", timeout.Milliseconds()))
	})
	stop := context.AfterFunc(ctx, func() { rt.Interrupt("run aborted") })
	_, err := rt.RunString(in.Source)
	timer.Stop()
	stop()
	if err != nil {
		return failed(jsErrMessage(rt, err))
	}
	rt.ClearInterrupt()
	v, err := rt.RunString(`(function(){try{return JSON.stringify(typeof output==='undefined'?null:output)}catch(e){return null}})()`)
	if err != nil || v == nil || goja.IsNull(v) || goja.IsUndefined(v) {
		return failed("output is not JSON-serialisable")
	}
	serialized := v.String()
	if jsx.UTF16Len(serialized) > in.MaxOutputBytes {
		return failed("output too large")
	}
	out, perr := y.ParseJSON([]byte(serialized))
	if perr != nil {
		return failed("output is not JSON-serialisable")
	}
	return obj("ok", true, "output", out)
}

// jsErrMessage is err.message as V8 would print it (no "ReferenceError:" prefix).
func jsErrMessage(rt *goja.Runtime, err error) string {
	var ie *goja.InterruptedError
	if errors.As(err, &ie) {
		return fmt.Sprint(ie.Value())
	}
	var ex *goja.Exception
	if errors.As(err, &ex) {
		if o := ex.Value().ToObject(rt); o != nil {
			if m := o.Get("message"); m != nil && !goja.IsUndefined(m) {
				return m.String()
			}
		}
		return ex.Value().String()
	}
	return err.Error()
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

// capWriter buffers up to max bytes and reports overflow (execFile maxBuffer).
type capWriter struct {
	buf      bytes.Buffer
	max      int
	overflow bool
	onFull   func()
}

func (w *capWriter) Write(p []byte) (int, error) {
	if w.buf.Len()+len(p) > w.max {
		w.buf.Write(p[:max(0, w.max-w.buf.Len())])
		if !w.overflow {
			w.overflow = true
			w.onFull()
		}
		return len(p), nil
	}
	return w.buf.Write(p)
}

// RunShell runs command with an argv array (no shell interpolation).
func RunShell(ctx context.Context, in ShellInput) *y.Map {
	ctx, cancel := context.WithTimeout(ctx, in.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, in.Command, in.Args...)
	lang := os.Getenv("LANG")
	if lang == "" {
		lang = "C"
	}
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "LANG=" + lang}
	var maxErr error
	kill := func(stream string) func() {
		return func() {
			maxErr = fmt.Errorf("%s maxBuffer length exceeded", stream)
			cancel()
		}
	}
	stdout := &capWriter{max: in.MaxOutputBytes}
	stderr := &capWriter{max: in.MaxOutputBytes}
	stdout.onFull, stderr.onFull = kill("stdout"), kill("stderr")
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	out := truncate(stdout.buf.String(), in.MaxOutputBytes)
	errOut := truncate(stderr.buf.String(), in.MaxOutputBytes)
	if err == nil && maxErr == nil {
		return obj("ok", true, "code", 0.0, "stdout", out, "stderr", errOut)
	}
	var code any // null unless the process exited with a status
	msg := ""
	var ee *exec.ExitError
	switch {
	case maxErr != nil:
		msg = maxErr.Error()
	case errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist):
		msg = "spawn " + in.Command + " ENOENT"
	case errors.As(err, &ee):
		if ee.ExitCode() >= 0 && ctx.Err() == nil {
			code = float64(ee.ExitCode())
		}
		msg = "Command failed: " + strings.TrimSpace(in.Command+" "+strings.Join(in.Args, " ")) + "\n" + stderr.buf.String()
	default:
		msg = err.Error()
	}
	return obj("ok", false, "code", code, "stdout", out, "stderr", errOut, "error", msg)
}

// ---------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------

// RunSSH runs one command over SSH. Like ssh2's default, the host key is not
// verified (trusted operators only).
func RunSSH(ctx context.Context, in SSHInput) *y.Map {
	var signer ssh.Signer
	var err error
	if in.Passphrase != "" {
		signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(in.PrivateKey), []byte(in.Passphrase))
	} else {
		signer, err = ssh.ParsePrivateKey([]byte(in.PrivateKey))
	}
	if err != nil {
		return failed(err.Error())
	}
	ctx, cancel := context.WithTimeout(ctx, in.Timeout)
	defer cancel()
	type result struct{ r *y.Map }
	done := make(chan result, 1)
	go func() {
		cfg := &ssh.ClientConfig{
			User: in.User, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
			HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // ssh2 default: no host verification
			Timeout:         in.Timeout,
		}
		client, err := ssh.Dial("tcp", net.JoinHostPort(in.Host, strconv.Itoa(in.Port)), cfg)
		if err != nil {
			done <- result{failed(err.Error())}
			return
		}
		defer client.Close()
		sess, err := client.NewSession()
		if err != nil {
			done <- result{failed(err.Error())}
			return
		}
		defer sess.Close()
		var so, se bytes.Buffer
		sess.Stdout, sess.Stderr = &so, &se
		code := 0.0
		if err := sess.Run(in.Command); err != nil {
			var xe *ssh.ExitError
			if !errors.As(err, &xe) {
				done <- result{failed(err.Error())}
				return
			}
			code = float64(xe.ExitStatus())
		}
		done <- result{obj("ok", code == 0, "code", code,
			"stdout", truncate(so.String(), in.MaxOutputBytes), "stderr", truncate(se.String(), in.MaxOutputBytes))}
	}()
	select {
	case r := <-done:
		return r.r
	case <-ctx.Done():
		return failed("ssh timeout")
	}
}

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------

// RunDB runs a PARAMETERIZED query ($1… for postgres, ? for mysql): the SQL
// text goes verbatim to the driver, params are bound separately.
func RunDB(ctx context.Context, in DBInput) *y.Map {
	ctx, cancel := context.WithTimeout(ctx, in.Timeout)
	defer cancel()
	var rows []any
	var count float64
	var err error
	if in.Engine == "postgres" {
		rows, count, err = pgQuery(ctx, in)
	} else {
		rows, count, err = mysqlQuery(ctx, in)
	}
	if err != nil {
		return failed(err.Error())
	}
	return obj("ok", true, "output", rows, "rowCount", count)
}

func pgQuery(ctx context.Context, in DBInput) ([]any, float64, error) {
	conn, err := pgx.Connect(ctx, in.DSN)
	if err != nil {
		return nil, 0, err
	}
	defer conn.Close(context.Background())
	args := make([]any, len(in.Params))
	for i, p := range in.Params {
		args[i] = dbParam(p)
	}
	rs, err := conn.Query(ctx, in.Query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rs.Close()
	fields := rs.FieldDescriptions()
	out := []any{}
	n := 0
	for rs.Next() {
		n++
		vals, err := rs.Values()
		if err != nil {
			return nil, 0, err
		}
		if len(out) >= in.RowLimit {
			continue
		}
		row := y.NewMap()
		for i, f := range fields {
			row.Set(f.Name, pgValue(f.DataTypeOID, vals[i]))
		}
		out = append(out, row)
	}
	if err := rs.Err(); err != nil {
		return nil, 0, err
	}
	count := float64(rs.CommandTag().RowsAffected())
	if count == 0 && n > 0 {
		count = float64(n)
	}
	return out, count, nil
}

// pgValue mirrors node-postgres' default parsers: int8 / numeric → string,
// int2/int4/float → number, json(b) → parsed, timestamps → ISO strings.
func pgValue(oid uint32, v any) any {
	if v == nil {
		return nil
	}
	switch oid {
	case pgtype.Int8OID:
		return fmt.Sprint(v)
	case pgtype.NumericOID:
		if n, ok := v.(pgtype.Numeric); ok {
			if b, err := n.MarshalJSON(); err == nil {
				return strings.Trim(string(b), `"`)
			}
		}
		return fmt.Sprint(v)
	}
	switch x := v.(type) {
	case int16:
		return float64(x)
	case int32:
		return float64(x)
	case int64:
		return float64(x)
	case float32:
		return float64(x)
	case float64, bool, string:
		return x
	case time.Time:
		return jsx.ISO(x)
	case []byte:
		return string(x)
	case map[string]any, []any:
		return toValue(x)
	}
	return toValue(fmt.Sprint(v))
}

func mysqlQuery(ctx context.Context, in DBInput) ([]any, float64, error) {
	dsn, err := mysqlDSN(in.DSN)
	if err != nil {
		return nil, 0, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, 0, err
	}
	defer db.Close()
	args := make([]any, len(in.Params))
	for i, p := range in.Params {
		args[i] = dbParam(p)
	}
	rs, err := db.QueryContext(ctx, in.Query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rs.Close()
	cols, _ := rs.ColumnTypes()
	out := []any{}
	for rs.Next() {
		raw := make([]sql.RawBytes, len(cols))
		ptrs := make([]any, len(cols))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rs.Scan(ptrs...); err != nil {
			return nil, 0, err
		}
		if len(out) >= in.RowLimit {
			continue
		}
		row := y.NewMap()
		for i, c := range cols {
			row.Set(c.Name(), mysqlValue(c.DatabaseTypeName(), raw[i]))
		}
		out = append(out, row)
	}
	return out, float64(len(out)), rs.Err()
}

// mysqlValue mirrors mysql2: integer/float types → number, DECIMAL → string,
// DATETIME/TIMESTAMP/DATE → ISO (local time), JSON → parsed.
func mysqlValue(typ string, b sql.RawBytes) any {
	if b == nil {
		return nil
	}
	s := string(b)
	switch typ {
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "YEAR", "FLOAT", "DOUBLE",
		"UNSIGNED TINYINT", "UNSIGNED SMALLINT", "UNSIGNED MEDIUMINT", "UNSIGNED INT", "UNSIGNED BIGINT":
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
	case "DATETIME", "TIMESTAMP", "DATE":
		for _, layout := range []string{"2006-01-02 15:04:05.999999", "2006-01-02"} {
			if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
				return jsx.ISO(t)
			}
		}
	case "JSON":
		if v, err := y.ParseJSON(b); err == nil {
			return v
		}
	}
	return s
}

// mysqlDSN accepts mysql2's URL form (mysql://user:pass@host:3306/db?…) or a
// native go-sql-driver DSN.
func mysqlDSN(raw string) (string, error) {
	if !strings.HasPrefix(raw, "mysql://") {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	cfg := mysqldrv.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.Net = "tcp"
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "3306")
	}
	cfg.Addr = host
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	return cfg.FormatDSN(), nil
}

// dbParam converts a bag value for binding (objects/arrays as JSON text).
func dbParam(v any) any {
	switch x := v.(type) {
	case nil, string, float64, bool:
		return x
	}
	if y.IsUndefined(v) {
		return nil
	}
	return jsonString(v)
}
