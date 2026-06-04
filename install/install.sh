#!/usr/bin/env bash
# Jarvis - Linux / macOS Terminal Installer
# Usage:    curl -fsSL https://jarvis.app/install.sh | bash
# Or:       curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.sh | bash
# GitHub:   wget -qO- https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.sh | bash
#
# Optional environment variables:
#   JARVIS_VERSION="0.1.17"    pin to a version (default: latest published GitHub release)
#   JARVIS_CHANNEL="stable"    stable | nightly (default: stable)
#   JARVIS_FORMAT=""           linux: deb | rpm | appimage  (auto-detected if blank)
#                              macOS: dmg (the only option)
#   JARVIS_PREFIX="/usr/local" install prefix (default: /usr/local on Linux)
#   JARVIS_LOCAL="1"           install from a local Jarvis build (developer mode)
#   JARVIS_DRYRUN="1"          download + verify only, do not install

set -euo pipefail

# --- Constants ----------------------------------------------------------------
JARVIS_REPO="Cookie774-GameDev/Jarivs-One"
JARVIS_API="https://api.github.com/repos/${JARVIS_REPO}/releases"
JARVIS_DL="https://github.com/${JARVIS_REPO}/releases/download"

# --- Color helpers ------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  CYAN="\033[38;5;51m"
  VIOLET="\033[38;5;141m"
  GREEN="\033[38;5;42m"
  YELLOW="\033[38;5;220m"
  RED="\033[38;5;203m"
  DIM="\033[2m"
  RESET="\033[0m"
else
  CYAN=""; VIOLET=""; GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi

banner() {
  printf "\n"
  printf "%b\n" "${CYAN}------------------------------------------------------------${RESET}"
  printf "%b\n" "${CYAN}      _                   _      ${RESET}"
  printf "%b\n" "${CYAN}     | | __ _ _ ____   _(_)___  ${VIOLET}  the AI workspace${RESET}"
  printf "%b\n" "${CYAN}  _  | |/ _\` | '__\\ \\ / / / __| ${VIOLET}  for every model,${RESET}"
  printf "%b\n" "${CYAN} | |_| | (_| | |   \\ V /| \\__ \\ ${VIOLET}  agent, voice & task${RESET}"
  printf "%b\n" "${CYAN}  \\___/ \\__,_|_|    \\_/ |_|___/ ${RESET}"
  printf "%b\n" "${DIM}                                  https://github.com/${JARVIS_REPO}${RESET}"
  printf "%b\n\n" "${CYAN}------------------------------------------------------------${RESET}"
}

step() { printf "  ${CYAN}->${RESET}  %s\n" "$1"; }
ok()   { printf "  ${GREEN}OK${RESET}  %s\n" "$1"; }
warn() { printf "  ${YELLOW}!!${RESET}  %s\n" "$1" >&2; }
fail() { printf "  ${RED}XX${RESET}  %s\n" "$1" >&2; }

# --- Detection ---------------------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*)
      fail "Detected Windows. Please use the PowerShell installer:"
      printf "    ${CYAN}irm https://raw.githubusercontent.com/${JARVIS_REPO}/main/install/install.ps1 | iex${RESET}\n"
      exit 1
      ;;
    *) fail "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x86_64" ;;
    aarch64|arm64) echo "aarch64" ;;
    *) fail "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
}

detect_linux_format() {
  # Prefer native package manager if available, else AppImage.
  if command -v dpkg >/dev/null 2>&1 && command -v apt >/dev/null 2>&1; then
    echo "deb"
  elif command -v rpm >/dev/null 2>&1 && (command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1); then
    echo "rpm"
  else
    echo "appimage"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
    case "$1" in
      curl)  warn "Install with: sudo apt install curl   (or your distro equivalent)" ;;
      sudo)  warn "Some installs need sudo. Re-run as root or install sudo." ;;
    esac
    exit 1
  fi
}

