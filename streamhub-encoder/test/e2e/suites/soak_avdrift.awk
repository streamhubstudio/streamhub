# A/V drift from `ffprobe -show_entries packet=stream_index,pts_time -of csv=p=0`
# (-v vi=<video stream index>). For every packet, audio PTS − video PTS of the
# latest packet of each stream (the mux interleave offset). A single sample
# jumps by tens of ms around large I-frames, so the file is cut into 24 windows
# and the per-window MEAN is compared: drift = max − min of those means.
# Prints "<drift frames @25fps> offset_mean=min..max ms window_means_spread=… audio_content=…".
NF >= 2 && $2 != "" {
  if ($1 == vi) { vv = $2; nv++ } else { a = $2; na++; if (af == "") af = $2; al = $2 }
  if (vv != "" && a != "") { k++; off[k] = a - vv }
}
END {
  W = 24; size = int(k / W); if (size < 1) size = 1
  for (i = 1; i <= k; i++) { w = int((i - 1) / size); if (w >= W) w = W - 1; s[w] += off[i]; n[w]++ }
  for (w = 0; w < W; w++) {
    if (!n[w]) continue
    m = s[w] / n[w]
    if (mn == "" || m < mn) mn = m
    if (mx == "" || m > mx) mx = m
  }
  printf "%.2f offset_window_means=%.1f..%.1fms windows=%d audio_content=%.3fs audio_pts_span=%.3fs video_frames=%d\n",
    (mx - mn) * 25, mn * 1000, mx * 1000, W, na * 1024 / 48000, al - af + 1024 / 48000, nv
}
