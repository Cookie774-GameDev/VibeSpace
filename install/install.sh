#!/usr/bin/env bash
# Jarvis - Linux / macOS Terminal Installer
# Usage:    curl -fsSL https://jarvis.app/install.sh | bash
# Or:       curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh | bash
# GitHub:   wget -qO- https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh | bash
#
# Optional environment variables:
#   JARVIS_VERSION="0.1.20"    pin to a version (default: latest published GitHub release)
#   JARVIS_CHANNEL="stable"    stable | nightly (default: stable)
#   JARVIS_FORMAT=""           linux: deb | rpm | appimage  (default: appimage for zero-touch user installs)
#                              macOS: dmg (the only option)
#   JARVIS_PREFIX=""           install prefix (default: ~/.local for Linux AppImage user installs)
#   JARVIS_LOCAL="1"           install from a local Jarvis build (developer mode)
#   JARVIS_SYSTEM="1"          install system-wide and allow sudo/elevation when required
#   JARVIS_DRYRUN="1"          download + verify only, do not install
#   JARVIS_DOWNLOAD_DIR=""     stage downloads in a specific directory
#   JARVIS_KEEP_DOWNLOAD="1"   keep the downloaded installer after a normal run

set -euo pipefail

# --- Constants ----------------------------------------------------------------
JARVIS_REPO="Cookie774-GameDev/VibeSpace"
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
      printf "    ${CYAN}irm https://raw.githubusercontent.com/${JARVIS_REPO}/main/install/install.ps1 | iex${RESET}\n" >&2
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

make_tmp_dir() {
  if [ -n "${JARVIS_DOWNLOAD_DIR:-}" ]; then
    mkdir -p "$JARVIS_DOWNLOAD_DIR"
    mktemp -d "${JARVIS_DOWNLOAD_DIR%/}/jarvis-installer.XXXXXX"
  else
    mktemp -d -t jarvis-installer.XXXXXX
  fi
}

SUDO=()
setup_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=()
  else
    require_cmd sudo
    SUDO=(sudo)
  fi
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

needs_sudo() {
  case "${OS}/${FORMAT}" in
    linux/deb|linux/rpm)
      return 0
      ;;
    macos/dmg)
      if is_truthy "${JARVIS_SYSTEM:-0}"; then
        return 0
      fi
      return 1
      ;;
    linux/appimage)
      local prefix
      prefix="$(linux_install_prefix)"
      case "$prefix" in
        "$HOME"/*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
}

linux_install_prefix() {
  if [ -n "${JARVIS_PREFIX:-}" ]; then
    printf "%s" "${JARVIS_PREFIX%/}"
  elif is_truthy "${JARVIS_SYSTEM:-0}"; then
    printf "/usr/local"
  else
    printf "%s" "${HOME}/.local"
  fi
}

macos_install_dir() {
  if is_truthy "${JARVIS_SYSTEM:-0}"; then
    printf "/Applications"
  else
    printf "%s" "${HOME}/Applications"
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
  tag=$(curl -fsSL -H "User-Agent: jarvis-installer" "${JARVIS_API}/latest" 2>/dev/null \
        | sed -nE 's/.*"tag_name":[[:space:]]*"v?([^"]+)".*/\1/p' \
        | head -n1 || true)
  if [ -n "$tag" ]; then
    ok "Latest version: $tag" >&2
    printf "%s" "$tag"
  else
    local effective
    effective=$(curl -Ls -H "User-Agent: jarvis-installer" -o /dev/null -w '%{url_effective}' "https://github.com/${JARVIS_REPO}/releases/latest" 2>/dev/null || true)
    tag=$(printf "%s" "$effective" | sed -nE 's#.*/releases/tag/v?([^/[:space:]]+)$#\1#p')
    if [ -n "$tag" ]; then
      ok "Latest version: $tag" >&2
      printf "%s" "$tag"
    else
      fail "No published VibeSpace GitHub Release was found. Publish a release with installer assets, or set JARVIS_VERSION/JARVIS_LOCAL for controlled testing."
      exit 1
    fi
  fi
}