# --- Latest version ----------------------------------------------------------
get_latest_version() {
  if [ -n "${JARVIS_VERSION:-}" ]; then
    printf "%s" "$JARVIS_VERSION"
    return
  fi
  step "Checking GitHub for the latest release..." >&2
  local tag
  tag=$(curl -fsSL "${JARVIS_API}/latest" 2>/dev/null \
        | grep -o '"tag_name":[[:space:]]*"v\?[^"]*"' \
        | head -n1 \
        | sed -E 's/.*"v?([^"]+)".*/\1/' || true)
  if [ -n "$tag" ]; then
    ok "Latest version: $tag" >&2
    printf "%s" "$tag"
  else
    local effective
    effective=$(curl -Ls -o /dev/null -w '%{url_effective}' "https://github.com/${JARVIS_REPO}/releases/latest" 2>/dev/null || true)
    tag=$(printf "%s" "$effective" | sed -nE 's#.*/releases/tag/v?([^/[:space:]]+)$#\1#p')
    if [ -n "$tag" ]; then
      ok "Latest version: $tag" >&2
      printf "%s" "$tag"
    else
      fail "No published Jarvis One GitHub Release was found. Publish a release with installer assets, or set JARVIS_VERSION/JARVIS_LOCAL for controlled testing."
      exit 1
    fi
  fi
}

# --- Download URLs -----------------------------------------------------------
asset_pattern() {
  local os="$1" arch="$2" format="$3"
  case "$os/$format" in
    linux/deb)      printf '(^|/).*(jarvis|Jarvis)(%20One|[-_ ]?One)?.*(amd64|x86_64).*\.deb$' ;;
    linux/rpm)      printf '(^|/).*(jarvis|Jarvis)(%20One|[-_ ]?One)?.*(x86_64|amd64).*\.rpm$' ;;
    linux/appimage) printf '(^|/).*(jarvis|Jarvis)(%20One|[-_ ]?One)?.*(amd64|x86_64).*\.AppImage$' ;;
    macos/dmg)
      if [ "$arch" = "aarch64" ]; then
        printf '(^|/).*(Jarvis|jarvis)(%20One|[-_ ]?One)?.*(aarch64|arm64).*\.dmg$'
      else
        printf '(^|/).*(Jarvis|jarvis)(%20One|[-_ ]?One)?.*(x64|x86_64|amd64).*\.dmg$'
      fi
      ;;
    *) return 1 ;;
  esac
}

download_url() {
  local version="$1" os="$2" arch="$3" format="$4"
  case "$os/$format" in
    linux/deb)      printf "%s/v%s/Jarvis%%20One_%s_amd64.deb" "$JARVIS_DL" "$version" "$version" ;;
    linux/rpm)      printf "%s/v%s/Jarvis%%20One-%s-1.x86_64.rpm" "$JARVIS_DL" "$version" "$version" ;;
    linux/appimage) printf "%s/v%s/Jarvis%%20One_%s_amd64.AppImage" "$JARVIS_DL" "$version" "$version" ;;
    macos/dmg)
      if [ "$arch" = "aarch64" ]; then
        printf "%s/v%s/Jarvis%%20One_%s_aarch64.dmg" "$JARVIS_DL" "$version" "$version"
      else
        printf "%s/v%s/Jarvis%%20One_%s_x64.dmg" "$JARVIS_DL" "$version" "$version"
      fi
      ;;
    *) fail "No installer for ${os}/${format}"; exit 1 ;;
  esac
}

resolve_download_url() {
  local version="$1" os="$2" arch="$3" format="$4"
  local pattern
  pattern="$(asset_pattern "$os" "$arch" "$format" || true)"
  if [ -n "$pattern" ]; then
    local api_url="${JARVIS_API}/tags/v${version}"
    local asset
    asset=$(curl -fsSL "$api_url" 2>/dev/null \
      | grep -o '"browser_download_url":[[:space:]]*"[^"]*"' \
      | sed -E 's/.*"browser_download_url":[[:space:]]*"([^"]*)".*/\1/' \
      | grep -Ei "$pattern" \
      | head -n1 || true)
    if [ -n "$asset" ]; then
      printf "%s" "$asset"
      return
    fi
  fi
  download_url "$version" "$os" "$arch" "$format"
}

# --- Install actions ---------------------------------------------------------
install_deb() {
  local file="$1"
  step "Installing .deb (sudo required)..."
  sudo apt install -y "$file" || sudo dpkg -i "$file" || {
    fail "dpkg failed. Trying to fix dependencies..."
    sudo apt-get install -fy
  }
}

