# Slim ffmpeg build — what it buys you, and what it doesn't

The owner asked whether a reduced ffmpeg build can "optimize a %". Short, honest answer:

- **Yes for footprint & attack surface.** Replacing the stock Debian `ffmpeg` (binary + its
  shared-library dependency closure, roughly **70–100 MB** in the image) with a purpose-built
  binary carrying **only** the demuxers/muxers/codecs/filters/protocols we actually use gets you a
  single **~15–25 MB** binary, a much smaller attack surface, and a marginally faster cold start.
- **No for transcode throughput.** The slim binary uses the **same** encoders (`libx264`,
  `libvpx`, `aac`, `libopus`, `mjpeg`), so per-frame encoding CPU is **essentially unchanged**.
  Slimming ffmpeg does **not** make transcoding faster — same codecs, same math.
- **Scope caveat (important).** This only affects the **core image's own ffmpeg**. The heavy
  media-plane transcode — RTMP/WHIP/RTSP **ingest** and HLS-live/**recording egress** — runs
  inside the LiveKit `ingress` and `egress` containers, which **bundle their own ffmpeg from the
  upstream LiveKit images**. This build does not touch them. So the win here is a leaner, safer
  **core** image, not a faster hot path.

This doc inventories the **actual** ffmpeg usage in the repo, derives the minimal `./configure`
flag set, and ships a reproducible static-build recipe at
[`deploy/build-ffmpeg-slim.sh`](../../deploy/build-ffmpeg-slim.sh) — **documented but NOT wired
into the Dockerfile yet.**

---

## 1. Where ffmpeg is actually used

`grep` across `streamhub-core`, the workers, and `deploy/` for every real invocation:

| Caller | Binary | Command (essentials) | I/O |
|---|---|---|---|
| `internal/streams/streams.go` → snapshot capture | `ffmpeg` | `-rw_timeout 10000000 -i <rtmp://…> -frames:v 1 -q:v 2 out.jpg` | **in:** RTMP (default) or the `STREAMHUB_SNAPSHOT_SOURCE` template (may be RTSP/HTTP). **out:** single JPEG |
| `internal/recording/media.go` → `ProbeMedia()` | `ffprobe` | `-v quiet -print_format json -show_format -show_streams <file>` | **in:** local MP4 / presigned S3 URL. **out:** JSON metadata |
| `internal/recording/media.go` → `ExtractSnapshot()` | `ffmpeg` | `-ss <s> -i <local.mp4> -frames:v 1 -q:v 2 out.jpg` | **in:** MP4. **out:** JPEG |
| `internal/recording/transcodeutil.go` → `TranscodeHlsRendition()` | `ffmpeg` | `-i <mp4> -vf scale=-2:H -c:v libx264 -profile:v main -preset veryfast -b:v .. -maxrate .. -bufsize .. -c:a aac -b:a 128k -ac 2 -hls_time 4 -hls_playlist_type vod -hls_list_size 0 -hls_segment_filename seg_%04d.ts index.m3u8` | **in:** MP4. **out:** HLS (m3u8 + `.ts`) |
| `internal/recording/transcodeutil.go` → `TranscodeWebmVp8()` | `ffmpeg` | `-i <mp4> -c:v libvpx -b:v .. -deadline good -cpu-used 2 -c:a libopus -b:a 128k out.webm` | **in:** MP4. **out:** WebM (VP8+Opus) |

**Not the core binary (do not size the slim build around these):**

- **LiveKit `ingress` / `egress`** — the RTMP/WHIP/RTSP ingest transcode and the HLS-live +
  Chrome-composite recording. Each bundles **its own** ffmpeg inside the upstream LiveKit image.
  StreamHub does not build these; they are out of scope for this recipe.
- **`deface-worker` / `yolo-worker`** — decode HLS via **OpenCV's bundled ffmpeg libs**
  (`cv2.VideoCapture`), not the CLI. Their Dockerfiles apt-install `ffmpeg`, but the decode path
  is OpenCV's `opencv-python-headless`, which carries its own libav*. Separate images; not this
  binary.
- **NVENC (`h264_nvenc` / `hevc_nvenc`)** — the core image advertises hardware encoders when a GPU
  is granted (`gpus: all` + `nvidia-container-toolkit`, see
  [../features/transcoding-gpu.md](../features/transcoding-gpu.md)), but note the **core's own
  ffmpeg code paths above do not currently invoke NVENC** — the hardware encoder is selected by
  the LiveKit egress/ingress worker, not the core CLI. Keep NVENC as an **opt-in** in the slim
  build (`ENABLE_NVENC=1`) so the documented capability isn't silently dropped.

### Feature inventory (what the slim build must keep)

| Class | Needed |
|---|---|
| **Protocols** | `file`, `pipe`, `tcp`, `udp`, `rtp`, `rtmp`, `http`, `https`, `tls`, `hls`, `crypto` (rtmp→tcp; https→tls; hls→http+crypto; rtsp optional via `STREAMHUB_SNAPSHOT_SOURCE`) |
| **Demuxers (in)** | `flv`/`live_flv` (RTMP), `mov`/`mp4` (MP4), `mpegts` + `hls` (segments/playlists), `matroska`/`webm`, `image2`, `mjpeg`, `rtsp` (optional) |
| **Muxers (out)** | `image2` + `mjpeg` (JPEG), `hls` + `mpegts` (HLS ladder), `mp4`/`mov`, `webm`/`matroska`, `null` |
| **Decoders** | `h264`, `aac`, `mp3`, `vp8`, `vp9`, `opus`, `mjpeg`, `pcm_s16le`, `rawvideo` |
| **Encoders** | `libx264` (HLS), `aac` (HLS audio), `mjpeg` (snapshots), `libvpx` (WebM/VP8), `libopus` (WebM audio); optional `h264_nvenc`/`hevc_nvenc` |
| **Filters** | `scale` (the `-vf scale=-2:H` ladder), plus `format`, `aformat`, `aresample`, `anull`, `null`, `copy`, `fps`, `setpts`, `asetpts` |
| **Libraries** | `libx264`, `libvpx`, `libopus`; `swscale` (scaling), `swresample` (`-ac 2`, `-b:a`); `avfilter`; `openssl` (TLS/https) |
| **Parsers / BSF** | parsers `h264 aac vp8 vp9 opus mpegaudio`; bitstream filters `h264_mp4toannexb` (h264→ts), `aac_adtstoasc` (aac→mp4), `extract_extradata` |

Everything else — the hundreds of exotic demuxers/decoders/filters in a stock build (HEVC, AV1,
theora, MP3-LAME encode, dozens of image formats, device inputs, X11 grabbers, …) — is dead weight
for StreamHub and can be dropped.

---

## 2. Minimal `./configure` flag set

Start from **`--disable-everything`** and re-enable exactly the inventory above:

```sh
./configure \
  --prefix=/opt/ffmpeg-slim \
  --disable-everything --disable-doc --disable-debug \
  --disable-ffplay --disable-devices --disable-sdl2 \
  --enable-small \
  --enable-gpl --enable-version3 \
  --enable-network --enable-openssl \
  --enable-avfilter --enable-swscale --enable-swresample \
  --enable-libx264 --enable-libvpx --enable-libopus \
  --enable-protocol=file,pipe,tcp,udp,rtp,rtmp,http,https,tls,hls,crypto \
  --enable-demuxer=flv,live_flv,mov,mpegts,hls,matroska,image2,mjpeg,aac,h264,rtsp \
  --enable-muxer=image2,mjpeg,mov,mp4,hls,mpegts,matroska,webm,null \
  --enable-decoder=h264,aac,aac_latm,mp3,vp8,vp9,opus,mjpeg,pcm_s16le,rawvideo \
  --enable-encoder=libx264,aac,mjpeg,libvpx,libopus \
  --enable-filter=scale,format,aformat,aresample,anull,null,copy,fps,setpts,asetpts \
  --enable-parser=h264,aac,vp8,vp9,opus,mpegaudio \
  --enable-bsf=h264_mp4toannexb,aac_adtstoasc,extract_extradata \
  --enable-demuxer=rtp --enable-muxer=rtp
# optional GPU encoders (needs nv-codec-headers at build; loads the driver via dlopen at runtime):
#   --enable-ffnvcodec --enable-encoder=h264_nvenc,hevc_nvenc
```

Notes:
- `--enable-gpl` is required by `libx264` (GPL). StreamHub-core is AGPL-3.0-only, so a GPL ffmpeg
  is license-compatible. **No `--enable-nonfree`** is needed (we don't use fdk-aac; the native
  `aac` encoder is fine and BSD).
- `mov` demuxer also reads `mp4`; the `mp4`/`mov` muxers are enabled for MP4 output completeness
  even though the current core paths emit HLS + WebM.
- Drop `rtsp`/`rtp` from the enables if you never set `STREAMHUB_SNAPSHOT_SOURCE` to an RTSP URL —
  they're included for parity with the documented RTSP ingest source.

---

## 3. Expected wins (truthful)

| Dimension | Stock Debian ffmpeg | Slim build | Verdict |
|---|---|---|---|
| Footprint in the image | ~70–100 MB (binary + libav*/codec `.so` closure: x265, aom, theora, lame, …) | **~15–25 MB** single binary | **large win** |
| Attack surface | every demuxer/decoder/protocol ffmpeg ships | only the ~10 formats + 5 protocols we use | **meaningful win** |
| Cold start | load a big binary + many `.so` | one small binary, few deps | **small win** |
| Transcode CPU / throughput | `libx264`/`libvpx`/`aac`/`libopus` | **same** encoders | **no change** — do not expect faster recording/HLS |
| Ingest / egress hot path | LiveKit `ingress`/`egress` own ffmpeg | **untouched** | **no change** — this build is core-image only |

