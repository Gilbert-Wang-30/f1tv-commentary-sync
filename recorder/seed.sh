#!/bin/sh
# fone-recorder's start: 录播姬's config.json written from the template recorder/config.json
# (mounted at /seed), with a room for each of FONE_ROOMS's (room=channel, comma-separated; a
# room number alone is a channel of that name, as the server reads it) and the file names'
# times in TZ, the zone the server reads them in (FONE_FILENAME_TZ). The template's folder is
# the room number, which FONE_ROOMS also names for the server.
#
# After that the file is 录播姬's own (rooms added through its API stay) and this leaves it
# alone, unless it has no room at all and FONE_ROOMS now names one: then it's written again
# (the old one kept as config.json.bak). With no room in config.json nor in FONE_ROOMS nothing
# is written and the recorder doesn't start (it would record nothing): its log says what to set.
# To seed it again from FONE_ROOMS by hand, stop fone-recorder, delete
# <FONE_RECORDINGS>/fone/config.json and start it.
set -eu
CONFIG=${SEED_CONFIG:-/rec/config.json}
TEMPLATE=${SEED_TEMPLATE:-/seed/config.json}

set -f # (no globbing of the names)
rooms='' ids=''
IFS=,
for pair in ${FONE_ROOMS:-}; do
  pair=$(printf '%s' "$pair" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$pair" ] || continue
  id=$(printf '%s' "${pair%%=*}" | sed -e 's/[[:space:]]*$//')
  case $id in
    '' | *[!0-9]*)
      # (the server's config.parse_rooms says the same)
      echo "seed: skipping '$pair' in FONE_ROOMS: not a room number (room=channel, or the room alone)" >&2
      continue ;;
  esac
  # 0123 is room 123, as the server reads it (and a JSON number has no leading zero)
  id=${id#"${id%%[!0]*}"}
  id=${id:-0}
  case ",$ids," in *",$id,"*) continue ;; esac
  ids="$ids${ids:+,}$id"
  rooms="$rooms${rooms:+, }{\"RoomId\": {\"HasValue\": true, \"Value\": $id}, \"AutoRecord\": {\"HasValue\": true, \"Value\": true}}"
done
unset IFS

if [ -f "$CONFIG" ]; then
  # (录播姬 writes its own JSON back without spaces: a room is a RoomId whatever the layout)
  grep -q '"RoomId"' "$CONFIG" && exit 0
  if [ -z "$rooms" ]; then
    echo "seed: $CONFIG has no room and FONE_ROOMS names none, so fone-recorder has nothing to record and doesn't start." >&2
    echo "seed: set FONE_ROOMS=<room>=<channel> in .env (the room: the number in live.bilibili.com/<room>), then: docker compose up -d" >&2
    exit 1
  fi
  cp "$CONFIG" "$CONFIG.bak"
  echo "seed: $CONFIG has no room: writing it again from FONE_ROOMS (the old one is $CONFIG.bak)"
elif [ -z "$rooms" ]; then
  echo "seed: FONE_ROOMS names no Bilibili room, so fone-recorder has nothing to record and doesn't start." >&2
  echo "seed: set FONE_ROOMS=<room>=<channel> in .env (the room: the number in live.bilibili.com/<room>), then: docker compose up -d" >&2
  echo "seed: (a streamer on another site: leave the recorder profile out of COMPOSE_PROFILES and use streamlink)" >&2
  exit 1
fi

zone=${TZ:-Asia/Shanghai}
case $zone in
  *[!A-Za-z0-9/_+-]*) echo "seed: TZ '$zone' isn't a zone name" >&2; exit 1 ;;
esac
# (the template's only zone is its time_zone's)
sed -e "s|\"rooms\": \[\]|\"rooms\": [$rooms]|" -e "s|Asia/Shanghai|$zone|" "$TEMPLATE" > "$CONFIG.tmp"
mv "$CONFIG.tmp" "$CONFIG"
echo "seed: wrote $CONFIG: rooms $ids from FONE_ROOMS, file names in $zone"
