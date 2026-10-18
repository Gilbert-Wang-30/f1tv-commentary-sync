"""Mock live-stream platforms for the no-server e2e (test_local.py), on https://127.0.0.1:443.

Chrome reaches it through --host-resolver-rules (and --ignore-certificate-errors), under the
real names, so the extension's own code runs unchanged:

  api.live.bilibili.com   room 5555 live, 6666 off air: get_info, Master/info, getRoomPlayInfo
  cn-test-01.bilivideo.com  that room's HTTP-FLV, refused (403) without Bilibili's Referer/Origin
  hls.test                live HLS: /live/ 2 s MPEG-TS segments; /master.m3u8 YouTube's shape
                          (video variants, the audio a rendition of its own: /fmp4/, fMP4)
  f1tv.formula1.com       F1 TV's content API: every video is LIVE

The streams are recordings (/media/live.flv, /media/hls/, /media/fmp4/) played as if live:
position pos(t) = t - T0 + 30 s, playlists a sliding window of 6. A new FLV connection gets the
last 2 s at once (a CDN's GOP cache), then each tag when its time comes, its timestamps
starting at 0 as Bilibili's do (so a reconnect is placed by arrival). /_ctl/kill drops every
FLV connection; /_ctl/stats says what was sent.
"""

import json
import os
import socketserver
import ssl
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

MEDIA = os.environ.get("MEDIA", "/media")
T0 = time.time()
LEAD = 30.0  # s into the stream at start
BURST = 2.0  # s sent at once on connect
BILI_REF = "https://live.bilibili.com/"


def pos(t=None):
    return (t or time.time()) - T0 + LEAD


def read_flv(path):
    b = open(path, "rb").read()
    hs = struct.unpack(">I", b[5:9])[0]
    head = b[: hs + 4]
    i = hs + 4
    tags = []
    while i + 11 <= len(b):
        typ = b[i] & 0x1F
        size = int.from_bytes(b[i + 1 : i + 4], "big")
        ts = int.from_bytes(b[i + 4 : i + 7], "big") | (b[i + 7] << 24)
        tags.append((typ, ts, b[i : i + 15 + size], b[i + 11 : i + 13]))
        i += 15 + size
    # the stream's headers, sent first on every connection: script data, AAC and AVC sequence headers
    hdrs = [t[2] for t in tags if t[0] == 18][:1]
    hdrs += [t[2] for t in tags if t[0] == 8 and t[3][1:2] == b"\x00"][:1]
    hdrs += [t[2] for t in tags if t[0] == 9 and t[3][1:2] == b"\x00"][:1]
    body = [(ts, raw) for typ, ts, raw, d in tags if typ in (8, 9) and not (d[1:2] == b"\x00")]
    return head, hdrs, body


FLV_HEAD, FLV_HDRS, FLV_TAGS = read_flv(f"{MEDIA}/live.flv")
HLS_SEGS = {d: set(os.listdir(f"{MEDIA}/{d}")) for d in ("hls", "fmp4")}
SEG = 2.0

STATE = {"flv": [], "kills": 0, "refused": 0, "hls_playlists": 0, "hls_segments": 0, "offline": False}
LOCK = threading.Lock()
KILL = threading.Event()


