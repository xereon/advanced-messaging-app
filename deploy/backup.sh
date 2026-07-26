#!/usr/bin/env bash
# Back up Relay without stopping it.
#
#   ./deploy/backup.sh /var/backups/relay
#
# SQLite runs in WAL mode, so copying relay.db on its own can capture a
# half-written state. VACUUM INTO writes a consistent snapshot of a live
# database, which is the supported way to take a hot backup.

set -euo pipefail

DEST="${1:-./backups}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${RELAY_DB:-$APP_DIR/data/relay.db}"
UPLOADS="${RELAY_UPLOADS:-$APP_DIR/data/uploads}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"

if [ ! -f "$DB" ]; then
  echo "No database at $DB" >&2
  exit 1
fi

echo "Snapshotting database..."
node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1]);
  db.exec(\`VACUUM INTO '\${process.argv[2].replace(/'/g, \"''\")}'\`);
  db.close();
" "$DB" "$DEST/relay-$STAMP.db" 2>/dev/null

if [ -d "$UPLOADS" ]; then
  echo "Archiving attachments..."
  tar -czf "$DEST/uploads-$STAMP.tar.gz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
fi

echo "Done:"
ls -lh "$DEST" | grep "$STAMP" || true

# Keep the last 14 sets.
find "$DEST" -name 'relay-*.db' -type f | sort | head -n -14 | xargs -r rm --
find "$DEST" -name 'uploads-*.tar.gz' -type f | sort | head -n -14 | xargs -r rm --
