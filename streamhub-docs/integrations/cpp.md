# StreamHub from C++ — native publishing

There are two realistic ways to get media out of a C++ program into a StreamHub app:

| Option | Transport | When | Latency |
|--------|-----------|------|---------|
| **(A) RTMP push** to the ingress | RTMP/FLV | **Recommended.** Any C++ app with ffmpeg/GStreamer. Simple, robust, works today. | a few seconds |
| **(B) WebRTC FFI** (`livekit-ffi` / Rust SDK) | WebRTC | You truly need sub-second, two-way, or data channels in native C++. | sub-second |

For playback from C++, use **HLS** (`/hls/<app>/<room>/index.m3u8`) — trivially consumable
by libavformat, GStreamer, or any media player widget.

---

## Option A (recommended): push RTMP to the ingress

### A.1 Create the ingress (once)

Ask StreamHub for an RTMP ingress on the room you want to feed:

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/ingress \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputType":"rtmp","room":"cpp","enableTranscoding":true}'
```

```json
{
  "data": {
    "ingressId": "IN_abc123",
    "url": "rtmp://media.example.com:1935/live",
    "streamKey": "sk-9f3c...",
    "roomName": "live-cpp"
  }
}
```

Your full publish URL is `url` + `/` + `streamKey`:
`rtmp://media.example.com:1935/live/sk-9f3c...`. **Use exactly the `url`/`streamKey`
the API returns** (the host follows `RTMP_PUBLIC_HOST`).

### A.2a Easiest: shell out to the `ffmpeg` binary

If you can ship the `ffmpeg` binary, this is the least code and very robust. Feed raw
frames to ffmpeg's stdin (here: BGR24 frames, e.g. from OpenCV) and let it encode + push:

```cpp
#include <cstdio>
#include <string>

int main() {
    const int W = 1280, H = 720, FPS = 30;
    const std::string rtmp =
        "rtmp://media.example.com:1935/live/sk-9f3c...";   // url + "/" + streamKey

    std::string cmd =
        "ffmpeg -loglevel warning -y "
        "-f rawvideo -pix_fmt bgr24 -s 1280x720 -r 30 -i - "   // raw frames on stdin
        "-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p "
        "-g 60 -b:v 2500k -f flv \"" + rtmp + "\"";

    FILE* pipe = popen(cmd.c_str(), "w");           // _popen on Windows
    if (!pipe) return 1;

    const size_t frameBytes = (size_t)W * H * 3;    // bgr24
    std::string frame(frameBytes, '\0');
    for (int i = 0; i < FPS * 10; ++i) {            // 10 s of frames
        // ... fill `frame` with your pixels here (e.g. cv::Mat::data) ...
        fwrite(frame.data(), 1, frameBytes, pipe);
    }
    pclose(pipe);
    return 0;
}
```

Compile: `g++ -O2 push.cpp -o push`. Add `-c:a aac` plus an audio input if you have sound.

### A.2b In-process with libavformat (no external binary)

When you want everything inside the process, use FFmpeg's libraries
(`libavformat`/`libavcodec`). Sketch of the muxing path to RTMP/FLV (encode loop
elided for brevity):