# --- Download URLs -----------------------------------------------------------
asset_pattern() {
  local os="$1" arch="$2" format="$3"
  case "$os/$format" in
    linux/deb)      printf '%s' '(^|/).*(VibeSpace|vibesspace|jarvis|Jarvis)(%20One|[-_ ]?One)?.*(amd64|x86_64).*\.deb$' ;;
    linux/rpm)      printf '%s' '(^|/).*(VibeSpace|vibesspace|jarvis|Jarvis)(%20One|[-_ ]?One)?.*(x86_64|amd64).*\.rpm$' ;;
    linux/appimage) printf '%s' '(^|/).*(VibeSpace|vibesspace|jarvis|Jarvis)(%20One|[-_ ]?One)?.*(amd64|x86_64).*\.AppImage$' ;;
    macos/dmg)
      if [ "$arch" = "aarch64" ]; then
        printf '%s' '(^|/).*(VibeSpace|Jarvis|jarvis)(%20One|[-_ ]?One)?.*(aarch64|arm64).*\.dmg$'
      else
        printf '%s' '(^|/).*(VibeSpace|Jarvis|jarvis)(%20One|[-_ ]?One)?.*(x64|x86_64|amd64).*\.dmg$'
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
    local response
    response=$(curl -fsSL -H "User-Agent: jarvis-installer" "$api_url" 2>/dev/null || true)
    local asset
    asset=$(printf "%s" "$response" \
      | grep -o '"browser_download_url":[[:space:]]*"[^"]*"' \
      | sed -E 's/.*"browser_download_url":[[:space:]]*"([^"]*)".*/\1/' \
      | grep -Ei "$pattern" \
      | head -n1 || true)
    if [ -n "$asset" ]; then
      printf "%s" "$asset"
      return
    fi
    # For macOS, try to find any available DMG if the specific arch isn't available
    if [ "$os" = "macos" ]; then
      # List all available assets for better error reporting
      local all_assets
      all_assets=$(printf "%s" "$response" \
        | grep -o '"browser_download_url":[[:space:]]*"[^"]*"' \
        | sed -E 's/.*"browser_download_url":[[:space:]]*"([^"]*)".*/\1/' \
        | grep -Ei '\.dmg$' || true)

      if [ -z "$all_assets" ]; then
        fail "Release v${version} has no macOS DMG assets."
        printf "\n"
        printf "  ${YELLOW}Details:${RESET}\n"
        printf "    OS:           macOS\n"
        printf "    Architecture: %s\n" "$arch"
        printf "    Version:      v%s\n" "$version"
        printf "    Expected:     VibeSpace_%s_%s.dmg\n" "$version" "$([ "$arch" = "aarch64" ] && echo "aarch64" || echo "x64")"
        printf "\n"
        printf "  ${CYAN}Possible fixes:${RESET}\n"
        printf "    1. Wait for the release to complete (CI may still be building)\n"
        printf "    2. Try a different version: JARVIS_VERSION=0.1.22 and re-run\n"
        printf "    3. Check: https://github.com/${JARVIS_REPO}/releases/tag/v${version}\n"
        printf "\n"
        exit 1
      fi

      # If we have DMGs but not for this architecture, suggest alternatives
      fail "Release v${version} has no macOS ${arch} DMG asset."
      printf "\n"
      printf "  ${YELLOW}Available macOS assets:${RESET}\n"
      printf "%s" "$all_assets" | while read -r url; do
        printf "    - %s\n" "$(basename "$url")"
      done
      printf "\n"
      printf "  ${CYAN}Your system:${RESET} macOS %s\n" "$arch"
      printf "\n"
      if [ "$arch" = "x86_64" ]; then
        printf "  ${YELLOW}Note:${RESET} If you have Apple Silicon (M1/M2/M3), Rosetta 2 can run the arm64 version.\n"
        printf "  You can try: JARVIS_ARCH=aarch64 and re-run the installer.\n"
      fi
      printf "\n"
      warn "Check https://github.com/${JARVIS_REPO}/releases/tag/v${version}"
      exit 1
    fi
  fi
  download_url "$version" "$os" "$arch" "$format"
}

# --- Install actions ---------------------------------------------------------
install_deb() {
  local file="$1"
  step "Installing .deb (sudo required)..."
  "${SUDO[@]}" apt install -y "$file" || "${SUDO[@]}" dpkg -i "$file" || {
    fail "dpkg failed. Trying to fix dependencies..."
    "${SUDO[@]}" apt-get install -fy
  }
}

install_rpm() {
  local file="$1"
  step "Installing .rpm (sudo required)..."
  if command -v dnf >/dev/null 2>&1; then
    "${SUDO[@]}" dnf install -y "$file"
  else
    "${SUDO[@]}" yum install -y "$file"
  fi
}

