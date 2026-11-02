# Per-channel soak evaluation over the unquoted soak CSV (-v c=<channel>).
# Prints one line of key=value tokens for suites/soak.sh.
NR > 1 && $2 == c {
  n++; t[n] = $1 + 0; st[n] = $3; fps[n] = $4 + 0; dr[n] = $7 + 0
  cc[n] = $6; er[n] = $8; sl[n] = $9; rss[n] = $10 + 0; fd[n] = $12 + 0; orr[n] = $13
  if (lt == "" && $3 == "live") lt = $1 + 0
}
END {
  if (lt == "") { print "live=never"; exit }
  tl = t[n]; fs = 0; fk = 0
  for (i = 1; i <= n; i++) {
    if (t[i] >= lt + 60) {
      if (fm == "" || fps[i] < fm) fm = fps[i]
      fs += fps[i]; fk++; v[fk] = fps[i]
      if (dmn == "" || dr[i] < dmn) dmn = dr[i]
      if (dmx == "" || dr[i] > dmx) dmx = dr[i]
    }
    if (t[i] >= lt + 300 && t[i] < lt + 900) { b += rss[i]; nb++; if (fd0 == "") fd0 = fd[i] }
    if (t[i] >= tl - 600) { e += rss[i]; ne++ }
    if (t[i] >= lt + 300) { x = t[i] / 3600; sx += x; sy += rss[i]; sxx += x * x; sxy += x * rss[i]; ns++ }
  }
  # median fps (insertion sort: mawk has no asort)
  for (i = 2; i <= fk; i++) { k = v[i]; j = i - 1; while (j > 0 && v[j] > k) { v[j + 1] = v[j]; j-- } v[j + 1] = k }
  med = v[int((fk + 1) / 2)]
  slope = (ns > 2 && ns * sxx - sx * sx > 0) ? (ns * sxy - sx * sy) / (ns * sxx - sx * sx) : 0
  printf "live=%d state=%s fps_min=%s fps_avg=%.2f fps_med=%s drift_ms=%s..%s cc=%s engine_restarts=%s stalls=%s out_restarts=%s rss_base=%.0f rss_end=%.0f rss_slope_mb_h=%.0f fds_base=%s fds_end=%s\n",
    lt, st[n], fm, (fk ? fs / fk : 0), med, dmn, dmx, cc[n], er[n], sl[n], orr[n], (nb ? b / nb : 0), (ne ? e / ne : 0), slope, fd0, fd[n]
}
