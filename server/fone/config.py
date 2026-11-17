"""Runtime configuration, read once from environment variables."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


FEATURES = ("timing", "ads", "screenclock", "video", "backfill", "danmaku", "vodclock")
OFF = ("0", "false", "no", "off")
# The zone recordings' file names are read in unless FONE_FILENAME_TZ says otherwise: 录播姬's
# own default template writes Beijing time. fone's recorders (docker-compose.yml) write theirs
# in FONE_FILENAME_TZ, and recorder/gate.py reads them in it: one setting for all.
FILENAME_TZ = "Asia/Shanghai"

log = logging.getLogger("fone.config")


@dataclass(frozen=True)
class Config:
    # Recorder output root (mounted read-only), scanned recursively. A recording's
    # channel is its parent folder: BililiveRecorder's `{{ roomId }}/` or `{{ name }}/` template.
    rec_dir: Path
    # Local scratch: sqlite DB + extracted audio HLS. Should be on local disk.
    data_dir: Path
    # Timezone the recorder uses when it renders timestamps into filenames.
    filename_tz: ZoneInfo
    # HLS segment length. Shorter = fresher live edge, more files.
    segment_seconds: float
    # A recording whose mtime is older than this is considered finished.
    growing_idle_seconds: float
    # When a newer file appears in the same channel, the previous file is
    # finalised once it has been idle this long (stream reconnect handling).
    reconnect_idle_seconds: float
    scan_interval: float
    # Finished recordings newer than this are extracted eagerly; older ones on demand.
    eager_days: float
    max_parallel_extractions: int
    # Streamer delay (seconds behind real time) used before you've calibrated.
    default_delay: float
    # Recorder folder name -> channel name. A room-number folder (fone-recorder's) is named
    # by FONE_ROOMS; 录播姬 may name folders after the account (马莎拉车) while you know the
    # show as 胡闹P房; aliases also survive renames.
    channel_aliases: dict[str, str]
    # Where backfill writes replays it imports (`<import_dir>/<channel>/...flv`). Files there
    # are recordings with source "import": they only fill what the recorder missed.
    # Usually inside rec_dir (a nested rw mount); scanned as a second root otherwise.
    import_dir: Path | None = None
    # Bilibili room id -> channel, for the live-status log that drives backfill.
    rooms: dict[int, str] = field(default_factory=dict)
    # Streamer's reaction time on top of the measured screen delay: commentary about an
    # event is heard this long after the streamer's screen showed it.
    reaction_seconds: float = 0.9
    # Optional services, each switchable off (FONE_<NAME>=0).
    features: frozenset[str] = frozenset(FEATURES)
    # Sponsor clips (ads.py): a reference set of your own instead of the bundled one, and the
    # channels to match against (None: the set's own, see ads.py; "*": every channel).
    ads_refs: Path | None = None
    ads_channels: frozenset[str] | None = None


def load() -> Config:
    env = os.environ.get
    rooms = parse_rooms(env("FONE_ROOMS", ""))
    cfg = Config(
        rec_dir=Path(env("FONE_REC_DIR", "/rec")),
        data_dir=Path(env("FONE_DATA_DIR", "/data")),
        filename_tz=parse_tz(env("FONE_FILENAME_TZ") or FILENAME_TZ),
        segment_seconds=float(env("FONE_SEGMENT_SECONDS", "2")),
        growing_idle_seconds=float(env("FONE_GROWING_IDLE_SECONDS", "90")),
        reconnect_idle_seconds=float(env("FONE_RECONNECT_IDLE_SECONDS", "8")),
        scan_interval=float(env("FONE_SCAN_INTERVAL", "3")),
        eager_days=float(env("FONE_EAGER_DAYS", "10")),
        max_parallel_extractions=int(env("FONE_MAX_PARALLEL", "2")),
        default_delay=float(env("FONE_DEFAULT_DELAY") or "40"),
        # a room's own folder (fone-recorder's) is its channel; FONE_CHANNEL_ALIASES wins
        channel_aliases={**{str(r): c for r, c in rooms.items()}, **parse_aliases(env("FONE_CHANNEL_ALIASES", ""))},
        import_dir=Path(env("FONE_IMPORT_DIR")) if env("FONE_IMPORT_DIR") else None,
        rooms=rooms,
        reaction_seconds=float(env("FONE_REACTION_SECONDS") or "0.9"),
        features=frozenset(f for f in FEATURES if (env(f"FONE_{f.upper()}") or "1").strip().lower() not in OFF),
        ads_refs=Path(env("FONE_ADS_REFS")) if env("FONE_ADS_REFS") else None,
        ads_channels=parse_names(env("FONE_ADS_CHANNELS", "")),
    )
    for note in notes(cfg):
        log.warning("%s", note)
    return cfg


def notes(cfg: Config) -> list[str]:
    """What this configuration leaves out that a new server most likely wants, in words (logged
    at start). Nothing here is an error: a server for a streamer on another site has no room."""
    out = []
    if not cfg.rec_dir.is_dir():
        out.append(f"FONE_REC_DIR {cfg.rec_dir} isn't a folder: no recordings to play")
    if not cfg.rooms:
        out.append("FONE_ROOMS is empty: no Bilibili room is watched, so no live-status log or backfill and no 弹幕, "
                   "and the extension gets no live straight from the room, ↗ Live page or Bilibili replays "
                   "(set room=channel for a Bilibili streamer)")
    if cfg.import_dir is not None and not cfg.import_dir.is_dir():
        out.append(f"FONE_IMPORT_DIR {cfg.import_dir} isn't a folder: backfill has nowhere to write")
    return out


def parse_tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name.strip())
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ValueError(f"FONE_FILENAME_TZ={name!r} isn't a time zone (Asia/Shanghai, Europe/London, UTC, ...)") from e


def parse_names(spec: str) -> frozenset[str] | None:
    """"a, b" -> {"a", "b"}; empty -> None (unset)."""
    names = frozenset(x.strip() for x in spec.split(",") if x.strip())
    return names or None


def parse_aliases(spec: str) -> dict[str, str]:
    """"folder=channel,folder2=channel" -> dict."""
    out = {}
    for pair in filter(None, (x.strip() for x in spec.split(","))):
        folder, _, channel = pair.partition("=")
        if folder.strip() and channel.strip():
            out[folder.strip()] = channel.strip()
    return out


def parse_rooms(spec: str) -> dict[int, str]:
    """"23954427=胡闹P房,123=other" -> {23954427: "胡闹P房", 123: "other"}."""
    out = {}
    for pair in filter(None, (x.strip() for x in spec.split(","))):
        room, _, channel = pair.partition("=")
        if room.strip().isdigit() and channel.strip():
            out[int(room.strip())] = channel.strip()
    return out