install_rpm() {
  local file="$1"
  step "Installing .rpm (sudo required)..."
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "$file"
  else
    sudo yum install -y "$file"
  fi
}

install_appimage() {
  local file="$1"
  local prefix="${JARVIS_PREFIX:-/usr/local}"
  local target="${prefix}/bin/jarvis"
  step "Installing AppImage to ${target}..."
  sudo install -m 0755 "$file" "$target"

  # Desktop entry for menu integration
  local desktop="${HOME}/.local/share/applications/jarvis.desktop"
  mkdir -p "$(dirname "$desktop")"
  cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Jarvis One
Comment=The AI workspace for every model, agent, voice and task
Exec=jarvis %U
Icon=jarvis
Terminal=false
Categories=Office;Utility;
StartupWMClass=jarvis
EOF
  ok "Desktop entry: $desktop"
}

install_dmg() {
  local file="$1"
  step "Mounting DMG..."
  local mountpoint
  mountpoint=$(hdiutil attach -nobrowse -noautoopen -readonly "$file" \
    | tail -n1 | awk '{print $NF}')
  if [ -z "$mountpoint" ] || [ ! -d "$mountpoint" ]; then
    fail "Failed to mount $file"
    exit 1
  fi
  local app
  app=$(find "$mountpoint" -maxdepth 1 -name "*.app" | head -n1)
  if [ -z "$app" ]; then
    hdiutil detach "$mountpoint" -force >/dev/null 2>&1 || true
    fail "No .app found inside DMG"
    exit 1
  fi
  step "Copying to /Applications..."
  sudo cp -R "$app" /Applications/
  hdiutil detach "$mountpoint" -force >/dev/null 2>&1 || true
  step "Removing macOS quarantine flag..."
  sudo xattr -dr com.apple.quarantine "/Applications/$(basename "$app")" || true
  ok "Installed: /Applications/$(basename "$app")"
  warn "First launch: Right-click Jarvis One in Finder -> Open if Gatekeeper prompts."
  warn "After the first 'Open', macOS remembers the trust for future updates."
}

launch_linux_app() {
  local runner=""
  if command -v jarvis >/dev/null 2>&1; then
    runner="jarvis"
  elif command -v jarvis-one >/dev/null 2>&1; then
    runner="jarvis-one"
  fi

  if [ -n "$runner" ]; then
    if [ -n "${SUDO_USER:-}" ]; then
      sudo -u "$SUDO_USER" nohup "$runner" >/dev/null 2>&1 &
    else
      nohup "$runner" >/dev/null 2>&1 &
    fi
    return 0
  fi

  if command -v gtk-launch >/dev/null 2>&1; then
    if [ -n "${SUDO_USER:-}" ]; then
      sudo -u "$SUDO_USER" gtk-launch jarvis.desktop >/dev/null 2>&1 || \
      sudo -u "$SUDO_USER" gtk-launch "Jarvis One" >/dev/null 2>&1 || true
    else
      gtk-launch jarvis.desktop >/dev/null 2>&1 || \
      gtk-launch "Jarvis One" >/dev/null 2>&1 || true
    fi
    return 0
  fi

  warn "Installed successfully, but no launcher command was found. Open Jarvis One from your apps menu."
  return 0
}

# --- Local build ---------------------------------------------------------
get_local_installer() {
  local os="$1" format="$2"
  local base
  case "$os" in
    linux) base="$HOME/projects/Jarvis/app/src-tauri/target/release/bundle" ;;
    macos) base="$HOME/projects/Jarvis/app/src-tauri/target/release/bundle" ;;
    *) fail "Local install not supported on $os"; exit 1 ;;
  esac
  case "$format" in
    deb)      find "$base/deb"      \( -name 'Jarvis One_*_amd64.deb' -o -name 'Jarvis-One-*.deb' -o -name 'jarvis_*_amd64.deb' \) 2>/dev/null | head -n1 ;;
    rpm)      find "$base/rpm"      \( -name 'Jarvis One-*.x86_64.rpm' -o -name 'Jarvis-One-*.rpm' -o -name 'jarvis-*.x86_64.rpm' \) 2>/dev/null | head -n1 ;;
    appimage) find "$base/appimage" \( -name 'Jarvis One_*_amd64.AppImage' -o -name 'Jarvis-One-*.AppImage' -o -name 'jarvis_*_amd64.AppImage' \) 2>/dev/null | head -n1 ;;
    dmg)      find "$base/dmg"      \( -name 'Jarvis One_*.dmg' -o -name 'Jarvis-One-*.dmg' -o -name 'Jarvis_*.dmg' \) 2>/dev/null | head -n1 ;;
  esac
}

