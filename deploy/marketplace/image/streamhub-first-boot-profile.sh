# StreamHub marketplace image — login hook (/etc/profile.d/streamhub-first-boot.sh).
# Until the first-boot setup is done, an interactive root login runs it (it asks
# for the domain + email and can be postponed with 'later'); other users get the
# sudo hint. POSIX sh: /etc/profile sources this for every login shell.
# STREAMHUB_FIRST_BOOT_SKIP=1 in the environment disables the prompt.
if [ ! -f /var/lib/streamhub/first-boot.done ] && [ -x /opt/streamhub/first-boot.sh ] \
   && [ -t 0 ] && [ -t 1 ] && [ -z "${STREAMHUB_FIRST_BOOT_SKIP:-}" ]; then
  if [ "$(id -u)" = "0" ]; then
    /opt/streamhub/first-boot.sh --login || true
  else
    echo "StreamHub is not configured yet — run:  sudo /opt/streamhub/first-boot.sh"
  fi
fi
