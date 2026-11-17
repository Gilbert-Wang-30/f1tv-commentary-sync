"""Every tool the server runs and waits for can't keep it waiting for good: a tesseract or an
ffmpeg that hangs (a recording's read stalled on the NAS, say) wedged whoever waited on it, the
screen-clock loop, a vodclock job and its frame slot, every backfill job behind it."""

import ast
import time
from pathlib import Path

import numpy as np
import pytest

from fone import backfill_writer as bw
from fone import screenclock_media as sm

FONE = Path(__file__).parent.parent / "fone"
HANG = ["sh", "-c", "exec sleep 30", "sh"]  # (as NICE: what's run after it hangs instead)


def test_every_tool_run_to_its_end_has_a_timeout():
    missing = []
    for f in sorted(FONE.glob("*.py")):
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) \
                    and node.func.value.id == "subprocess" and node.func.attr in ("run", "call", "check_call", "check_output") \
                    and not any(k.arg == "timeout" for k in node.keywords):
                missing.append(f"{f.name}:{node.lineno}")
    assert not missing


def test_a_hung_ocr_is_a_frame_unread(monkeypatch):
    monkeypatch.setattr(sm, "NICE", HANG)
    monkeypatch.setattr(sm, "OCR_TIMEOUT", 0.3)
    t = time.monotonic()
    assert sm.tesseract(b"P5\n1 1\n255\n\x00", "--psm", "7") == ""
    assert sm.frame_words(np.zeros((72, 128), np.uint8)) == []  # (under 1000 lines: upscaled by ffmpeg first)
    assert time.monotonic() - t < 5


def test_decode_gives_up_on_an_ffmpeg_that_gives_no_frame(monkeypatch, caplog):
    monkeypatch.setattr(sm, "DECODE_IDLE", 0.4)

    def feed(out):  # (the recording's read stalled: a header, then nothing for a while)
        out.write(sm.FLV_VIDEO_HEADER)
        out.flush()
        time.sleep(2)

    assert list(sm.decode(feed)) == []
    assert "ffmpeg gave no frame" in caplog.text  # (not the feed's end: killed before it)


def test_a_hung_backfill_step_fails_its_job():
    with pytest.raises(RuntimeError, match="sleep took over 0.2 s"):
        bw.run("sleep", "30", timeout=0.2)