install_appimage() {
  local file="$1"
  local prefix
  prefix="$(linux_install_prefix)"
  local target="${prefix}/bin/jarvis"
  step "Installing AppImage to ${target}..."
  if [ ${#SUDO[@]} -gt 0 ]; then
    "${SUDO[@]}" mkdir -p "${prefix}/bin"
    "${SUDO[@]}" install -m 0755 "$file" "$target"
  else
    mkdir -p "${prefix}/bin"
    install -m 0755 "$file" "$target"
  fi

  # Desktop entry for menu integration
  local desktop="${HOME}/.local/share/applications/jarvis.desktop"
  mkdir -p "$(dirname "$desktop")"
  cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=VibeSpace
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
  local target_dir
  target_dir="$(macos_install_dir)"
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
  step "Copying to ${target_dir}..."
  if [ ${#SUDO[@]} -gt 0 ]; then
    "${SUDO[@]}" mkdir -p "$target_dir"
    "${SUDO[@]}" cp -R "$app" "$target_dir/"
  else
    mkdir -p "$target_dir"
    cp -R "$app" "$target_dir/"
  fi
  hdiutil detach "$mountpoint" -force >/dev/null 2>&1 || true
  step "Removing macOS quarantine flag..."
  if [ ${#SUDO[@]} -gt 0 ]; then
    "${SUDO[@]}" xattr -dr com.apple.quarantine "${target_dir}/$(basename "$app")" || true
  else
    xattr -dr com.apple.quarantine "${target_dir}/$(basename "$app")" || true
  fi
  ok "Installed: ${target_dir}/$(basename "$app")"
  warn "First launch may still require Finder -> Open until the app is notarized."
  warn "After the first 'Open', macOS remembers the trust for future updates."
}

install_terminal_launcher() {
  local bin_dir="${HOME}/.jarvis/bin"
  local launcher="${bin_dir}/Jarvis"
  mkdir -p "$bin_dir"

  cat > "$launcher" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ESC=$'\033'
CYAN="${ESC}[38;5;51m"
VIOLET="${ESC}[38;5;141m"
PINK="${ESC}[38;5;213m"
BLUE="${ESC}[38;5;39m"
GREEN="${ESC}[38;5;82m"
BOLD="${ESC}[1m"
DIM="${ESC}[2m"
RESET="${ESC}[0m"

clear
for frame in \
  "${CYAN}|=                   | WAKING CORE" \
  "${BLUE}|=====               | LINKING MODELS" \
  "${VIOLET}|==========          | SYNCING MEMORY" \
  "${PINK}|===============     | ARMING INTERFACE" \
  "${GREEN}|====================| SYSTEM ONLINE"
do
  color=${frame%%|*}
  rest=${frame#*|}
  bar=${rest%%|*}
  label=${rest#*|}
  printf "\r  %b[%-20s]%b  %b%s%b" "$color" "$bar" "$RESET" "$BOLD" "$label" "$RESET"
  sleep 0.11
done
printf "\n\n"
printf "%b\n" "${CYAN}  +--------------------------------------------------+${RESET}"
printf "%b\n" "${CYAN}  |${RESET}${VIOLET}${BOLD}              J  A  R  V  I  S    O  N  E           ${RESET}${CYAN}|${RESET}"
printf "%b\n" "${BLUE}  |${RESET}${DIM}             INTELLIGENT DESKTOP SYSTEM             ${RESET}${BLUE}|${RESET}"
printf "%b\n" "${VIOLET}  +--------------------------------------------------+${RESET}"
printf "%b\n" "${PINK}       * ${CYAN}VOICE${PINK} * ${BLUE}AGENTS${PINK} * ${VIOLET}MEMORY${PINK} * ${GREEN}AUTOMATION${RESET}"
printf "%b\n\n" "${GREEN}${BOLD}    >> ACCESS GRANTED${RESET}${DIM}  Launching your workspace...${RESET}"

case "$(uname -s)" in
  Darwin*)
    app="$HOME/Applications/VibeSpace.app"
    [ -d "$app" ] || app="/Applications/VibeSpace.app"
    [ -d "$app" ] || { echo "VibeSpace.app was not found." >&2; exit 1; }
    open "$app"
    ;;
  Linux*)
    target="$HOME/.local/bin/jarvis"
    [ -x "$target" ] || target="/usr/local/bin/jarvis"
    [ -x "$target" ] || target="/usr/bin/jarvis"
    [ -x "$target" ] || { echo "Jarvis executable was not found." >&2; exit 1; }
    nohup "$target" >/dev/null 2>&1 &
    ;;
  *)
    echo "Unsupported operating system." >&2
    exit 1
    ;;
esac
EOF
  chmod 0755 "$launcher"

  local marker_start="# >>> Jarvis launcher >>>"
  local marker_end="# <<< Jarvis launcher <<<"
  local path_line='export PATH="$HOME/.jarvis/bin:$PATH"'
  local profile
  for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"; do
    if [ -f "$profile" ] && grep -Fq "$marker_start" "$profile"; then
      continue
    fi
    printf "\n%s\n%s\n%s\n" "$marker_start" "$path_line" "$marker_end" >> "$profile"
  done
  export PATH="$bin_dir:$PATH"
  ok "Terminal command ready: Jarvis"
}

launch_linux_app() {
  local runner=""
  if command -v jarvis >/dev/null 2>&1; then
    runner="jarvis"
  elif command -v VibeSpace >/dev/null 2>&1; then
    runner="VibeSpace"
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
      sudo -u "$SUDO_USER" gtk-launch "VibeSpace" >/dev/null 2>&1 || true
    else
      gtk-launch jarvis.desktop >/dev/null 2>&1 || \
      gtk-launch "VibeSpace" >/dev/null 2>&1 || true
    fi
    return 0
  fi

  warn "Installed successfully, but no launcher command was found. Open VibeSpace from your apps menu."
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
    deb)      find "$base/deb"      \( -name 'VibeSpace_*_amd64.deb' -o -name 'VibeSpace-*.deb' -o -name 'jarvis_*_amd64.deb' \) 2>/dev/null | head -n1 ;;
    rpm)      find "$base/rpm"      \( -name 'VibeSpace-*.x86_64.rpm' -o -name 'VibeSpace-*.rpm' -o -name 'jarvis-*.x86_64.rpm' \) 2>/dev/null | head -n1 ;;
    appimage) find "$base/appimage" \( -name 'VibeSpace_*_amd64.AppImage' -o -name 'VibeSpace-*.AppImage' -o -name 'jarvis_*_amd64.AppImage' \) 2>/dev/null | head -n1 ;;
    dmg)      find "$base/dmg"      \( -name 'VibeSpace_*.dmg' -o -name 'VibeSpace-*.dmg' -o -name 'Jarvis_*.dmg' \) 2>/dev/null | head -n1 ;;
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
    FORMAT="appimage"
  else
    FORMAT="dmg"
  fi
fi

step "OS:        $OS"
step "Arch:      $ARCH"
step "Format:    $FORMAT"
if [ "$OS" = "linux" ] && [ "$FORMAT" = "appimage" ]; then
  step "Prefix:    $(linux_install_prefix)"
elif [ "$OS" = "macos" ]; then
  step "App dir:    $(macos_install_dir)"
fi
if [ -n "${JARVIS_DOWNLOAD_DIR:-}" ]; then
  step "Download:   ${JARVIS_DOWNLOAD_DIR}"
fi

case "$OS/$FORMAT" in
  linux/deb|linux/rpm|linux/appimage|macos/dmg) ;;
  *) fail "Unsupported JARVIS_FORMAT '${FORMAT}' for ${OS}. Use deb, rpm, appimage, or dmg."; exit 1 ;;
