BINARY  := streamhub-agent
UPDATER_BINARY := streamhub-updater
VERSION := 1.14
UPDATER_VERSION := 1.0

# ── Platform detection ───────────────────────────────────────────
# Auto-detect host platform. Override with PLATFORM=windows|linux|macos
UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
PLATFORM := linux
ifneq (,$(findstring MINGW,$(UNAME_S)))
  PLATFORM := windows
endif
ifneq (,$(findstring MSYS,$(UNAME_S)))
  PLATFORM := windows
endif
ifneq (,$(findstring Windows,$(UNAME_S)))
  PLATFORM := windows
endif
ifneq (,$(findstring Darwin,$(UNAME_S)))
  PLATFORM := macos
endif

# ── Source files ──────────────────────────────────────────────────
SRC_COMMON := src/main.c \
              src/config.c \
              src/log.c \
              src/util.c \
              src/http.c \
              src/mqtt_client.c \
              src/s3.c \
              src/snapshot.c \
              src/recorder.c \
              src/stream.c \
              src/storage.c \
              src/api.c \
              src/sync.c \
              src/watchdog.c \
              src/webui.c \
              src/detect.c \
              src/detect_remote.c \
              src/detect_edge.c \
              src/onvif.c \
              src/fleet.c \
              vendor/cjson/cJSON.c

# Platform-specific source
ifeq ($(PLATFORM),windows)
  SRC := $(SRC_COMMON) src/platform_win32.c src/service_win32.c
else
  SRC := $(SRC_COMMON) src/platform_posix.c
endif

# ── Updater source files ─────────────────────────────────────────
SRC_UPDATER_COMMON := src/updater_main.c src/config.c src/log.c src/util.c \
                      src/http.c src/mqtt_client.c src/api.c vendor/cjson/cJSON.c

ifeq ($(PLATFORM),windows)
  SRC_UPDATER := $(SRC_UPDATER_COMMON) src/platform_win32.c src/updater_service_win32.c
  UPDATER_BINARY := streamhub-updater.exe
else
  SRC_UPDATER := $(SRC_UPDATER_COMMON) src/platform_posix.c
endif

# ── Compiler detection ────────────────────────────────────────────
# Set CROSS_COMPILE for cross-compilation:
#   make CROSS_COMPILE=arm-rockchip830-linux-uclibcgnueabihf-
CC      := $(CROSS_COMPILE)gcc
STRIP   := $(CROSS_COMPILE)strip

CFLAGS  := -Wall -Wextra -O2 -Wno-format-truncation \
           -DVERSION=\"$(VERSION)\" \
           -Isrc -Ivendor/cjson -Ivendor/mqtt

# Platform-specific flags
ifeq ($(PLATFORM),windows)
  LDFLAGS := -lssl -lcrypto -lws2_32 -lpthread -ladvapi32 -lcrypt32
  BINARY  := streamhub-agent.exe
  WINDRES := $(CROSS_COMPILE)windres
  RES_OBJ := build/streamhub.res.o
else ifeq ($(PLATFORM),macos)
  LDFLAGS := -lssl -lcrypto -lpthread
  # Homebrew OpenSSL paths (Apple doesn't ship OpenSSL headers)
  BREW_SSL := $(shell brew --prefix openssl 2>/dev/null)
  ifneq ($(BREW_SSL),)
    CFLAGS  += -I$(BREW_SSL)/include
    LDFLAGS := -L$(BREW_SSL)/lib $(LDFLAGS)
  endif
else
  LDFLAGS := -lssl -lcrypto -lpthread
endif

# Static build (for embedded deployment)
ifdef STATIC
  LDFLAGS += -static
endif

# ── Output directory ─────────────────────────────────────────────
OUTDIR := build
$(shell mkdir -p $(OUTDIR))

# ── Targets ───────────────────────────────────────────────────────
.PHONY: all clean info updater
.PHONY: build-luckfox build-linux-x64 build-windows-x64 build-all
.PHONY: build-updater-luckfox build-updater-linux-x64 build-updater-windows-x64
.PHONY: deploy deploy-www deploy-init deploy-all deploy-vpn run
.PHONY: deploy-windows setup-ffmpeg-windows setup-python-windows
.PHONY: deploy-updater deploy-updater-windows deploy-updater-init

all: $(BINARY)

ifeq ($(PLATFORM),windows)
$(RES_OBJ): res/streamhub.rc res/streamhub.ico
	$(WINDRES) res/streamhub.rc -O coff -o $(RES_OBJ)

