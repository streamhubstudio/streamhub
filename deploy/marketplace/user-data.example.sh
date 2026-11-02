#!/bin/bash
# StreamHub marketplace image — example user-data as a shell script (for
# providers whose UI only takes a script). The KEY=value lines below are also
# read as plain text by streamhub-first-boot.service, so either path works; this
# one simply runs the setup straight from cloud-init's script stage (the second
# run, if any, finds it done or locked and exits).
STREAMHUB_DOMAIN=media.example.com
STREAMHUB_ACME_EMAIL=admin@example.com
export STREAMHUB_DOMAIN STREAMHUB_ACME_EMAIL
/opt/streamhub/first-boot.sh --cloud-init >> /var/log/streamhub-first-boot.log 2>&1
