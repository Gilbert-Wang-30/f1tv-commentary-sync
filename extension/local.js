// This install's own defaults. In the repo, and so in a release's zip, it's a placeholder: no
// server address lives in the code, and an install asks for its server (or the streamer's live
// URL) in its settings, which open on install. tools/publish_ext.sh writes a self-hosted build's
// copy from tools/publish.env (FONE_SERVERS). Loaded before anything reads the defaults:
// background.js (importScripts), the content scripts (first in manifest.json) and options.html.
self.FONE_LOCAL = { servers: [] };
