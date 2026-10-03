#!/bin/sh
set -eu

# Official immutable release. Hashes are from its SHA2-256SUMS asset:
# https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS
version=2026.08.19
case "${1:?Usage: install-yt-dlp.sh TARGETARCH [DESTINATION]}" in
    amd64)
        asset=yt-dlp_linux
        checksum=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
        ;;
    arm64)
        asset=yt-dlp_linux_aarch64
        checksum=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc
        ;;
    *) printf 'Unsupported yt-dlp architecture: %s\n' "$1" >&2; exit 1 ;;
esac

destination=${2:-/usr/local/bin/yt-dlp}
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    "https://github.com/yt-dlp/yt-dlp/releases/download/$version/$asset" \
    --output "$temporary_directory/$asset"
printf '%s  %s\n' "$checksum" "$temporary_directory/$asset" | sha256sum --check --status
install -m 0755 "$temporary_directory/$asset" "$destination"

# Keep attribution for the third-party code bundled by the standalone release.
documentation_directory=/usr/local/share/doc/yt-dlp
mkdir -p "$documentation_directory"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$version/THIRD_PARTY_LICENSES.txt" \
    --output "$documentation_directory/THIRD_PARTY_LICENSES.txt"