$(BINARY): $(SRC) $(RES_OBJ)
	$(CC) $(CFLAGS) -o $@ $(SRC) $(RES_OBJ) $(LDFLAGS)
	$(STRIP) $@ 2>/dev/null || true
	@echo "Built $(BINARY) (platform=$(PLATFORM))"
else
$(BINARY): $(SRC)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)
	$(STRIP) $@ 2>/dev/null || true
	@echo "Built $(BINARY) (platform=$(PLATFORM))"
endif

# ── Updater local build ──────────────────────────────────────────
UPDATER_CFLAGS := $(CFLAGS) -DUPDATER_VERSION=\"$(UPDATER_VERSION)\"

updater: $(SRC_UPDATER)
	$(CC) $(UPDATER_CFLAGS) -o $(UPDATER_BINARY) $^ $(LDFLAGS)
	$(STRIP) $(UPDATER_BINARY) 2>/dev/null || true
	@echo "Built $(UPDATER_BINARY) (platform=$(PLATFORM))"

clean:
	rm -f $(BINARY) streamhub-agent streamhub-agent.exe streamhub-agent.exe
	rm -f streamhub-updater streamhub-updater.exe
	rm -rf $(OUTDIR)

info:
	@echo "PLATFORM  = $(PLATFORM)"
	@echo "CC        = $(CC)"
	@echo "CFLAGS    = $(CFLAGS)"
	@echo "LDFLAGS   = $(LDFLAGS)"
	@echo "SRC       = $(SRC)"
	@echo "BINARY    = $(BINARY)"

# ══════════════════════════════════════════════════════════════════
# Per-architecture Docker builds
# ══════════════════════════════════════════════════════════════════

# ── Luckfox Pico (ARM 32-bit, uclibc, dynamic) ──────────────────
LUCKFOX_TOOLCHAIN := /tmp/luckfox-toolchain
LUCKFOX_PREFIX    := arm-rockchip830-linux-uclibcgnueabihf-

build-luckfox:
	@echo "═══ Building for Luckfox Pico (ARM32 uclibc) ═══"
	docker run --rm --platform linux/amd64 \
		-v $(CURDIR):/build \
		-v $(LUCKFOX_TOOLCHAIN):/toolchain:ro \
		ubuntu:22.04 bash -c '\
		set -e && \
		export PATH=/toolchain/bin:$$PATH && \
		export CROSS=$(LUCKFOX_PREFIX) && \
		apt-get update -qq >/dev/null 2>&1 && \
		apt-get install -y -qq make perl wget >/dev/null 2>&1 && \
		cd /tmp && \
		wget -q https://github.com/openssl/openssl/releases/download/OpenSSL_1_1_1w/openssl-1.1.1w.tar.gz && \
		tar xf openssl-1.1.1w.tar.gz && \
		cd openssl-1.1.1w && \
		./Configure linux-armv4 --cross-compile-prefix=$$CROSS \
			--prefix=/tmp/openssl-arm shared no-tests \
			-DOPENSSL_SMALL_FOOTPRINT >/dev/null 2>&1 && \
		make -j$$(nproc) >/dev/null 2>&1 && \
		make install_sw >/dev/null 2>&1 && \
		make -C /build clean 2>/dev/null; \
		make -C /build \
			CROSS_COMPILE=$$CROSS \
			PLATFORM=linux \
			CFLAGS="-Wall -Wextra -O2 -Os -Wno-format-truncation \
				-DVERSION=\\\"$(VERSION)\\\" \
				-Isrc -Ivendor/cjson -Ivendor/mqtt \
				-I/tmp/openssl-arm/include" \
			LDFLAGS="-L/tmp/openssl-arm/lib -lssl -lcrypto -lpthread"'
	mkdir -p $(OUTDIR)/luckfox
	cp streamhub-agent $(OUTDIR)/luckfox/
	@echo "Output: $(OUTDIR)/luckfox/streamhub-agent"
	@ls -lh $(OUTDIR)/luckfox/streamhub-agent

# ── Linux x64 (glibc, dynamic) ──────────────────────────────────
build-linux-x64:
	@echo "═══ Building for Linux x64 ═══"
	docker run --rm --platform linux/amd64 \
		-v $(CURDIR):/build -w /build \
		gcc:13 bash -c '\
		make clean 2>/dev/null; \
		make PLATFORM=linux'
	mkdir -p $(OUTDIR)/linux-x64
	cp streamhub-agent $(OUTDIR)/linux-x64/
	@echo "Output: $(OUTDIR)/linux-x64/streamhub-agent"
	@ls -lh $(OUTDIR)/linux-x64/streamhub-agent

