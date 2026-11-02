#!/usr/bin/env bash
# netem: SRT must ride out 5 % and 10 % random packet loss (+20 ms delay)
# with its latency buffer; plain UDP-TS over the same impaired link is the
# control (it should show continuity/decoding errors). Impairment = tc netem
# on the encoder's and the receiver's eth0 (both directions: data and NAKs).

netem_case() { # loss_pct srt_latency_ms seconds
  local loss=$1 lat=$2 secs=$3
  local name="loss${loss}pct-lat${lat}ms"
  local v='{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true}'
  local outs="[{\"id\":\"srt\",\"type\":\"srt\",\"enabled\":true,\"url\":\"srt://enc-e2e-rx:9300\",\"srt\":{\"latencyMs\":$lat}},
               {\"id\":\"udp\",\"type\":\"udp\",\"enabled\":true,\"url\":\"udp://enc-e2e-rx:5300\"}]"
  rx "rm -f /res/netem/$name-*.ts; mkdir -p /res/netem"
  rxd "timeout $((secs + 40)) ffmpeg -nostdin -loglevel error -y -i 'srt://0.0.0.0:9300?mode=listener&latency=$((lat * 1000))' -map 0 -c copy -t $secs -f mpegts /res/netem/$name-srt.ts"
  rxd "timeout $((secs + 40)) ffmpeg -nostdin -loglevel error -y -i 'udp://0.0.0.0:5300?fifo_size=1000000&overrun_nonfatal=1' -map 0 -c copy -t $secs -f mpegts /res/netem/$name-udp.ts"
  sleep 1
  api POST /channels "$(channel_json nm '{"type":"test","pattern":"ball"}' "$v" "$outs" '{"overlay":{"timecode":true}}')" >/dev/null
  wait_state nm live 40 || { result netem "$name" FAIL "not live"; return; }
  docker exec "$ENC" tc qdisc add dev eth0 root netem loss "${loss}%" delay 20ms 5ms
  docker exec "$RX" tc qdisc add dev eth0 root netem loss "${loss}%" delay 20ms 5ms
  sleep $((secs + 5))
  docker exec "$ENC" tc qdisc del dev eth0 root 2>/dev/null
  docker exec "$RX" tc qdisc del dev eth0 root 2>/dev/null
  local st
  st=$(status nm)
  api DELETE /channels/nm >/dev/null
  sleep 3
  local s u
  s=$(analyze "/res/netem/$name-srt.ts")
  u=$(analyze "/res/netem/$name-udp.ts")
  local s_dec u_dec
  s_dec=$(decode_errors "/res/netem/$name-srt.ts")
  u_dec=$(decode_errors "/res/netem/$name-udp.ts")
  local exp=$((secs * 30 * 97 / 100))
  local sf sc srr
  sf=$(jq .videoFrames <<<"$s")
  sc=$(jq .ccErrors <<<"$s")
  srr=$(jq '.outputs[]|select(.id=="srt")|.process.restarts' <<<"$st")
  local det="SRT: ${sf} frames (≥$exp) cc=$sc decode_errors=$s_dec reconnects=$srr | UDP control: $(jq .videoFrames <<<"$u") frames cc=$(jq .ccErrors <<<"$u") decode_errors=$u_dec"
  if [[ $sc == 0 && $s_dec == 0 && $sf -ge $exp && $srr == 0 ]]; then
    result netem "srt-$name" PASS "$det"
  else
    result netem "srt-$name" FAIL "$det"
  fi
}

suite_netem() {
  netem_case 5 1000 60
  netem_case 10 1000 60
  netem_case 10 400 45
}
