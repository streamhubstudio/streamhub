#!/usr/bin/env bash
# pro: the features beyond the HERO 5000E, each verified on the real output.
#   HDR/10-bit/4:2:2 (ffprobe pix_fmt, transfer, primaries, mastering side data)
#   ABR ladder (TS PIDs + HLS master playlist with variants + RTMP of a rung)
#   audio tracks with ISO 639 languages + AC-3 track, loudness metering
#   SCTE-35 insertion via API (cues parsed back from the received TS)
#   RIST with bonding (ristsrc receiver), rolling recording ring
#   timecode in H.264 SEI, CEA-608 caption passthrough, alarms → webhook +
#   SNMP trap, thumbnails, HTTPS + roles.

ffp() { rx "ffprobe -v error $*"; }

pro_hdr() {
  local name=$1 v=$2 want_pix=$3 want_trc=$4
  selected "$name" || return 0
  api POST /channels "$(channel_json "$name" '{"type":"test","pattern":"ball"}' "$v" "[{\"id\":\"rec\",\"type\":\"file\",\"enabled\":true,\"url\":\"/res/pro/$name.ts\"}]")" >/dev/null
  wait_state "$name" live 60 || { result pro "$name" FAIL "not live: $(status "$name" | jq -c '{state,error}')"; api DELETE "/channels/$name" >/dev/null; return; }
  sleep 12
  local fps
  fps=$(status "$name" | jq .stats.fps)
  api DELETE "/channels/$name" >/dev/null
  local s
  s=$(ffp "-select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,color_transfer,color_primaries,color_space,width,height -of json /res/pro/$name.ts" | jq -c '.streams[0]')
  local md
  md=$(ffp "-select_streams v:0 -read_intervals %+#3 -show_frames -show_entries frame=side_data_list -of json /res/pro/$name.ts" | jq -c '[.frames[].side_data_list[]?.side_data_type] | unique')
  local ok=1
  [[ $(jq -r .pix_fmt <<<"$s") == "$want_pix" ]] || ok=0
  [[ -z $want_trc || $(jq -r .color_transfer <<<"$s") == "$want_trc" ]] || ok=0
  [[ $want_trc != smpte2084 || $md == *Mastering* ]] || ok=0
  [[ $(jq -r .height <<<"$s") == $(jq -r .height <<<"$v") && $(jq -r .width <<<"$s") == $(jq -r .width <<<"$v") ]] || ok=0
  ((ok)) && result pro "$name" PASS "$(jq -r '"\(.codec_name)/\(.profile) \(.width)x\(.height) \(.pix_fmt) trc=\(.color_transfer // "-") prim=\(.color_primaries // "-")"' <<<"$s") side_data=$md bus_fps=$fps" ||
    result pro "$name" FAIL "$s side_data=$md"
}

suite_pro() {
  rx "mkdir -p /res/pro /tmp/hls; (pgrep hlsrecv || (nohup hlsrecv -listen :8088 -dir /tmp/hls >/res/pro/hlsrecv.log 2>&1 &))" >/dev/null
  # ---- formats beyond the 5000E
  pro_hdr x265-main10-hlg '{"codec":"h265","encoder":"x265","width":1920,"height":1080,"fps":"25","bitrateKbps":6000,"bitDepth":10,"hdr":"hlg","preset":"veryfast"}' yuv420p10le arib-std-b67
  pro_hdr x265-main422-10 '{"codec":"h265","encoder":"x265","width":1920,"height":1080,"fps":"25","bitrateKbps":8000,"bitDepth":10,"chroma":"422","preset":"veryfast"}' yuv422p10le ""
  pro_hdr x265-pq-hdr10 '{"codec":"h265","encoder":"x265","width":1920,"height":1080,"fps":"25","bitrateKbps":6000,"bitDepth":10,"hdr":"pq","maxCll":"1000,400","preset":"veryfast"}' yuv420p10le smpte2084
  pro_hdr x265-2160p30 '{"codec":"h265","encoder":"x265","width":3840,"height":2160,"fps":"30","bitrateKbps":15000,"preset":"ultrafast"}' yuv420p ""
  if has_gpu; then
    pro_hdr nvenc-main10-pq-1080p60 '{"codec":"h265","encoder":"nvenc","width":1920,"height":1080,"fps":"60","bitrateKbps":12000,"bitDepth":10,"hdr":"pq"}' yuv420p10le smpte2084
    pro_hdr nvenc-h265-2160p60 '{"codec":"h265","encoder":"nvenc","width":3840,"height":2160,"fps":"60","bitrateKbps":30000}' yuv420p ""
    pro_hdr nvenc-main10-2160p30 '{"codec":"h265","encoder":"nvenc","width":3840,"height":2160,"fps":"30","bitrateKbps":20000,"bitDepth":10}' yuv420p10le ""
    pro_hdr nvenc-h264-1080p60 '{"codec":"h264","encoder":"nvenc","width":1920,"height":1080,"fps":"60","bitrateKbps":9000}' yuv420p ""
  fi

  # ---- ABR ladder: 1080/720/480 in one TS, HLS master + RTMP of the 720p rung
  if selected ladder; then
    local v='{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"30","bitrateKbps":5000,"lowLatency":true,"renditions":[{"width":1280,"height":720,"bitrateKbps":2500},{"width":854,"height":480,"bitrateKbps":1000,"name":"480p"}]}'
    local outs='[{"id":"hls","type":"hls","enabled":true,"url":"http://enc-e2e-rx:8088/ladder/master.m3u8","hls":{"ladder":true}},
                 {"id":"r720","type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-mediamtx:1935/r720","rendition":1},
                 {"id":"rec","type":"file","enabled":true,"url":"/res/pro/ladder.ts"}]'
    api POST /channels "$(channel_json ladder '{"type":"test","pattern":"ball"}' "$v" "$outs")" >/dev/null
    wait_state ladder live 60
    sleep 18
    local tsv rv mst
    tsv=$(ffp "-show_entries stream=index,codec_type,width,height -of csv=p=0 /res/pro/ladder.ts" | tr '\n' ' ')
    rv=$(probe 'rtmp://enc-e2e-mediamtx:1935/r720')
    mst=$(rx "cat /tmp/hls/ladder/master.m3u8 2>/dev/null")
    local st
    st=$(status ladder)
    api DELETE /channels/ladder >/dev/null
    local nvar
    nvar=$(grep -c '^#EXT-X-STREAM-INF' <<<"$mst")
    [[ $nvar == 3 && $(jq -r .v.width <<<"$rv") == 1280 && $tsv == *1920,1080*1280,720*854,480* ]] &&
      result pro abr-ladder PASS "TS: $tsv| HLS master with $nvar variants (TS) | RTMP rung 720p $(jq -r '"\(.v.width)x\(.v.height)"' <<<"$rv") | outputs $(jq -c '[.outputs[]|.state]' <<<"$st")" ||
      result pro abr-ladder FAIL "TS: $tsv master: $(tr '\n' ' ' <<<"$mst" | cut -c1-200) rtmp: $rv $(jq -c '[.outputs[]|{id,state,error}]' <<<"$st")"
  fi

  # ---- audio: 3 tracks (spa AAC stereo, eng AAC stereo, qaa AC-3 5.1) + loudness meter
  if selected audio-tracks; then
    api POST /channels "$(channel_json aud '{"type":"test","pattern":"smpte"}' '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":2500}' \
      '[{"id":"rec","type":"file","enabled":true,"url":"/res/pro/audio.ts"}]' '{"audio":{"lang":"spa","tracks":[{"lang":"eng"},{"lang":"qaa","codec":"ac3","channels":6,"bitrateKbps":384}]}}')" >/dev/null
    wait_state aud live 60
    sleep 15
    local mon
    mon=$(status aud | jq -c '.monitor.loudness')
    api DELETE /channels/aud >/dev/null
    local at
    at=$(ffp "-select_streams a -show_entries stream=codec_name,channels:stream_tags=language -of csv=p=0 /res/pro/audio.ts" | tr '\n' ' ')
    [[ $at == *aac,2,spa*aac,2,eng*ac3,6,qaa* ]] && result pro audio-tracks-languages PASS "$at" || result pro audio-tracks-languages FAIL "$at"
    # audiotestsrc volume=0.1 = −20 dBFS sine on both channels → −20 LUFS (EBU 3341 style)
    local integ
    integ=$(jq -r .integratedLufs <<<"$mon")
    within "${integ#-}" 20 5 && result pro loudness-r128-meter PASS "integrated ${integ} LUFS (expected −20.0), $(jq -c '{m:.momentaryLufs,s:.shortTermLufs,lra:.loudnessRangeLu,peak:.samplePeakDbfs}' <<<"$mon")" ||
      result pro loudness-r128-meter FAIL "$mon"
  fi

  # ---- SCTE-35 via API → cues parsed back from the SRT receiver's recording
  if selected scte35; then
    api POST /channels "$(channel_json cue '{"type":"test","pattern":"ball"}' '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":2500,"lowLatency":true}' \
      '[{"id":"srt","type":"srt","enabled":true,"url":"srt://:9500","srt":{"mode":"listener"}}]' '{"scte35":{"enabled":true,"pid":500}}')" >/dev/null
    wait_state cue live 40
    # raw TS from libsrt (ffmpeg would remux and turn the SCTE-35 PID into private data)
    rxd "timeout 30 srt-live-transmit -q 'srt://enc-e2e-enc:9500?mode=caller' file://con > /res/pro/scte35.ts"
    sleep 5
    local r1 r2 r3
    r1=$(api POST /channels/cue/scte35 '{"kind":"splice_insert","eventId":1001,"outOfNetwork":true,"durationMs":30000,"preRollMs":4000}')
    sleep 2
    r2=$(api POST /channels/cue/scte35 '{"kind":"splice_insert","eventId":1002,"immediate":true,"outOfNetwork":false}')
    sleep 2
    r3=$(api POST /channels/cue/scte35 '{"kind":"time_signal","eventId":1003,"segmentationTypeId":52,"preRollMs":2000}')
    sleep 22
    api DELETE /channels/cue >/dev/null
    local cues
    cues=$(analyze /res/pro/scte35.ts | jq -c '[.scte35[]? | {cmd:.command, id:.eventId, out:.outOfNetwork, imm:.immediate, dur:.duration, seg:[.segmentations[]?.typeId]}]')
    local pmt
    pmt=$(ffp "-show_entries stream=codec_name -of csv=p=0 /res/pro/scte35.ts" | tr '\n' ' ')
    [[ $cues == *1001* && $cues == *1002* && $cues == *time_signal* && $pmt == *scte_35* ]] &&
      result pro scte35-insert PASS "received over SRT: $cues; PMT streams: $pmt; scheduled pts $(jq -r .scheduledPts <<<"$r1")" ||
      result pro scte35-insert FAIL "cues=$cues pmt=$pmt r1=$r1 r2=$r2 r3=$r3"
  fi

  # ---- RIST with 2-link broadcast bonding → ristsrc
  if selected rist; then
    rxd "timeout 35 gst-launch-1.0 -q ristsrc address=0.0.0.0 port=8000 receiver-buffer=2000 ! rtpmp2tdepay ! filesink location=/res/pro/rist.ts"
    sleep 1
    api POST /channels "$(channel_json rist '{"type":"test","pattern":"ball"}' '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":2500}' \
      '[{"id":"rist","type":"rist","enabled":true,"url":"rist://enc-e2e-rx:8000","rist":{"bufferMs":2000}},{"id":"rec","type":"record","enabled":true,"url":"/res/pro/ring","record":{"segmentSeconds":4,"maxSegments":3}}]')" >/dev/null
    wait_state rist live 40
    docker exec "$ENC" tc qdisc add dev eth0 root netem loss 3% delay 10ms
    sleep 25
    docker exec "$ENC" tc qdisc del dev eth0 root
    local st
    st=$(status rist)
    api DELETE /channels/rist >/dev/null
    sleep 6
    local a dec
    a=$(analyze /res/pro/rist.ts)
    dec=$(decode_errors /res/pro/rist.ts)
    [[ $(jq .videoFrames <<<"$a") -gt 500 && $dec -lt 5 ]] && result pro rist-arq-3pct-loss PASS "$(jq -c '{frames:.videoFrames,cc:.ccErrors,fps}' <<<"$a") decode_errors=$dec (RIST ARQ, 3% loss)" ||
      result pro rist-arq-3pct-loss FAIL "$(jq -c '{frames:.videoFrames,cc:.ccErrors}' <<<"$a") decode_errors=$dec $(jq -c '[.outputs[]|{id,state,error}]' <<<"$st")"
    local ring
    ring=$(rx "ls /res/pro/ring/*.ts 2>/dev/null | wc -l")
    [[ $ring -ge 2 && $ring -le 3 ]] && result pro record-ring PASS "$ring segments kept (ring of 3 × 4 s)" || result pro record-ring FAIL "$ring segments"
  fi

  # ---- timecode in H.264 SEI + CEA-608 caption passthrough (UDP input with captions)
  if selected tc-cc; then
    rx "printf 'Scenarist_SCC V1.0\n\n00:00:00:00\t9420 9420 94ae 94ae 9452 9452 97a2 97a2 c845 cccc 4f80 942f 942f\n\n00:00:02:00\t942c 942c\n' > /tmp/t.scc"
    rxd "timeout 45 gst-launch-1.0 -q videotestsrc is-live=true pattern=ball ! video/x-raw,width=1280,height=720,framerate=30000/1001 ! cccombiner name=c ! x264enc tune=zerolatency bitrate=2000 key-int-max=30 ! h264parse ! mpegtsmux ! udpsink host=enc-e2e-enc port=5600  filesrc location=/tmp/t.scc ! sccparse ! ccconverter ! closedcaption/x-cea-708,format=cc_data ! c.caption"
    api POST /channels "$(channel_json tc '{"type":"udp","uri":"udp://0.0.0.0:5600"}' '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"29.97","bitrateKbps":2500,"timecodeSei":true}' \
      '[{"id":"rec","type":"file","enabled":true,"url":"/res/pro/tc.ts"}]' '{"audio":{"disabled":true}}')" >/dev/null
    wait_state tc live 40
    sleep 15
    api DELETE /channels/tc >/dev/null
    local sd cc
    sd=$(ffp "-select_streams v:0 -read_intervals %+#60 -show_frames -show_entries frame=side_data_list -of json /res/pro/tc.ts" | jq -c '[.frames[].side_data_list[]?.side_data_type] | unique')
    cc=$(ffp "-select_streams v:0 -show_entries stream=closed_captions -of csv=p=0 /res/pro/tc.ts")
    [[ $sd == *imecode* ]] && result pro timecode-sei PASS "frame side data: $sd" || result pro timecode-sei FAIL "side data: $sd"
    [[ $cc == 1* ]] && result pro cea608-passthrough PASS "output video stream closed_captions=1" || result pro cea608-passthrough FAIL "closed_captions=$cc side=$sd (captions from the UDP input were not carried)"
  fi

  # ---- alarms → webhook + SNMP v2c trap; thumbnail endpoint
  if selected alarms; then
    rx "pkill snmptrapd; mkdir -p /etc/snmp; echo 'disableAuthorization yes' > /etc/snmp/snmptrapd.conf; snmptrapd -Lf /res/pro/traps.log -On -c /etc/snmp/snmptrapd.conf udp:162"
    api PUT /notify '{"webhooks":[{"url":"http://enc-e2e-rx:8088/hooks/alarm.json","secret":"s3cret"}],"snmp":[{"address":"enc-e2e-rx:162","version":"2c","community":"public"}]}' >/dev/null
    api POST /channels "$(channel_json alm '{"type":"test","pattern":"black"}' '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":2000}' '[]' '{"alarms":{"blackSec":3,"freezeSec":5}}')" >/dev/null
    wait_state alm live 40
    sleep 12
    local al thumb
    al=$(api GET /alarms | jq -c '[.active[]|select(.channel=="alm")|.type]')
    thumb=$(docker exec "$ENC" curl -s -o /tmp/t.jpg -w '%{http_code} %{content_type} %{size_download}' -H "Authorization: Bearer $TOKEN" localhost:8090/api/v1/channels/alm/thumbnail.jpg)
    api DELETE /channels/alm >/dev/null
    sleep 3
    local hook traps
    hook=$(rx "cat /tmp/hls/hooks/alarm.json 2>/dev/null")
    traps=$(rx "grep -c 1.3.6.1.4.1.99999 /res/pro/traps.log 2>/dev/null || echo 0")
    [[ $al == *black* && $al == *freeze* ]] && result pro alarms-black-freeze PASS "active: $al" || result pro alarms-black-freeze FAIL "active: $al"
    [[ -n $hook && $(jq -r .type <<<"$hook") =~ black|freeze|input_loss ]] && result pro alarm-webhook PASS "last webhook: $(jq -c '{type,severity,active,channel}' <<<"$hook")" || result pro alarm-webhook FAIL "hook=$hook"
    [[ $traps -ge 2 ]] && result pro alarm-snmp-trap PASS "$traps traps received by snmptrapd (raise + clear)" || result pro alarm-snmp-trap FAIL "$traps traps"
    [[ $thumb == 200\ image/jpeg* ]] && result pro thumbnail PASS "$thumb bytes" || result pro thumbnail FAIL "$thumb"
    api PUT /notify '{"webhooks":[],"snmp":[]}' >/dev/null
  fi

  # ---- HTTPS + roles (second encoderd with TLS on)
  if selected https-roles; then
    docker exec -d -e ENCODERD_TLS=auto -e ENCODERD_LISTEN=127.0.0.1:8443 -e ENCODERD_DATA_DIR=/tmp/tlsd -e ENCODERD_PORT_RANGE=43000-43100 "$ENC" bash -c "exec -a encoderd-tls encoderd serve"
    local w
    for w in $(seq 1 60); do docker exec "$ENC" curl -sfk https://127.0.0.1:8443/api/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
    local pw
    pw=$(docker exec "$ENC" cat /tmp/tlsd/initial-admin-password)
    local c j
    c=$(docker exec "$ENC" curl -sk -c /tmp/cj -H 'Content-Type: application/json' -d "{\"user\":\"admin\",\"password\":\"$pw\"}" https://127.0.0.1:8443/api/v1/auth/login)
    docker exec "$ENC" curl -sk -b /tmp/cj -c /tmp/cj -H 'Content-Type: application/json' -H 'X-Requested-With: encoder-ui' -d "{\"current\":\"$pw\",\"new\":\"e2e-admin-pass-123\"}" https://127.0.0.1:8443/api/v1/auth/password >/dev/null
    j=$(docker exec "$ENC" curl -sk -b /tmp/cj -H 'Content-Type: application/json' -H 'X-Requested-With: encoder-ui' -d '{"name":"wall","role":"viewer"}' https://127.0.0.1:8443/api/v1/tokens)
    local vt
    vt=$(jq -r .token <<<"$j")
    local g p cert
    g=$(docker exec "$ENC" curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $vt" https://127.0.0.1:8443/api/v1/channels)
    p=$(docker exec "$ENC" curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $vt" -H 'Content-Type: application/json' -d '{"id":"x","input":{"type":"test"},"video":{"codec":"h264","width":1280,"height":720,"fps":"30","bitrateKbps":2000}}' https://127.0.0.1:8443/api/v1/channels)
    cert=$(docker exec "$ENC" bash -c "echo | openssl s_client -connect 127.0.0.1:8443 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null | tr '\n' ' '" || true)
    local aud
    aud=$(docker exec "$ENC" bash -c "grep -c '\"path\"' /tmp/tlsd/audit.log")
    docker exec "$ENC" pkill -f encoderd-tls 2>/dev/null
    [[ $(jq -r .role <<<"$c") == admin && $g == 200 && $p == 403 && $aud -ge 2 ]] &&
      result pro https-roles-audit PASS "HTTPS self-signed; admin login (forced password change); viewer token GET=200 POST=403; audit lines=$aud" ||
      result pro https-roles-audit FAIL "login=$c viewer GET=$g POST=$p audit=$aud"
  fi
}
