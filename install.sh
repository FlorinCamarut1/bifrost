#!/usr/bin/env bash
# Bifrost on Linux in one command (installs the newest release, or updates to it):
#   curl -fsSL https://raw.githubusercontent.com/FlorinCamarut1/bifrost/main/install.sh | bash
# Arch / CachyOS / Manjaro: the .pacman package; Debian / Ubuntu / Mint: the .deb; anything else: the AppImage in
# ~/.local/bin. Then Bifrost updates itself from the app.
set -euo pipefail

REPO=FlorinCamarut1/bifrost
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mBifrost:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "this script is for Linux (on Windows: Bifrost-Setup-x.y.z.exe from https://github.com/$REPO/releases)"
[ "$(uname -m)" = x86_64 ] || die "Bifrost is built for x86_64 only, this is $(uname -m)"
[ "$(id -u)" -ne 0 ] || die "run it as your own user, not root (it asks for sudo when it needs it)"
command -v curl >/dev/null || die "curl is needed"

# the newest release's asset whose name matches $1
asset() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/' | grep -E -e "$1" | head -n1
}

if command -v pacman >/dev/null; then kind=pacman; re='-linux-x86_64\.pacman$'
elif command -v apt-get >/dev/null && command -v dpkg >/dev/null; then kind=deb; re='-linux-amd64\.deb$'
else kind=appimage; re='-linux-x86_64\.AppImage$'
fi

say "looking for the newest Bifrost ($kind)"
url=$(asset "$re") || true
[ -n "$url" ] || die "no $kind file in the newest release (https://github.com/$REPO/releases/latest)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
file="$tmp/${url##*/}"
say "downloading ${url##*/}"
curl -fL --progress-bar -o "$file" "$url"

case $kind in
  pacman)
    say "installing (sudo pacman -U)"
    sudo pacman -U --needed --noconfirm "$file"
    bin=bifrost ;;
  deb)
    say "installing (sudo apt-get install)"
    chmod a+r "$file" "$tmp"   # (apt's sandbox user reads it)
    sudo apt-get install -y "$file"
    bin=bifrost ;;
  appimage)
    dir="$HOME/.local/bin"; mkdir -p "$dir"
    bin="$dir/Bifrost.AppImage"
    install -m 755 "$file" "$bin"
    # an AppImage needs FUSE 2
    if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
      say "the AppImage needs FUSE 2 (libfuse.so.2): install it with your package manager (fuse2 / libfuse2 / fuse-libs)"
    fi
    say "installed to $bin" ;;
esac

say "Bifrost is installed. On Linux, Enshrouded and Valheim (Windows build) run through Proton: start the game once from Steam, close it, then press PLAY in Bifrost."
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  say "starting Bifrost"
  nohup "$bin" >/dev/null 2>&1 &
fi