```cpp
// link: -lavformat -lavcodec -lavutil -lswscale
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
}
#include <stdexcept>
#include <string>

int main() {
    const char* out = "rtmp://media.example.com:1935/live/sk-9f3c...";
    const int W = 1280, H = 720, FPS = 30;

    avformat_network_init();

    AVFormatContext* fmt = nullptr;
    // "flv" muxer is required for RTMP:
    avformat_alloc_output_context2(&fmt, nullptr, "flv", out);
    if (!fmt) throw std::runtime_error("alloc flv ctx");

    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_H264);
    AVStream* st = avformat_new_stream(fmt, codec);
    AVCodecContext* enc = avcodec_alloc_context3(codec);
    enc->width = W; enc->height = H;
    enc->pix_fmt = AV_PIX_FMT_YUV420P;
    enc->time_base = AVRational{1, FPS};
    enc->framerate = AVRational{FPS, 1};
    enc->gop_size = FPS * 2;
    enc->bit_rate = 2'500'000;
    av_opt_set(enc->priv_data, "preset", "veryfast", 0);
    av_opt_set(enc->priv_data, "tune", "zerolatency", 0);
    if (fmt->oflags & AVFMT_GLOBALHEADER) enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    avcodec_open2(enc, codec, nullptr);
    avcodec_parameters_from_context(st->codecpar, enc);
    st->time_base = enc->time_base;

    if (!(fmt->oformat->flags & AVFMT_NOFILE))
        avio_open(&fmt->pb, out, AVIO_FLAG_WRITE);   // opens the RTMP connection
    avformat_write_header(fmt, nullptr);

    // ---- per frame: fill an AVFrame (YUV420P), avcodec_send_frame(enc, frame),
    //      then drain avcodec_receive_packet(enc, pkt),
    //      av_packet_rescale_ts(pkt, enc->time_base, st->time_base),
    //      pkt->stream_index = st->index, av_interleaved_write_frame(fmt, pkt). ----

    av_write_trailer(fmt);
    avio_closep(&fmt->pb);
    avcodec_free_context(&enc);
    avformat_free_context(fmt);
    return 0;
}
```

The only StreamHub-specific part is the **output URL** (`flv` muxer + the ingress
`url/streamKey`). Everything else is standard FFmpeg muxing.

### A.2c GStreamer alternative

If your stack is GStreamer, the pipeline (from `gst_parse_launch`, or `gst-launch-1.0`
to prototype) is:

```
appsrc ! videoconvert ! x264enc tune=zerolatency bitrate=2500 key-int-max=60 !
  flvmux streamable=true name=mux !
  rtmpsink location="rtmp://media.example.com:1935/live/sk-9f3c... live=1"
```

Add `audiotestsrc`/your audio ! `voaacenc` ! `mux.` for sound.

### A.3 Verify

The room goes live as soon as the push connects. Check it:

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/streams \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

…and watch over HLS: `https://streamhub.example.com/hls/live/live-cpp/index.m3u8`
(or WebRTC via a subscribe token / the embed page).

---

## Option B: native WebRTC via livekit-ffi

LiveKit ships a **Rust core with a C-ABI FFI** (`livekit-ffi`, the same engine behind the
Unity/Python/Node SDKs). C++ can link against it to publish/subscribe real WebRTC tracks
with sub-second latency, including data channels. This is the path only if RTMP latency is
unacceptable.

- Repo: `github.com/livekit/rust-sdks` (build `livekit-ffi` → a shared lib + generated
  protobuf for the request/response protocol).
- You still authenticate with a **`{ token, wsUrl }`** minted by
  `POST /apps/:app/tokens` — identical to Android/iOS. The FFI `Connect` request takes
  `url` (`wsUrl`) + `token`; then `PublishTrack` with a video/audio source you feed.
- Caveats: no first-class C++ wrapper (you drive the protobuf FFI yourself), heavier build
  (Rust toolchain + WebRTC), and you manage frame sources manually. For most native
  publishers, **Option A is dramatically simpler** and good enough.

---

## Playback from C++

Use **HLS** — no token needed:

```
https://streamhub.example.com/hls/<app>/<room>/index.m3u8
```

Open it with libavformat (`avformat_open_input(&ctx, url, ...)`), GStreamer
(`playbin uri=...`), or any player widget. For real-time two-way you'd subscribe over
WebRTC (Option B), but for one-way viewing HLS is the pragmatic choice.

---

## Checklist

1. `POST /apps/:app/ingress {inputType:"rtmp"}` → get `url` + `streamKey`.
2. Encode H.264 + AAC and mux to **FLV** at `url/streamKey` (ffmpeg binary, libavformat,
   or GStreamer `rtmpsink`).
3. Confirm via `GET /apps/:app/streams`; watch via HLS `/hls/<app>/<room>/index.m3u8`.
4. Only reach for `livekit-ffi` (Option B) if you need sub-second / two-way native WebRTC.