esac

if [ "${JARVIS_DRYRUN:-0}" != "1" ] && needs_sudo; then
  setup_sudo
fi

# Pick installer
TMP_DIR=""
cleanup() {
  if [ -z "${TMP_DIR:-}" ]; then
    return
  fi
  if [ "${JARVIS_DRYRUN:-0}" = "1" ] || [ "${JARVIS_KEEP_DOWNLOAD:-0}" = "1" ]; then
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
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
  TMP_DIR="$(make_tmp_dir)"
  INSTALLER="$TMP_DIR/$FNAME"
  step "Downloading: $URL"
  if ! curl -fSL -H "User-Agent: jarvis-installer" --progress-bar -o "$INSTALLER" "$URL"; then
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
install_terminal_launcher

# Auto-open Jarvis
step "Auto-launching VibeSpace..."
case "$OS" in
  macos)
    if [ -n "${SUDO_USER:-}" ]; then
      sudo -u "$SUDO_USER" open -a "VibeSpace"
    else
      open -a "VibeSpace"
    fi
    ;;
  linux)
    launch_linux_app
    ;;
esac

printf "\n  ${CYAN}Launch:${RESET}\n"
case "$OS" in
  linux) printf "      jarvis    (or use your apps menu)\n" ;;
  macos) printf "      open -a \"VibeSpace\"\n" ;;
esac
printf "\n  ${DIM}Voice push-to-talk:${RESET}  Cmd/Ctrl + Space\n"
printf "  ${DIM}Command palette:${RESET}     Cmd/Ctrl + K\n\n"