# ── Windows x64 (MinGW-w64, on Windows VM) ──────────────────────
# Override on the command line: make build-windows-x64 WIN_VM=user@host WIN_PASS=...
WIN_VM   ?= user@windows-build-vm
WIN_PASS ?=
WIN_DIR  ?= C:/Users/user/streamhub-agent
WIN_SSH  := sshpass -p '$(WIN_PASS)' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password
WIN_SCP  := sshpass -p '$(WIN_PASS)' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password

build-windows-x64:
	@echo "═══ Building for Windows x64 ═══"
	@echo "Syncing source to Windows VM..."
	-$(WIN_SSH) $(WIN_VM) \
		"if not exist \"$(WIN_DIR)\\res\" mkdir \"$(WIN_DIR)\\res\" & if not exist \"$(WIN_DIR)\\build\" mkdir \"$(WIN_DIR)\\build\""
	$(WIN_SCP) \
		src/*.c src/*.h $(WIN_VM):"$(WIN_DIR)/src/"
	$(WIN_SCP) \
		res/streamhub.rc res/streamhub.ico $(WIN_VM):"$(WIN_DIR)/res/"
	$(WIN_SCP) \
		Makefile $(WIN_VM):"$(WIN_DIR)/"
	@echo "Building on Windows VM..."
	$(WIN_SSH) $(WIN_VM) \
		"set PATH=C:\msys64\mingw64\bin;C:\msys64\usr\bin;%PATH% && \
		make -C $(WIN_DIR) clean && make -C $(WIN_DIR) PLATFORM=windows"
	mkdir -p $(OUTDIR)/windows-x64
	$(WIN_SCP) \
		$(WIN_VM):"$(WIN_DIR)/streamhub-agent.exe" $(OUTDIR)/windows-x64/
	@echo "Output: $(OUTDIR)/windows-x64/streamhub-agent.exe"
	@ls -lh $(OUTDIR)/windows-x64/streamhub-agent.exe

# ── Build ALL architectures ──────────────────────────────────────
build-all: build-luckfox build-linux-x64 build-windows-x64
	@echo ""
	@echo "═══ All builds complete ═══"
	@ls -lhR $(OUTDIR)/

# ══════════════════════════════════════════════════════════════════
# Updater builds (per-architecture)
# ══════════════════════════════════════════════════════════════════

build-updater-luckfox:
	@echo "═══ Building updater for Luckfox Pico (ARM32 uclibc) ═══"
	docker run --rm --platform linux/amd64 \
		-v $(CURDIR):/build \
		-v $(LUCKFOX_TOOLCHAIN):/toolchain:ro \
		ubuntu:22.04 bash -c '\
		set -e && \
		export PATH=/toolchain/bin:$$PATH && \
		export CROSS=$(LUCKFOX_PREFIX) && \
		apt-get update -qq >/dev/null 2>&1 && \
		apt-get install -y -qq make perl wget >/dev/null 2>&1 && \
		cd /tmp && \
		wget -q https://github.com/openssl/openssl/releases/download/OpenSSL_1_1_1w/openssl-1.1.1w.tar.gz && \
		tar xf openssl-1.1.1w.tar.gz && \
		cd openssl-1.1.1w && \
		./Configure linux-armv4 --cross-compile-prefix=$$CROSS \
			--prefix=/tmp/openssl-arm shared no-tests \
			-DOPENSSL_SMALL_FOOTPRINT >/dev/null 2>&1 && \
		make -j$$(nproc) >/dev/null 2>&1 && \
		make install_sw >/dev/null 2>&1 && \
		rm -f /build/streamhub-updater; \
		make -C /build updater \
			CROSS_COMPILE=$$CROSS \
			PLATFORM=linux \
			CFLAGS="-Wall -Wextra -O2 -Os -Wno-format-truncation \
				-DVERSION=\\\"$(VERSION)\\\" \
				-DUPDATER_VERSION=\\\"$(UPDATER_VERSION)\\\" \
				-Isrc -Ivendor/cjson -Ivendor/mqtt \
				-I/tmp/openssl-arm/include" \
			LDFLAGS="-L/tmp/openssl-arm/lib -lssl -lcrypto -lpthread"'
	mkdir -p $(OUTDIR)/luckfox
	cp streamhub-updater $(OUTDIR)/luckfox/
	@echo "Output: $(OUTDIR)/luckfox/streamhub-updater"
	@ls -lh $(OUTDIR)/luckfox/streamhub-updater

build-updater-linux-x64:
	@echo "═══ Building updater for Linux x64 ═══"
	docker run --rm --platform linux/amd64 \
		-v $(CURDIR):/build -w /build \
		gcc:13 bash -c '\
		rm -f streamhub-updater; \
		make updater PLATFORM=linux'
	mkdir -p $(OUTDIR)/linux-x64
	cp streamhub-updater $(OUTDIR)/linux-x64/
	@echo "Output: $(OUTDIR)/linux-x64/streamhub-updater"
	@ls -lh $(OUTDIR)/linux-x64/streamhub-updater

build-updater-windows-x64:
	@echo "═══ Building updater for Windows x64 ═══"
	@echo "Syncing source to Windows VM..."
	-$(WIN_SSH) $(WIN_VM) \
		"if not exist \"$(WIN_DIR)\\build\" mkdir \"$(WIN_DIR)\\build\""
	$(WIN_SCP) \
		src/*.c src/*.h $(WIN_VM):"$(WIN_DIR)/src/"
	$(WIN_SCP) \
		Makefile $(WIN_VM):"$(WIN_DIR)/"
	@echo "Building updater on Windows VM..."
	$(WIN_SSH) $(WIN_VM) \
		"set PATH=C:\msys64\mingw64\bin;C:\msys64\usr\bin;%PATH% && \
		del /Q $(WIN_DIR)\\streamhub-updater.exe 2>NUL & \
		make -C $(WIN_DIR) updater PLATFORM=windows"
	mkdir -p $(OUTDIR)/windows-x64
	$(WIN_SCP) \
		$(WIN_VM):"$(WIN_DIR)/streamhub-updater.exe" $(OUTDIR)/windows-x64/
	@echo "Output: $(OUTDIR)/windows-x64/streamhub-updater.exe"
	@ls -lh $(OUTDIR)/windows-x64/streamhub-updater.exe

# ══════════════════════════════════════════════════════════════════
# Deployment targets
# ══════════════════════════════════════════════════════════════════

# ── Deploy to Luckfox ─────────────────────────────────────────────
# Override on the command line: make deploy DEVICE=root@<board-ip>
DEVICE     ?= root@luckfox.local
DEVICE_PASS ?= luckfox
DEPLOY_DIR := /userdata/streamhub

deploy:
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"mkdir -p $(DEPLOY_DIR)"
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"killall streamhub-agent 2>/dev/null; true"
	sshpass -p $(DEVICE_PASS) scp -o StrictHostKeyChecking=no \
		$(OUTDIR)/luckfox/streamhub-agent $(DEVICE):$(DEPLOY_DIR)/
	@echo "Deployed to $(DEVICE):$(DEPLOY_DIR)"

deploy-www:
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"mkdir -p /mnt/sdcard/www"
	sshpass -p $(DEVICE_PASS) scp -o StrictHostKeyChecking=no \
		www/* $(DEVICE):/mnt/sdcard/www/
	@echo "Deployed www/ to $(DEVICE):/mnt/sdcard/www/"

deploy-init:
	sshpass -p $(DEVICE_PASS) scp -o StrictHostKeyChecking=no \
		etc/S95streamhub $(DEVICE):/etc/init.d/S95streamhub
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"chmod +x /etc/init.d/S95streamhub"
	@echo "Deployed init script"

# ── Deploy VPN client ──────────────────────────────────────────────
deploy-vpn:
	sshpass -p luckfox scp -o StrictHostKeyChecking=no \
		etc/setup-vpn.sh $(DEVICE):/tmp/setup-vpn.sh
	sshpass -p luckfox ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"sh /tmp/setup-vpn.sh"
	sshpass -p luckfox scp -o StrictHostKeyChecking=no \
		etc/S90netbird $(DEVICE):/etc/init.d/S90netbird
	sshpass -p luckfox ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"chmod +x /etc/init.d/S90netbird"
	@echo "Deployed VPN client to $(DEVICE)"

deploy-all: deploy deploy-www deploy-init

# ── Deploy updater to Luckfox ────────────────────────────────────
deploy-updater:
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"mkdir -p $(DEPLOY_DIR)"
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"killall streamhub-updater 2>/dev/null; true"
	sshpass -p $(DEVICE_PASS) scp -o StrictHostKeyChecking=no \
		$(OUTDIR)/luckfox/streamhub-updater $(DEVICE):$(DEPLOY_DIR)/
	@echo "Deployed updater to $(DEVICE):$(DEPLOY_DIR)"

deploy-updater-init:
	sshpass -p $(DEVICE_PASS) scp -o StrictHostKeyChecking=no \
		etc/S94streamhub-updater $(DEVICE):/etc/init.d/S94streamhub-updater
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"chmod +x /etc/init.d/S94streamhub-updater"
	@echo "Deployed updater init script"

# ── Deploy to Windows VM ─────────────────────────────────────────
deploy-windows:
	@echo "Deploying to Windows VM..."
	-$(WIN_SSH) $(WIN_VM) \
		"if not exist \"$(WIN_DIR)\\www\" mkdir \"$(WIN_DIR)\\www\" & if not exist \"$(WIN_DIR)\\scripts\" mkdir \"$(WIN_DIR)\\scripts\""
	$(WIN_SCP) \
		$(OUTDIR)/windows-x64/streamhub-agent.exe \
		$(WIN_VM):"$(WIN_DIR)/streamhub-agent.exe"
	$(WIN_SCP) \
		www/* $(WIN_VM):"$(WIN_DIR)/www/"
	$(WIN_SCP) \
		config.yml secrets.ini $(WIN_VM):"$(WIN_DIR)/"
	$(WIN_SCP) \
		scripts/*.bat scripts/detect.py scripts/requirements.txt \
		$(WIN_VM):"$(WIN_DIR)/scripts/"
	@echo "Deployed to $(WIN_VM):$(WIN_DIR)"

# ── Deploy updater to Windows VM ─────────────────────────────────
deploy-updater-windows:
	@echo "Deploying updater to Windows VM..."
	-$(WIN_SSH) $(WIN_VM) \
		"if not exist \"$(WIN_DIR)\\scripts\" mkdir \"$(WIN_DIR)\\scripts\""
	$(WIN_SCP) \
		$(OUTDIR)/windows-x64/streamhub-updater.exe \
		$(WIN_VM):"$(WIN_DIR)/streamhub-updater.exe"
	$(WIN_SCP) \
		scripts/install-updater.bat scripts/uninstall-updater.bat \
		$(WIN_VM):"$(WIN_DIR)/scripts/"
	@echo "Deployed updater to $(WIN_VM):$(WIN_DIR)"

# ── Setup ffmpeg on Windows VM ────────────────────────────────────
FFMPEG_WIN_URL := https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip

setup-ffmpeg-windows:
	@echo "Downloading and extracting ffmpeg to Windows VM..."
	$(WIN_SSH) $(WIN_VM) \
		"cd $(WIN_DIR) && \
		if not exist ffmpeg.exe ( \
			curl -L -o ffmpeg.zip $(FFMPEG_WIN_URL) && \
			powershell -Command \"Expand-Archive -Force ffmpeg.zip ffmpeg-tmp\" && \
			copy ffmpeg-tmp\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe . && \
			rmdir /S /Q ffmpeg-tmp && del ffmpeg.zip && \
			echo ffmpeg.exe installed \
		) else ( echo ffmpeg.exe already exists )"

# ── Setup portable Python on Windows VM (EDGE mode only) ──────────
# Only needed for on-device inference (detect.mode: edge). Remote/off modes
# never spawn the Python worker and need none of these deps.
setup-python-windows:
	@echo "Setting up portable Python on Windows VM..."
	$(WIN_SSH) $(WIN_VM) \
		"cd $(WIN_DIR) && if not exist python\\python.exe ( \
			powershell -Command \"Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip' -OutFile python.zip; \
			Expand-Archive python.zip -DestinationPath python -Force; Remove-Item python.zip; \
			(Get-Content python\\python312._pth) -replace '#import site','import site' | Set-Content python\\python312._pth; \
			Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile get-pip.py\" && \
			python\\python.exe get-pip.py && del get-pip.py && \
			python\\python.exe -m pip install ultralytics opencv-python-headless \
		) else ( echo Python already installed )"

# ── Run on Luckfox ────────────────────────────────────────────────
run:
	sshpass -p $(DEVICE_PASS) ssh -o StrictHostKeyChecking=no $(DEVICE) \
		"cd $(DEPLOY_DIR) && ./streamhub-agent config.yml secrets.ini"