def json_body(h, obj, status=200):
    b = json.dumps(obj).encode()
    h.send_response(status)
    h.send_header("content-type", "application/json")
    h.send_header("content-length", str(len(b)))
    h.end_headers()
    h.wfile.write(b)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def do_GET(self):
        host = (self.headers.get("host") or "").split(":")[0]
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path.startswith("/_ctl/"):
                return self.ctl(u.path[6:])
            if host == "api.live.bilibili.com":
                return self.bili(u.path, q)
            if host == "cn-test-01.bilivideo.com":
                return self.flv()
            if host == "hls.test":
                return self.hls(u.path)
            if host == "f1tv.formula1.com" and u.path.startswith("/2.0/"):
                return json_body(self, {"resultCode": "OK", "resultObj": {"containers": [{"metadata": {
                    "title": "Test Grand Prix - Race", "contentSubtype": "LIVE"}}]}})
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            return
        json_body(self, {"error": f"no mock for {host}{u.path}"}, 404)

    def ctl(self, what):
        if what == "offline":  # room 5555's streamer goes off air: its FLV ends and refuses
            with LOCK:
                STATE["offline"] = True
            what = "kill"
        if what == "kill":
            with LOCK:
                STATE["kills"] += 1
            KILL.set()
            time.sleep(0.3)
            KILL.clear()
            return json_body(self, {"ok": True})
        with LOCK:
            return json_body(self, {**STATE, "pos": pos(), "t": time.time()})

    def bili(self, path, q):
        room = q.get("room_id") or q.get("id")
        live = room in ("5555", "105555") and not STATE["offline"]
        if path == "/room/v1/Room/get_info":
            if room not in ("5555", "105555", "6666"):
                return json_body(self, {"code": 1, "msg": "房间不存在", "data": None})
            return json_body(self, {"code": 0, "data": {"room_id": int(room), "uid": 4242 if live else 4343,
                                                         "live_status": 1 if live else 0, "title": "测试 F1 解说直播"}})
        if path == "/live_user/v1/Master/info":
            return json_body(self, {"code": 0, "data": {"info": {"uname": "测试解说" if q.get("uid") == "4242" else "下播了"}}})
        if path == "/xlive/web-room/v2/index/getRoomPlayInfo":
            codec = {"codec_name": "avc", "current_qn": 80, "base_url": f"/live-bvc/123/live_{room}.flv?",
                     "url_info": [{"host": "https://cn-test-01.bilivideo.com", "extra": f"expires={int(time.time()) + 3600}&sig=x", "stream_ttl": 3600}]}
            return json_body(self, {"code": 0, "data": {"room_id": int(room), "live_status": 1, "playurl_info": {"playurl": {"stream": [
                {"protocol_name": "http_stream", "format": [{"format_name": "flv", "codec": [codec]}]},
            ]}}}})
        return json_body(self, {"code": -404}, 404)

    def flv(self):
        if STATE["offline"]:
            return json_body(self, {"error": "off air"}, 404)
        if self.headers.get("referer") != BILI_REF or self.headers.get("origin") != BILI_REF.rstrip("/"):
            with LOCK:
                STATE["refused"] += 1
            return json_body(self, {"error": "referer"}, 403)
        self.send_response(200)
        self.send_header("content-type", "video/x-flv")
        self.end_headers()
        self.wfile.write(FLV_HEAD + b"".join(FLV_HDRS))
        p = pos() * 1000
        i = next(k for k, (ts, _) in enumerate(FLV_TAGS) if ts >= p - BURST * 1000)
        base = FLV_TAGS[i][0]
        conn = {"first": base / 1000, "at": time.time(), "last": None, "open": True}
        with LOCK:
            STATE["flv"].append(conn)
        try:
            while i < len(FLV_TAGS) and not KILL.is_set():
                ts, raw = FLV_TAGS[i]
                wait = ts / 1000 - pos()
                if wait > 0:
                    time.sleep(min(wait, 0.05))
                    continue
                r = ts - base  # this connection's timestamps start at 0
                self.wfile.write(raw[:4] + bytes([(r >> 16) & 0xFF, (r >> 8) & 0xFF, r & 0xFF, (r >> 24) & 0xFF]) + raw[8:])
                self.wfile.flush()
                conn["last"] = ts / 1000
                i += 1
        finally:
            conn["open"] = False

    def hls(self, path):
        newest = int(pos() // SEG) - 1  # the newest whole segment
        if path == "/master.m3u8":
            b = ("#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n"
                 '#EXT-X-MEDIA:URI="fmp4/index.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="Default",DEFAULT=YES,AUTOSELECT=YES\n'
                 '#EXT-X-MEDIA:URI="fmp4/index.m3u8?he",TYPE=AUDIO,GROUP-ID="233",NAME="Default",DEFAULT=YES,AUTOSELECT=YES\n'
                 '#EXT-X-STREAM-INF:BANDWIDTH=290288,CODECS="avc1.42C00B,mp4a.40.5",RESOLUTION=256x144,AUDIO="233"\nlive/index.m3u8?v144\n'
                 '#EXT-X-STREAM-INF:BANDWIDTH=1209862,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,AUDIO="234"\nlive/index.m3u8?v360\n').encode()
            return self.send_bytes(b, "application/vnd.apple.mpegurl")
        for d, ext in (("live", "hls"), ("fmp4", "fmp4")):
            if path == f"/{d}/index.m3u8":
                first = max(0, newest - 5)
                lines = ["#EXTM3U", "#EXT-X-VERSION:7", f"#EXT-X-TARGETDURATION:{int(SEG)}", f"#EXT-X-MEDIA-SEQUENCE:{first}"]
                if d == "fmp4":
                    lines.append('#EXT-X-MAP:URI="init.mp4"')
                suffix = "m4s" if d == "fmp4" else "ts"
                for k in range(first, newest + 1):
                    lines += [f"#EXTINF:{SEG:.3f},live", f"seg_{k:05d}.{suffix}"]
                with LOCK:
                    STATE["hls_playlists"] += 1
                return self.send_bytes(("\n".join(lines) + "\n").encode(), "application/vnd.apple.mpegurl")
            if path.startswith(f"/{d}/"):
                name = path.rsplit("/", 1)[-1]
                k = int(name[4:9]) if name.startswith("seg_") else -1
                if name in HLS_SEGS[ext] and (name == "init.mp4" or 0 <= k <= newest):
                    with LOCK:
                        STATE["hls_segments"] += name != "init.mp4"
                    return self.send_bytes(open(f"{MEDIA}/{ext}/{name}", "rb").read(), "video/mp4" if d == "fmp4" else "video/mp2t")
        return json_body(self, {"error": "no segment"}, 404)

    def send_bytes(self, b, ctype):
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class Server(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    cert = "/tmp/mock.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=mock",
                    "-keyout", cert, "-out", cert], check=True, capture_output=True)
    srv = Server(("127.0.0.1", 443), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print("mock streams on :443", file=sys.stderr, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
