#!/usr/bin/env bash
# Host-only, BEFORE the lease: download the exact postgresql-17 closure that
# the trixie image lacks, and pin every file to the sha256 in the apt index.
# Creates no Incus object. Output: $DEBS/*.deb and $DEBS/SHA256SUMS.
source "$(dirname "$0")/common.sh"
cd "$DEBS"
rm -f ./*.deb SHA256SUMS
pkgs=$(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
  --no-breaks --no-replaces --no-enhances "postgresql-$PG_MAJOR=$PG_VERSION" python3 python3-psycopg \
  | grep -E '^[a-z0-9]' | grep -vx 'locales-all' | sort -u)
# shellcheck disable=SC2086
apt-get download $pkgs >/dev/null
[[ -f postgresql-${PG_MAJOR}_${PG_VERSION}_amd64.deb ]] || die "postgresql-$PG_MAJOR $PG_VERSION not downloaded"
for f in ./*.deb; do
  pkg=$(dpkg-deb -f "$f" Package); ver=$(dpkg-deb -f "$f" Version); arch=$(dpkg-deb -f "$f" Architecture)
  want=$(apt-cache show "$pkg:$arch=$ver" 2>/dev/null | awk '/^SHA256:/{print $2; exit}')
  have=$(sha256sum "$f" | awk '{print $1}')
  [[ -n $want && $want == "$have" ]] || die "index sha256 mismatch for $f"
done
sha256sum ./*.deb > SHA256SUMS
log "prepare-debs: $(wc -l < SHA256SUMS) debs pinned, SHA256SUMS=$(sha256sum SHA256SUMS | cut -c1-64)"
