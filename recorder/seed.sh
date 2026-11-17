#!/bin/sh
# fone-recorder's first start: 录播姬's config.json written from the template recorder/config.json
# (mounted at /seed), with a room for each of FONE_ROOMS's (room=channel, comma-separated) and the
# file names' times in TZ, the zone the server reads them in (FONE_FILENAME_TZ). The template's
# folder is the room number, which FONE_ROOMS also names for the server.
#
# After that the file is 录播姬's own (rooms added through its API stay) and this leaves it alone:
# to seed it again from FONE_ROOMS, stop fone-recorder, delete <FONE_RECORDINGS>/fone/config.json
# and start it.
set -eu
CONFIG=${SEED_CONFIG:-/rec/config.json}
TEMPLATE=${SEED_TEMPLATE:-/seed/config.json}
[ -f "$CONFIG" ] && exit 0

set -f # (no globbing of the names)
rooms=
IFS=,
for pair in ${FONE_ROOMS:-}; do
  id=$(printf '%s' "${pair%%=*}" | tr -d ' \t')
  case $id in
    '' | *[!0-9]*) echo "seed: skipping '$pair' in FONE_ROOMS (not room=channel)" >&2; continue ;;
  esac
  rooms="$rooms${rooms:+, }{\"RoomId\": {\"HasValue\": true, \"Value\": $id}, \"AutoRecord\": {\"HasValue\": true, \"Value\": true}}"
done
unset IFS

zone=${TZ:-Asia/Shanghai}
case $zone in
  *[!A-Za-z0-9/_+-]*) echo "seed: TZ '$zone' isn't a zone name" >&2; exit 1 ;;
esac
# (the template's only zone is its time_zone's)
sed -e "s|\"rooms\": \[\]|\"rooms\": [$rooms]|" -e "s|Asia/Shanghai|$zone|" "$TEMPLATE" > "$CONFIG.tmp"
mv "$CONFIG.tmp" "$CONFIG"
if [ -n "$rooms" ]; then
  echo "seed: wrote $CONFIG: rooms from FONE_ROOMS (${FONE_ROOMS}), file names in $zone"
else
  echo "seed: wrote $CONFIG with no room: FONE_ROOMS names none, so nothing is recorded" >&2
  echo "seed: set FONE_ROOMS in .env, delete $CONFIG and start fone-recorder again" >&2
fi