So: it "optimizes a %" of **image size and attack surface** (substantial), and does **not**
optimize transcoding speed (unchanged). If the goal was faster transcode, the levers are GPU/NVENC
offload and preset/rendition tuning ([../features/transcoding-gpu.md](../features/transcoding-gpu.md),
[CAPACITY-G2.md](./CAPACITY-G2.md)), not a slimmer ffmpeg.

---

## 4. Build recipe & validation

The recipe lives in [`deploy/build-ffmpeg-slim.sh`](../../deploy/build-ffmpeg-slim.sh): it pins
ffmpeg + x264 + libvpx + opus versions (overridable via env), builds the codec libs statically,
configures ffmpeg with the flag set above, and emits `ffmpeg` + `ffprobe` under `--prefix`. It is
**not** referenced by `deploy/Dockerfile` yet — run it standalone to evaluate before wiring it in.

```sh
# On a Debian/Ubuntu box (matches the node:20-bookworm-slim runtime base):
sudo apt-get install -y build-essential nasm pkg-config git curl ca-certificates zlib1g-dev libssl-dev
deploy/build-ffmpeg-slim.sh                 # → /opt/ffmpeg-slim/bin/{ffmpeg,ffprobe}
ENABLE_NVENC=1 deploy/build-ffmpeg-slim.sh  # additionally build h264_nvenc/hevc_nvenc
```

