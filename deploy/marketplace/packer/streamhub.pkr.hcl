# =============================================================================
# StreamHub marketplace images — one Packer (HCL2) template, four clouds.
#
#   cd deploy/marketplace/packer
#   packer init .
#   packer validate .
#   packer build -only='streamhub.digitalocean.streamhub' .      # DO snapshot
#   packer build -only='streamhub.vultr.streamhub' .             # Vultr snapshot
#   packer build -only='streamhub.hcloud.streamhub' .            # Hetzner snapshot
#   packer build -only='streamhub.amazon-ebs.streamhub' .        # AWS AMI
#
# Every builder boots a stock Ubuntu 24.04 LTS x64, then runs the SAME
# provisioners: apt upgrade → `install.sh --prepare-image` (Docker + source +
# pre-pulled images + pre-built core, NO secrets/domain/.env, nothing started)
# → first-boot wiring (cloud-init unit, MOTD, login prompt) → ufw → the
# DigitalOcean-style cleanup (90-cleanup.sh) and image check (99-img-check.sh,
# fails the build on a dirty image).
#
# Credentials come from the usual env vars (DIGITALOCEAN_TOKEN, VULTR_API_KEY,
# HCLOUD_TOKEN, AWS_* / AWS_PROFILE) or -var flags; see example.pkrvars.hcl and
# streamhub-docs/operations/MARKETPLACE.md.
# =============================================================================