# --- Main --------------------------------------------------------------------
banner

require_cmd curl
require_cmd uname

OS="$(detect_os)"
ARCH="$(detect_arch)"

if [ -n "${JARVIS_FORMAT:-}" ]; then
  FORMAT="$JARVIS_FORMAT"
else
  if [ "$OS" = "linux" ]; then
    FORMAT="$(detect_linux_format)"
  else
    FORMAT="dmg"
  fi
fi

step "OS:        $OS"
step "Arch:      $ARCH"
step "Format:    $FORMAT"
step "Prefix:    ${JARVIS_PREFIX:-/usr/local}"

# Pick installer
TMP_DIR="$(mktemp -d -t jarvis-installer.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
INSTALLER=""

if [ "${JARVIS_LOCAL:-0}" = "1" ]; then
  step "Using LOCAL build (JARVIS_LOCAL=1)"
  INSTALLER="$(get_local_installer "$OS" "$FORMAT")"
  if [ -z "$INSTALLER" ] || [ ! -f "$INSTALLER" ]; then
    fail "No local installer found. Run 'npm run tauri:build' first."
    exit 1
  fi
  ok "Local installer: $INSTALLER"
else
  VERSION="$(get_latest_version)"
  URL="$(resolve_download_url "$VERSION" "$OS" "$ARCH" "$FORMAT")"
  FNAME="$(basename "$URL")"
  INSTALLER="$TMP_DIR/$FNAME"
  step "Downloading: $URL"
  if ! curl -fSL --progress-bar -o "$INSTALLER" "$URL"; then
    fail "Download failed."
    warn "If no GitHub release exists yet, set JARVIS_LOCAL=1 to install from a local build."
    exit 1
  fi
  size=$(du -h "$INSTALLER" | cut -f1)
  ok "Downloaded $size"
fi

# Hash for log/audit
if command -v sha256sum >/dev/null 2>&1; then
  HASH="$(sha256sum "$INSTALLER" | cut -c1-16)"
elif command -v shasum >/dev/null 2>&1; then
  HASH="$(shasum -a 256 "$INSTALLER" | cut -c1-16)"
else
  HASH="(no sha tool)"
fi
ok "SHA256 (first 16): $HASH"

if [ "${JARVIS_DRYRUN:-0}" = "1" ]; then
  ok "Dry run complete. Installer staged at: $INSTALLER"
  exit 0
fi

# Install
case "$OS/$FORMAT" in
  linux/deb)      install_deb      "$INSTALLER" ;;
  linux/rpm)      install_rpm      "$INSTALLER" ;;
  linux/appimage) install_appimage "$INSTALLER" ;;
  macos/dmg)      install_dmg      "$INSTALLER" ;;
  *) fail "No install path for $OS/$FORMAT"; exit 1 ;;
esac

printf "\n"
ok "Jarvis installed."

# Auto-open Jarvis
step "Auto-launching Jarvis One..."
case "$OS" in
  macos)
    if [ -n "${SUDO_USER:-}" ]; then
      sudo -u "$SUDO_USER" open -a "Jarvis One"
    else
      open -a "Jarvis One"
    fi
    ;;
  linux)
    launch_linux_app
    ;;
esac

printf "\n  ${CYAN}Launch:${RESET}\n"
case "$OS" in
  linux) printf "      jarvis    (or use your apps menu)\n" ;;
  macos) printf "      open -a \"Jarvis One\"\n" ;;
esac
printf "\n  ${DIM}Voice push-to-talk:${RESET}  Cmd/Ctrl + Space\n"
printf "  ${DIM}Command palette:${RESET}     Cmd/Ctrl + K\n\n"