### Validation checklist — run every real invocation pattern against the slim binary

```sh
FF=/opt/ffmpeg-slim/bin/ffmpeg
FP=/opt/ffmpeg-slim/bin/ffprobe

# capability smoke tests
$FF -hide_banner -protocols | grep -E 'file|rtmp|https|hls'          # protocols present
$FF -hide_banner -encoders  | grep -E 'libx264|libvpx|aac|mjpeg|libopus'
$FF -hide_banner -filters   | grep -E ' scale '

# 1. make a tiny source (h264+aac mp4)
$FF -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
   -t 5 -c:v libx264 -c:a aac -shortest sample.mp4          # (needs lavfi; else copy in a real mp4)

# 2. probeMedia()  — must emit JSON with width/height/codec_name
$FP -v quiet -print_format json -show_format -show_streams sample.mp4

# 3. extractSnapshot()  — MP4 → JPEG
$FF -y -ss 1 -i sample.mp4 -frames:v 1 -q:v 2 snap.jpg && file snap.jpg

# 4. transcodeHlsRendition()  — MP4 → HLS ladder step
$FF -y -i sample.mp4 -vf scale=-2:360 -c:v libx264 -profile:v main -preset veryfast \
   -b:v 800k -maxrate 856k -bufsize 1600k -c:a aac -b:a 128k -ac 2 \
   -hls_time 4 -hls_playlist_type vod -hls_list_size 0 \
   -hls_segment_filename seg_%04d.ts index.m3u8 && ls index.m3u8 seg_0000.ts

# 5. transcodeWebmVp8()  — MP4 → WebM (VP8+Opus)
$FF -y -i sample.mp4 -c:v libvpx -b:v 2500k -deadline good -cpu-used 2 \
   -c:a libopus -b:a 128k out.webm && $FP -v quiet -show_streams out.webm | grep -E 'vp8|opus'

# 6. captureFrame() from RTMP — against a live ingress (optional, needs a running stream)
$FF -y -rw_timeout 10000000 -i rtmp://<host>:1935/<app>/<key> -frames:v 1 -q:v 2 live.jpg

# 7. size check
ls -lh $FF $FP
```

If steps 2–5 pass and produce valid outputs, the slim binary covers 100% of the core's ffmpeg
surface. Only after that should you consider swapping the apt `ffmpeg` in `deploy/Dockerfile` for
a `COPY --from` of these two binaries.

---

## Related

- [../features/transcoding-gpu.md](../features/transcoding-gpu.md) — GPU/NVENC detection + hwaccel
- [CAPACITY-G2.md](./CAPACITY-G2.md) — measured transcode capacity (the real throughput lever)
- [DEPLOY.md](./DEPLOY.md) — the core image build this would eventually slim
