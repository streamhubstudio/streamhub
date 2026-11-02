# Example variables — copy to local.pkrvars.hcl (gitignored) and pass it with
#   packer build -var-file=local.pkrvars.hcl -only='streamhub.digitalocean.streamhub' .
# Tokens are better left to the environment: DIGITALOCEAN_TOKEN, VULTR_API_KEY,
# HCLOUD_TOKEN, and the standard AWS chain (AWS_PROFILE / AWS_ACCESS_KEY_ID …).

# What gets baked
# streamhub_version = "3.4.0"                       # label only; default = repo VERSION
# src_url           = "https://www.streamhub.studio/streamhub-src.tar.gz"
proxy             = "caddy"                        # or "nginx" (needed for TURN)
enable_ufw        = true
zero_free_space   = true

# DigitalOcean — build on the SMALLEST size you'll list (the snapshot's disk is the minimum)
do_region           = "nyc3"
do_size             = "s-2vcpu-4gb"
do_snapshot_regions = ["nyc3", "ams3", "fra1", "sfo3", "sgp1"]

# Vultr
vultr_region = "ewr"
vultr_plan   = "vc2-2c-4gb"
vultr_os_id  = 2284        # Ubuntu 24.04 LTS x64

# Hetzner Cloud
hcloud_location    = "fsn1"
hcloud_server_type = "cx22"

# AWS
aws_region        = "us-east-1"
aws_instance_type = "t3.medium"
aws_volume_size   = 30
aws_ami_regions   = []     # e.g. ["eu-west-1", "sa-east-1"]
aws_ami_groups    = []     # ["all"] = public AMI
