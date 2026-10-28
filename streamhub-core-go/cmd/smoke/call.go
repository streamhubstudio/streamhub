package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	lklogger "github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// runCall is the live half of the conference smoke: two server-side bots
// (livekit server-sdk-go) join one room, see each other and exchange a
// reliable data packet both ways — the signaling + SFU + data-channel path
// the conference sample's chat rides on. Tokens come either from the
// StreamHub API (-base/-token/-app → POST /apps/:app/tokens, the room is
// namespaced by the app) or straight from LiveKit credentials
// (-lk-key/-lk-secret). It creates only an ephemeral room that LiveKit drops
// once both bots leave. Exit 0 pass, 1 fail, 2 usage.
func runCall(args []string) int {
	fs := flag.NewFlagSet("call", flag.ContinueOnError)
	lkURL := fs.String("lk-url", os.Getenv("LIVEKIT_URL"), "LiveKit ws(s):// URL (default: the core's public wsUrl)")
	lkKey := fs.String("lk-key", os.Getenv("LIVEKIT_API_KEY"), "LiveKit API key (mint tokens locally)")
	lkSecret := fs.String("lk-secret", os.Getenv("LIVEKIT_API_SECRET"), "LiveKit API secret")
	base := fs.String("base", os.Getenv("STREAMHUB_BASE"), "core base URL (mint tokens through the API)")
	token := fs.String("token", os.Getenv("STREAMHUB_TOKEN"), "sk_ API token")
	app := fs.String("app", "live", "app whose room to join (API mode)")
	room := fs.String("room", "smoke-call-"+strconv.FormatInt(time.Now().UnixMilli(), 36), "room name")
	timeout := fs.Duration("timeout", 20*time.Second, "overall wait for peers + data")
	verbose := fs.Bool("v", false, "keep the LiveKit SDK / pion logs")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !*verbose {
		lksdk.SetLogger(lklogger.GetDiscardLogger())
	}

	type joinFn func(identity string, cb *lksdk.RoomCallback) (*lksdk.Room, error)
	var join joinFn
	switch {
	case *lkKey != "" && *lkSecret != "":
		if *lkURL == "" {
			fmt.Fprintln(os.Stderr, "-lk-url required with -lk-key/-lk-secret")
			return 2
		}
		join = func(id string, cb *lksdk.RoomCallback) (*lksdk.Room, error) {
			return lksdk.ConnectToRoom(*lkURL, lksdk.ConnectInfo{APIKey: *lkKey, APISecret: *lkSecret, RoomName: *room, ParticipantIdentity: id}, cb)
		}
	case *base != "" && *token != "":
		join = func(id string, cb *lksdk.RoomCallback) (*lksdk.Room, error) {
			t, ws, err := mintToken(strings.TrimRight(*base, "/"), *token, *app, *room, id)
			if err != nil {
				return nil, err
			}
			if *lkURL != "" {
				ws = *lkURL
			}
			return lksdk.ConnectToRoomWithToken(ws, t, cb)
		}
	default:
		fmt.Fprintln(os.Stderr, "need -lk-url/-lk-key/-lk-secret or -base/-token")
		return 2
	}

	fmt.Printf("StreamHub call smoke → room %q\n", *room)
	failed := false
	check := func(cond bool, label string) {
		if cond {
			fmt.Println("OK   " + label)
		} else {
			failed = true
			fmt.Fprintln(os.Stderr, "FAIL: "+label)
		}
	}

	got := map[string]chan string{"bot-a": make(chan string, 1), "bot-b": make(chan string, 1)}
	cbFor := func(self string) *lksdk.RoomCallback {
		cb := lksdk.NewRoomCallback()
		cb.OnDataPacket = func(d lksdk.DataPacket, p lksdk.DataReceiveParams) {
			if u, ok := d.(*lksdk.UserDataPacket); ok {
				select {
				case got[self] <- p.SenderIdentity + ":" + string(u.Payload):
				default:
				}
			}
		}
		return cb
	}
	a, err := join("bot-a", cbFor("bot-a"))
	check(err == nil, "bot-a connected"+errSuffix(err))
	if err != nil {
		return 1
	}
	defer a.Disconnect()
	b, err := join("bot-b", cbFor("bot-b"))
	check(err == nil, "bot-b connected"+errSuffix(err))
	if err != nil {
		return 1
	}
	defer b.Disconnect()

	deadline := time.Now().Add(*timeout)
	sees := func(r *lksdk.Room, id string) bool {
		for _, p := range r.GetRemoteParticipants() {
			if p.Identity() == id {
				return true
			}
		}
		return false
	}
	for time.Now().Before(deadline) && !(sees(a, "bot-b") && sees(b, "bot-a")) {
		time.Sleep(100 * time.Millisecond)
	}
	check(sees(a, "bot-b") && sees(b, "bot-a"), "bots see each other")

	_ = a.LocalParticipant.PublishDataPacket(lksdk.UserData([]byte("ping")), lksdk.WithDataPublishReliable(true))
	_ = b.LocalParticipant.PublishDataPacket(lksdk.UserData([]byte("pong")), lksdk.WithDataPublishReliable(true))
	wait := func(self, want string) bool {
		select {
		case v := <-got[self]:
			return v == want
		case <-time.After(time.Until(deadline) + time.Second):
			return false
		}
	}
	check(wait("bot-b", "bot-a:ping"), "data a → b (reliable)")
	check(wait("bot-a", "bot-b:pong"), "data b → a (reliable)")

	if failed {
		fmt.Println("RESULT: FAIL")
		return 1
	}
	fmt.Println("RESULT: PASS")
	return 0
}

func errSuffix(err error) string {
	if err == nil {
		return ""
	}
	return ": " + err.Error()
}

// mintToken asks the core for a join token (POST /apps/:app/tokens).
func mintToken(base, token, app, room, identity string) (string, string, error) {
	body := fmt.Sprintf(`{"room":%q,"identity":%q,"canPublish":true}`, room, identity)
	req, _ := http.NewRequest(http.MethodPost, base+"/api/v1/apps/"+app+"/tokens", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	var out struct {
		Data struct {
			Token string `json:"token"`
			WsURL string `json:"wsUrl"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode >= 300 || out.Data.Token == "" {
		return "", "", fmt.Errorf("mint token: HTTP %d %v", res.StatusCode, err)
	}
	return out.Data.Token, out.Data.WsURL, nil
}