packer {
  required_version = ">= 1.10.0"
  required_plugins {
    digitalocean = {
      version = "~> 1.4"
      source  = "github.com/digitalocean/digitalocean"
    }
    vultr = {
      version = "~> 2.5"
      source  = "github.com/vultr/vultr"
    }
    hcloud = {
      version = "~> 1.6"
      source  = "github.com/hetznercloud/hcloud"
    }
    amazon = {
      version = "~> 1.3"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

# ---- what goes into the image ------------------------------------------------

variable "streamhub_version" {
  type        = string
  default     = ""
  description = "Label for the snapshot/AMI name. Empty = the repo's VERSION file. The installed version is whatever the source below carries."
}

variable "src_url" {
  type        = string
  default     = "https://www.streamhub.studio/streamhub-src.tar.gz"
  description = "Source tarball the installer mirrors into /opt/streamhub (STREAMHUB_SRC_URL). Any curl URL works, e.g. a release tarball from deploy/make-release-artifact.sh served over https."
}

variable "repo_url" {
  type        = string
  default     = "file:///nonexistent"
  description = "Git URL tried BEFORE the tarball (STREAMHUB_REPO_URL). The default is unreachable on purpose so images are built from the published release tarball, not a moving branch."
}

variable "proxy" {
  type        = string
  default     = "caddy"
  description = "Reverse proxy baked as the default for first boot: caddy (auto-TLS that retries until DNS resolves, no host packages) or nginx (+certbot; required for TURN)."
  validation {
    condition     = contains(["caddy", "nginx"], var.proxy)
    error_message = "The proxy must be caddy or nginx."
  }
}

variable "enable_ufw" {
  type        = bool
  default     = true
  description = "Enable ufw with only SSH + the StreamHub public ports (DO/Vultr checklists expect a host firewall)."
}

variable "zero_free_space" {
  type        = bool
  default     = true
  description = "Zero the free disk space before the snapshot (smaller, faster-to-copy images)."
}

# ---- DigitalOcean ---------------------------------------------------------------

variable "do_token" {
  type      = string
  default   = env("DIGITALOCEAN_TOKEN")
  sensitive = true
}
variable "do_region" {
  type    = string
  default = "nyc3"
}
variable "do_size" {
  type        = string
  default     = "s-2vcpu-4gb"
  description = "Build droplet size. The snapshot then fits every size with a disk >= this one's (DO checklist: build on the smallest size you list)."
}
variable "do_image" {
  type    = string
  default = "ubuntu-24-04-x64"
}
variable "do_snapshot_regions" {
  type    = list(string)
  default = []
}

# ---- Vultr ----------------------------------------------------------------------

variable "vultr_api_key" {
  type      = string
  default   = env("VULTR_API_KEY")
  sensitive = true
}
variable "vultr_region" {
  type    = string
  default = "ewr"
}
variable "vultr_plan" {
  type    = string
  default = "vc2-2c-4gb"
}
variable "vultr_os_id" {
  type        = number
  default     = 2284
  description = "Vultr OS id of Ubuntu 24.04 LTS x64 (GET https://api.vultr.com/v2/os)."
}

# ---- Hetzner Cloud --------------------------------------------------------------

variable "hcloud_token" {
  type      = string
  default   = env("HCLOUD_TOKEN")
  sensitive = true
}
variable "hcloud_location" {
  type    = string
  default = "fsn1"
}
variable "hcloud_server_type" {
  type    = string
  default = "cx22"
}
variable "hcloud_image" {
  type    = string
  default = "ubuntu-24.04"
}

# ---- AWS (AMI) ------------------------------------------------------------------

variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "aws_instance_type" {
  type    = string
  default = "t3.medium"
}
variable "aws_volume_size" {
  type        = number
  default     = 30
  description = "Root volume (GiB) of the build instance = minimum root size of the AMI."
}
variable "aws_ami_regions" {
  type        = list(string)
  default     = []
  description = "Extra regions to copy the AMI to."
}
variable "aws_ami_groups" {
  type        = list(string)
  default     = []
  description = "[\"all\"] makes the AMI public. Leave empty for private (AWS Marketplace ingests a private AMI shared with its account)."
}

locals {
  version  = var.streamhub_version != "" ? var.streamhub_version : trimspace(file("${path.root}/../../../VERSION"))
  stamp    = formatdate("YYYYMMDDhhmm", timestamp())
  name     = "streamhub-${replace(local.version, ".", "-")}-${local.stamp}"
  repo     = "${path.root}/../../.."
  sudo_cmd = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E bash '{{ .Path }}'"
}

source "digitalocean" "streamhub" {
  api_token        = var.do_token
  image            = var.do_image
  region           = var.do_region
  size             = var.do_size
  ssh_username     = "root"
  droplet_name     = "packer-${local.name}"
  snapshot_name    = local.name
  snapshot_regions = var.do_snapshot_regions
  tags             = ["streamhub", "packer"]
}

source "vultr" "streamhub" {
  api_key              = var.vultr_api_key
  os_id                = var.vultr_os_id
  plan_id              = var.vultr_plan
  region_id            = var.vultr_region
  snapshot_description = local.name
  ssh_username         = "root"
  state_timeout        = "30m"
}

source "hcloud" "streamhub" {
  token         = var.hcloud_token
  image         = var.hcloud_image
  location      = var.hcloud_location
  server_type   = var.hcloud_server_type
  server_name   = "packer-${local.name}"
  snapshot_name = local.name
  snapshot_labels = {
    app     = "streamhub"
    version = replace(local.version, ".", "-")
  }
  ssh_username = "root"
}

source "amazon-ebs" "streamhub" {
  region        = var.aws_region
  instance_type = var.aws_instance_type
  ssh_username  = "ubuntu"
  ami_name      = local.name
  ami_regions   = var.aws_ami_regions
  ami_groups    = var.aws_ami_groups
  ami_description = "StreamHub ${local.version} — self-hosted media server (LiveKit SFU + RTMP/WHIP/HLS + dashboard) on Ubuntu 24.04 LTS"
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = var.aws_volume_size
    volume_type           = "gp3"
    delete_on_termination = true
  }
  tags = {
    Name    = local.name
    app     = "streamhub"
    version = local.version
  }
}

build {
  name = "streamhub"
  sources = [
    "source.digitalocean.streamhub",
    "source.vultr.streamhub",
    "source.hcloud.streamhub",
    "source.amazon-ebs.streamhub",
  ]

  # 1. base: wait for cloud-init, full apt upgrade (no pending security updates)
  provisioner "shell" {
    execute_command = local.sudo_cmd
    script          = "${path.root}/scripts/00-base.sh"
  }

  # 2. the installer + the first-boot files from THIS checkout
  provisioner "file" {
    source      = "${local.repo}/install.sh"
    destination = "/tmp/streamhub-install.sh"
  }
  provisioner "file" {
    source      = "${path.root}/../first-boot.sh"
    destination = "/tmp/streamhub-first-boot.sh"
  }
  provisioner "file" {
    # no trailing slash: Packer creates /tmp/image itself (works for root and ubuntu)
    source      = "${path.root}/../image"
    destination = "/tmp"
  }

  # 3. install.sh --prepare-image: deps + source + pre-pulled images + core build
  provisioner "shell" {
    execute_command = local.sudo_cmd
    environment_vars = [
      "STREAMHUB_PROXY=${var.proxy}",
      "STREAMHUB_SRC_URL=${var.src_url}",
      "STREAMHUB_REPO_URL=${var.repo_url}",
      # install-ping channel of every server booted from this image
      # (marketplace-digitalocean / -vultr / -hcloud / -amazon-ebs)
      "STREAMHUB_IMAGE_CHANNEL=marketplace-${source.type}",
    ]
    script = "${path.root}/scripts/10-prepare-image.sh"
  }

  # 4. first-boot wiring + firewall
  provisioner "shell" {
    execute_command  = local.sudo_cmd
    environment_vars = ["ENABLE_UFW=${var.enable_ufw ? "1" : "0"}"]
    scripts = [
      "${path.root}/scripts/20-first-boot.sh",
      "${path.root}/scripts/30-firewall.sh",
    ]
  }

  # 5. marketplace cleanup + image check (LAST: they drop the SSH keys)
  provisioner "shell" {
    execute_command  = local.sudo_cmd
    environment_vars = ["ZERO_FREE_SPACE=${var.zero_free_space ? "1" : "0"}"]
    scripts = [
      "${path.root}/scripts/90-cleanup.sh",
      "${path.root}/scripts/99-img-check.sh",
    ]
  }

  post-processor "manifest" {
    output     = "${path.root}/packer-manifest.json"
    strip_path = true
    custom_data = {
      streamhub_version = local.version
      proxy             = var.proxy
    }
  }
}
