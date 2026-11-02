#!/usr/bin/env bash
# VMAF of the encoder's rate-control settings on a real clip.
#   test/e2e/vmaf.sh /path/clip.mp4 [kbps=4000]
# Encodes the clip with the SAME element settings internal/pipeline emits
# (x265 faster/medium CBR, NVENC HEVC p4 CBR, x264 veryfast CBR) inside the
# encoder image, then scores each against the source with libvmaf (static
# FFmpeg build from BtbN, downloaded once into ~/.cache/enc-vmaf).
set -euo pipefail
CLIP=${1:?clip.mp4}
KBPS=${2:-4000}
IMG=${E2E_IMAGE:-enc-e2e:dev}
OUT=${OUT:-$PWD/test/e2e/results/vmaf-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$OUT" ~/.cache/enc-vmaf
chmod 777 "$OUT"
if [[ ! -x ~/.cache/enc-vmaf/ffmpeg ]]; then
  curl -sL https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz | tar -xJ -C ~/.cache/enc-vmaf --strip-components=2 --wildcards '*/bin/ffmpeg'
fi
GPU=()
docker info 2>/dev/null | grep -q 'Runtimes:.*nvidia' && GPU=(--runtime nvidia --gpus all -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility)
fps=$(docker run --rm -v "$CLIP:/c.mp4:ro" --entrypoint ffprobe "$IMG" -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 /c.mp4)
fpsn=$(awk -v f="$fps" 'BEGIN{split(f,p,"/"); printf "%.6f", p[1]/(p[2]?p[2]:1)}')
gop=$(awk -v f="$fps" 'BEGIN{split(f,p,"/"); printf "%d", 2*p[1]/(p[2]?p[2]:1)+0.5}')
enc() { # name encoder-chain (skipped when the encode already exists)
  [[ -s $OUT/$1.mkv ]] && return 0
  docker run --rm "${GPU[@]}" -v "$CLIP:/c.mp4:ro" -v "$OUT:/o" --entrypoint gst-launch-1.0 "$IMG" -q \
    filesrc location=/c.mp4 ! qtdemux ! h264parse ! avdec_h264 ! videoconvert ! $2 ! matroskamux ! filesink location=/o/$1.mkv
}
enc x265-faster "video/x-raw,format=I420 ! x265enc speed-preset=faster key-int-max=$gop bitrate=$KBPS option-string=bframes=3:repeat-headers=1:aud=1:vbv-maxrate=$KBPS:vbv-bufsize=$KBPS:strict-cbr=1:hrd=1 ! h265parse"
enc x265-medium "video/x-raw,format=I420 ! x265enc speed-preset=medium key-int-max=$gop bitrate=$KBPS option-string=bframes=3:repeat-headers=1:aud=1:vbv-maxrate=$KBPS:vbv-bufsize=$KBPS:strict-cbr=1:hrd=1 ! h265parse"
enc x264-veryfast "video/x-raw,format=I420 ! x264enc speed-preset=veryfast key-int-max=$gop bframes=2 b-adapt=true b-pyramid=true pass=cbr bitrate=$KBPS vbv-buf-capacity=1000 nal-hrd=cbr ! h264parse"
if ((${#GPU[@]})); then
  enc nvenc-hevc-p4 "video/x-raw,format=NV12 ! nvh265enc preset=p4 tune=high-quality rc-mode=cbr bitrate=$KBPS gop-size=$gop bframes=2 vbv-buffer-size=$KBPS ! h265parse"
  enc nvenc-hevc-p7 "video/x-raw,format=NV12 ! nvh265enc preset=p7 tune=high-quality rc-mode=cbr bitrate=$KBPS gop-size=$gop bframes=2 vbv-buffer-size=$KBPS multi-pass=two-pass-quarter ! h265parse"
fi
# Decode both sides to Y4M first: scoring container timestamps (mkv ms vs mp4
# exact) through libvmaf's framesync mis-paired frames.
~/.cache/enc-vmaf/ffmpeg -y -loglevel error -i "$CLIP" -pix_fmt yuv420p -fps_mode passthrough "$OUT/ref.y4m"
printf 'encode\tkbps\tvmaf_mean\tvmaf_p5\n' | tee "$OUT/vmaf.tsv"
for f in "$OUT"/*.mkv; do
  n=$(basename "$f" .mkv)
  rm -f "$OUT/$n.json"
  ~/.cache/enc-vmaf/ffmpeg -y -loglevel error -i "$f" -pix_fmt yuv420p -fps_mode passthrough "$OUT/dist.y4m"
  ~/.cache/enc-vmaf/ffmpeg -hide_banner -loglevel error -i "$OUT/dist.y4m" -i "$OUT/ref.y4m" \
    -lavfi "libvmaf=n_threads=16:log_fmt=json:log_path=$OUT/$n.json" -f null -
  rm -f "$OUT/dist.y4m"
  mean=$(jq '.pooled_metrics.vmaf.mean' "$OUT/$n.json")
  p5=$(jq '[.frames[].metrics.vmaf] | sort | .[(length*0.05|floor)]' "$OUT/$n.json")
  br=$(docker run --rm -v "$f:/f.mkv:ro" --entrypoint ffprobe "$IMG" -v error -show_entries format=bit_rate -of csv=p=0 /f.mkv)
  printf '%s\t%s\t%.2f\t%.2f\n' "$n" "$((br / 1000))" "$mean" "$p5" | tee -a "$OUT/vmaf.tsv"
done
rm -f "$OUT/ref.y4m"
