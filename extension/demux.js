// The commentary's audio out of a live stream, for the in-browser recorder (recorder.js): AAC
// from HTTP-FLV (Bilibili, Douyin, Huya), from HLS segments (MPEG-TS as Twitch's audio-only,
// fMP4 as Bilibili's, packed ADTS as YouTube's), from MPEG-TS over HTTP and from a bare ADTS
// stream, as ADTS frames with the stream's own timestamps.
// The video in the stream is skipped. Pure functions, shared with the Node tests
// (demux.test.js).
(function (root) {
  'use strict';

  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function concat(...parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  }

  const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

  // ---- ADTS ------------------------------------------------------------------------------

  // The ADTS frame starting at b[i]: its length (header included), sample rate, channels and
  // samples; null when b[i] isn't the start of one.
  function adtsAt(b, i) {
    if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
    const sri = (b[i + 2] >> 2) & 0x0f;
    if (sri >= RATES.length) return null;
    const len = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    if (len < ((b[i + 1] & 0x01) ? 7 : 9)) return null;
    return {
      len, sri, rate: RATES[sri], profile: (b[i + 2] >> 6) & 3,
      ch: ((b[i + 2] & 0x01) << 2) | (b[i + 3] >> 6), samples: 1024 * ((b[i + 6] & 0x03) + 1),
    };
  }

  // An ADTS header for a raw AAC frame of n bytes. fmt: {profile (object type - 1), sri, ch}.
  function adtsHeader(fmt, n) {
    const len = n + 7;
    return Uint8Array.of(0xff, 0xf1, (fmt.profile << 6) | (fmt.sri << 2) | (fmt.ch >> 2),
      ((fmt.ch & 3) << 6) | (len >> 11), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc);
  }

  // FLV's AAC sequence header (an AudioSpecificConfig) → the ADTS header's fields. HE-AAC
  // (object type 5, SBR; 29, PS) is signalled as its AAC-LC core, at the core's rate: the
  // decoder finds the extension in the frames themselves.
  function parseASC(b) {
    if (!b || b.length < 2) return null;
    const ot = b[0] >> 3;
    const sri = ((b[0] & 0x07) << 1) | (b[1] >> 7);
    const ch = (b[1] >> 3) & 0x0f;
    if (!ot || sri >= RATES.length) return null; // an explicit 24-bit rate has no ADTS index
    return { profile: ot <= 4 ? ot - 1 : 1, sri, rate: RATES[sri], ch: ch || 2 };
  }

  // One frame of digital silence, for the gaps in a recording (localcore.js): AAC-LC
  // raw_data_blocks with no spectral data, valid at any sample rate (checked by decoding them
  // with ffmpeg at 22.05-48 kHz). fmt as for adtsHeader; more than two channels gets none.
  const SILENT = { 1: Uint8Array.of(0x00, 0xc8, 0x00, 0x80, 0x23, 0x80), 2: Uint8Array.of(0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80) };
  function silentFrame(fmt) {
    const raw = SILENT[fmt.ch];
    return raw ? concat(adtsHeader({ ...fmt, profile: 1 }, raw.length), raw) : null;
  }

  // Splits a byte run into ADTS frames: {frames: [{at, len, rate, ch, sri, profile, samples}],
  // used}; `used` is where an incomplete last frame starts. Skips junk between frames.
  function adtsFrames(b, from = 0) {
    const frames = [];
    let i = from;
    while (i + 7 <= b.length) {
      const h = adtsAt(b, i);
      if (!h) { i++; continue; }
      if (i + h.len > b.length) break;
      // a false sync inside junk: the next frame must start where this one ends (or the data ends)
      if (i + h.len + 2 <= b.length && !(b[i + h.len] === 0xff && (b[i + h.len + 1] & 0xf6) === 0xf0)) { i++; continue; }
      frames.push({ at: i, ...h });
      i += h.len;
    }
    return { frames, used: i };
  }

  // ---- HTTP-FLV ----------------------------------------------------------------------------

  // Incremental: push() each network chunk as it arrives and get the audio frames it
  // completed, [{t: the tag's timestamp (s), data: one ADTS frame, rate, ch, samples}].
  // Throws on a stream that isn't FLV, or isn't AAC (codec: FLV's SoundFormat number).
  function flvReader() {
    let buf = new Uint8Array(0);
    let started = false;
    let fmt = null;
    const R = { codec: null, fmt: null, video: false };
    R.push = (chunk) => {
      buf = buf.length ? concat(buf, chunk) : chunk;
      const frames = [];
      let i = 0;
      if (!started) {
        if (buf.length < 13) return frames;
        if (buf[0] !== 0x46 || buf[1] !== 0x4c || buf[2] !== 0x56) throw new Error('not an FLV stream');
        i = u32(buf, 5) + 4; // the header, then PreviousTagSize0
        if (i > buf.length) return frames;
        started = true;
      }
      while (i + 11 <= buf.length) {
        const type = buf[i] & 0x1f;
        const size = (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3];
        if (type !== 8 && type !== 9 && type !== 18) throw new Error(`FLV stream out of step (tag type ${type})`);
        if (i + 15 + size > buf.length) break;
        if (type === 9) R.video = true;
        if (type === 8 && size >= 2) {
          const d = i + 11;
          const ts = ((buf[i + 7] << 24) | (buf[i + 4] << 16) | (buf[i + 5] << 8) | buf[i + 6]) >>> 0;
          R.codec = buf[d] >> 4;
          if (R.codec !== 10) throw new Error(`the stream's audio isn't AAC (FLV sound format ${R.codec})`);
          if (buf[d + 1] === 0) {
            fmt = parseASC(buf.subarray(d + 2, d + size));
            R.fmt = fmt;
            if (!fmt) throw new Error('unsupported AAC configuration');
          } else if (fmt && size > 2) {
            const raw = buf.subarray(d + 2, d + size);
            frames.push({ t: ts / 1000, data: concat(adtsHeader(fmt, raw.length), raw), rate: fmt.rate, ch: fmt.ch, samples: 1024 });
          }
        }
        i += 15 + size; // tag header, body, PreviousTagSize
      }
      buf = buf.subarray(i);
      return frames;
    };
    return R;
  }

  // ---- bare ADTS (an Icecast-style .aac stream) ----------------------------------------------

  // Incremental like flvReader; these frames carry no timestamps (t: null).
  function adtsReader() {
    let buf = new Uint8Array(0);
    const R = {};
    R.push = (chunk) => {
      buf = buf.length ? concat(buf, chunk) : chunk;
      const { frames, used } = adtsFrames(buf);
      const out = frames.map((f) => ({ t: null, data: buf.slice(f.at, f.at + f.len), rate: f.rate, ch: f.ch, samples: f.samples }));
      buf = buf.subarray(used);
      return out;
    };
    return R;
  }

  // ---- MPEG-TS (HLS segments) ------------------------------------------------------------------

  // A PES timestamp (33 bits at 90 kHz), in seconds.
  const readPts = (b, i) => ((b[i] & 0x0e) * 536870912 + b[i + 1] * 4194304 + (b[i + 2] & 0xfe) * 16384 + b[i + 3] * 128 + (b[i + 4] >> 1)) / 90000;
  const PTS_WRAP = 2 ** 33 / 90000;

  // The AAC frames in one MPEG-TS segment, timed by their PES timestamps:
  // {frames: [{t (s, 33-bit: unwrap with ptsUnwrap), data, rate, ch, samples}], ctx}. ctx carries
  // the stream layout to the next segment (PAT/PMT aren't always first) and `codec` names an
  // audio stream that isn't ADTS AAC.
  function tsAudio(b, ctx = {}) {
    const c = { pmt: ctx.pmt ?? null, aac: ctx.aac ?? null, codec: ctx.codec ?? null };
    const pes = [];
    let cur = null;
    let i = 0;
    while (i + 188 <= b.length && !(b[i] === 0x47 && (i + 188 >= b.length || b[i + 188] === 0x47))) i++;
    for (; i + 188 <= b.length; i += 188) {
      if (b[i] !== 0x47) { // lost sync: find it again
        let j = i + 1;
        while (j + 188 <= b.length && !(b[j] === 0x47 && (j + 188 >= b.length || b[j + 188] === 0x47))) j++;
        i = j - 188;
        continue;
      }
      const pusi = b[i + 1] & 0x40;
      const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
      const afc = (b[i + 3] >> 4) & 3;
      const end = i + 188;
      let p = i + 4;
      if (afc & 2) p += 1 + b[p];
      if (!(afc & 1) || p >= end) continue;
      if (pid === 0 && pusi) {
        p += 1 + b[p]; // pointer field
        const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
        for (let q = p + 8; q + 4 <= Math.min(end, p + 3 + len - 4); q += 4) {
          if ((b[q] << 8 | b[q + 1]) !== 0) { c.pmt = ((b[q + 2] & 0x1f) << 8) | b[q + 3]; break; }
        }
      } else if (pid === c.pmt && pusi) {
        p += 1 + b[p];
        const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
        const stop = Math.min(end, p + 3 + len - 4);
        let q = p + 12 + (((b[p + 10] & 0x0f) << 8) | b[p + 11]);
        let aac = null, other = null;
        while (q + 5 <= stop) {
          const type = b[q], es = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
          if (type === 0x0f && aac == null) aac = es;
          else if ([0x03, 0x04, 0x11, 0x81, 0x87].includes(type)) other ??= type; // MP3, LATM, AC-3, E-AC-3
          q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4]);
        }
        c.aac = aac;
        c.codec = aac == null ? other : null;
        c.pmtSeen = true;
      } else if (pid === c.aac) {
        if (pusi) {
          cur = null;
          if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
          const t = b[p + 7] & 0x80 ? readPts(b, p + 9) : null;
          cur = { t, parts: [] };
          pes.push(cur);
          p += 9 + b[p + 8];
        }
        if (cur && p < end) cur.parts.push(b.subarray(p, end));
      }
    }
    // A frame can run on into the next PES: carry its start over. A PES's timestamp is that of
    // the first frame starting in it; the rest follow at their own durations.
    const frames = [];
    let carry = null, carryT = null;
    for (const e of pes) {
      const data = carry ? concat(carry, ...e.parts) : concat(...e.parts);
      const lead = carry ? carry.length : 0;
      const { frames: fs, used } = adtsFrames(data);
      let t = carryT;
      fs.forEach((f, k) => {
        if (f.at >= lead && (k === 0 || fs[k - 1].at < lead) && e.t != null) t = e.t;
        frames.push({ t, data: data.slice(f.at, f.at + f.len), rate: f.rate, ch: f.ch, samples: f.samples });
        if (t != null) t += f.samples / f.rate;
      });
      carry = used < data.length ? data.slice(used) : null;
      carryT = t;
    }
    return { frames, ctx: c };
  }

  // Incremental, for a live MPEG-TS stream over HTTP (one endless response): push() each chunk,
  // get the frames completed. Parses up to the last PES start of the audio stream it has seen
  // (what's after it may still be growing) and keeps the rest for the next chunk.
  function tsReader() {
    const HOLD = 2 * 1024 * 1024; // bytes held without an audio packet before giving up
    let buf = new Uint8Array(0);
    let ctx = {};
    const R = {};
    const synced = (b, i) => b[i] === 0x47 && (i + 188 >= b.length || b[i + 188] === 0x47);
    R.push = (chunk) => {
      buf = buf.length ? concat(buf, chunk) : chunk;
      let i = 0;
      while (i + 188 <= buf.length && !synced(buf, i)) i++;
      if (i) buf = buf.slice(i); // (bytes before the packets: a partial one, junk)
      if (ctx.aac == null) { // the layout first: PAT/PMT
        ctx = tsAudio(buf.subarray(0, Math.floor(buf.length / 188) * 188), ctx).ctx;
        if (ctx.codec != null) throw new Error(`the stream's audio isn't AAC (stream type 0x${ctx.codec.toString(16)})`);
        if (ctx.pmtSeen && ctx.aac == null) throw new Error('the MPEG-TS stream has no AAC audio');
        if (buf.length > HOLD) throw new Error('no MPEG-TS stream layout (PAT/PMT) found');
        if (ctx.aac == null) return [];
      }
      // up to the last packet starting an audio PES (what's after it may still be growing),
      // finding the packets again past one cut short
      let cut = -1;
      for (let j = 0; j + 188 <= buf.length;) {
        if (!synced(buf, j)) { j++; continue; }
        const pid = ((buf[j + 1] & 0x1f) << 8) | buf[j + 2];
        if ((buf[j + 1] & 0x40) && pid === ctx.aac) cut = j;
        j += 188;
      }
      if (cut <= 0) {
        if (buf.length > HOLD) throw new Error('MPEG-TS stream out of sync (no audio in 2 MB)');
        return [];
      }
      const out = tsAudio(buf.subarray(0, cut), ctx);
      ctx = out.ctx;
      buf = buf.slice(cut);
      return out.frames;
    };
    return R;
  }

  // 33-bit PES timestamps unwrapped against the last one seen (they wrap every ~26.5 h).
  function ptsUnwrap(t, ref) {
    if (t == null || ref == null) return t;
    while (t - ref < -PTS_WRAP / 2) t += PTS_WRAP;
    while (t - ref > PTS_WRAP / 2) t -= PTS_WRAP;
    return t;
  }

  // Apple's packed audio (an HLS segment of bare ADTS, timed by an ID3 PRIV
  // com.apple.streaming.transportStreamTimestamp): {frames, ctx} like tsAudio.
  function packedAudio(b) {
    let i = 0, t0 = null;
    while (b.length >= i + 10 && b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x33) {
      const size = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
      const tag = b.subarray(i + 10, i + 10 + size);
      const owner = 'com.apple.streaming.transportStreamTimestamp';
      for (let j = 0; j + 10 < tag.length; ) {
        const id = String.fromCharCode(tag[j], tag[j + 1], tag[j + 2], tag[j + 3]);
        const fs = u32(tag, j + 4);
        if (!/^[A-Z0-9]{4}$/.test(id) || fs <= 0) break;
        if (id === 'PRIV') {
          const body = tag.subarray(j + 10, j + 10 + fs);
          const z = body.indexOf(0);
          if (z === owner.length && String.fromCharCode(...body.subarray(0, z)) === owner && body.length >= z + 9) {
            const hi = body[z + 4] & 1, lo = u32(body, z + 5);
            t0 = (hi * 4294967296 + lo) / 90000;
          }
        }
        j += 10 + fs;
      }
      i += 10 + size;
    }
    const { frames } = adtsFrames(b, i);
    let t = t0;
    return {
      frames: frames.map((f) => {
        const out = { t, data: b.slice(f.at, f.at + f.len), rate: f.rate, ch: f.ch, samples: f.samples };
        if (t != null) t += f.samples / f.rate;
        return out;
      }),
      ctx: {},
    };
  }

  // ---- fragmented MP4 (HLS fMP4/CMAF: Bilibili's HLS; Twitch's audio-only can be) --------------

  const box = (b, i) => {
    let size = u32(b, i);
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    let hdr = 8;
    if (size === 1) { size = u32(b, i + 8) * 4294967296 + u32(b, i + 12); hdr = 16; } else if (size === 0) size = b.length - i;
    return { type, start: i, body: i + hdr, end: Math.min(b.length, i + size) };
  };
  function* boxes(b, from = 0, to = b.length) {
    for (let i = from; i + 8 <= to;) {
      const x = box(b, i);
      if (x.end <= i) return;
      yield x;
      i = x.end;
    }
  }
  const child = (b, x, type) => { for (const c of boxes(b, x.body, x.end)) if (c.type === type) return c; return null; };
  const path = (b, x, ...types) => types.reduce((acc, t) => acc && child(b, acc, t), x);

  // The AudioSpecificConfig in an ES descriptor (ES_Descriptor 3 > DecoderConfigDescriptor 4 >
  // DecoderSpecificInfo 5), as parseASC reads it.
  function esdsConfig(b, i, end) {
    while (i + 2 <= end) {
      const tag = b[i++];
      let len = 0;
      for (let k = 0; k < 4 && i < end; k++) { const v = b[i++]; len = (len << 7) | (v & 0x7f); if (!(v & 0x80)) break; }
      if (tag === 0x03) { // ES_ID, flags, then optional parts, then its descriptors
        const flags = b[i + 2];
        i += 3;
        if (flags & 0x80) i += 2;
        if (flags & 0x40) i += 1 + b[i];
        if (flags & 0x20) i += 2;
      } else if (tag === 0x04) {
        i += 13; // object type, stream type, buffer size, bitrates; then its descriptors
      } else if (tag === 0x05) {
        return parseASC(b.subarray(i, i + len));
      } else {
        i += len;
      }
    }
    return null;
  }

  // The init segment's sound track: {track, timescale, fmt, trex} (null: no AAC sound track).
  function mp4Init(b) {
    let moov = null;
    for (const x of boxes(b)) if (x.type === 'moov') moov = x;
    if (!moov) return null;
    for (const trak of boxes(b, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue;
      const hdlr = path(b, trak, 'mdia', 'hdlr');
      if (!hdlr || String.fromCharCode(...b.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'soun') continue;
      const tkhd = child(b, trak, 'tkhd');
      const track = u32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
      const mdhd = path(b, trak, 'mdia', 'mdhd');
      const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
      const stsd = path(b, trak, 'mdia', 'minf', 'stbl', 'stsd');
      if (!stsd) continue;
      const entry = box(b, stsd.body + 8);
      if (entry.type !== 'mp4a') return { track, timescale, fmt: null, codec: entry.type };
      // mp4a: 28 bytes of AudioSampleEntry, then its boxes; esds: the ES descriptor's decoder config
      let esds = null;
      for (const c of boxes(b, entry.body + 28, entry.end)) if (c.type === 'esds') esds = c;
      const fmt = esds ? esdsConfig(b, esds.body + 4, esds.end) : null;
      // the movie's defaults for this track's fragments (mvex/trex)
      let trex = null;
      const mvex = child(b, moov, 'mvex');
      if (mvex) for (const t of boxes(b, mvex.body, mvex.end)) if (t.type === 'trex' && u32(b, t.body + 4) === track) trex = { dur: u32(b, t.body + 12), size: u32(b, t.body + 16) };
      return { track, timescale, fmt, trex, codec: 'mp4a' };
    }
    return null;
  }

  // One fMP4 media segment's frames of init's track: {frames: [{t, data (ADTS), rate, ch, samples}]}.
  function mp4Audio(b, init) {
    const frames = [];
    if (!init?.fmt) return { frames };
    const f = init.fmt;
    for (const moof of boxes(b)) {
      if (moof.type !== 'moof') continue;
      // Data offsets (ISO 14496-12): a traf's base is tfhd's base-data-offset, else the moof
      // (default-base-is-moof), else where the previous traf's data ended; a trun's data_offset
      // is from that base, and a trun without one follows the previous run's data.
      let trafEnd = moof.start;
      for (const traf of boxes(b, moof.body, moof.end)) {
        if (traf.type !== 'traf') continue;
        const tfhd = child(b, traf, 'tfhd');
        if (!tfhd) continue;
        const mine = u32(b, tfhd.body + 4) === init.track;
        const hf = u32(b, tfhd.body) & 0xffffff;
        let p = tfhd.body + 8;
        let base = hf & 0x20000 ? moof.start : trafEnd;
        let defDur = (mine && init.trex?.dur) || 1024 * init.timescale / f.rate, defSize = (mine && init.trex?.size) || 0;
        if (hf & 0x01) { base = u32(b, p) * 4294967296 + u32(b, p + 4); p += 8; }
        if (hf & 0x02) p += 4;
        if (hf & 0x08) { defDur = u32(b, p); p += 4; }
        if (hf & 0x10) { defSize = u32(b, p); p += 4; }
        const tfdt = child(b, traf, 'tfdt');
        let t = tfdt ? (b[tfdt.body] === 1 ? u32(b, tfdt.body + 4) * 4294967296 + u32(b, tfdt.body + 8) : u32(b, tfdt.body + 4)) : null;
        let end = base;
        for (const trun of boxes(b, traf.body, traf.end)) {
          if (trun.type !== 'trun') continue;
          const rf = u32(b, trun.body) & 0xffffff;
          const n = u32(b, trun.body + 4);
          let q = trun.body + 8;
          let off = end;
          if (rf & 0x001) { off = base + (u32(b, q) | 0); q += 4; }
          if (rf & 0x004) q += 4;
          for (let k = 0; k < n; k++) {
            let dur = defDur, size = defSize;
            if (rf & 0x100) { dur = u32(b, q); q += 4; }
            if (rf & 0x200) { size = u32(b, q); q += 4; }
            if (rf & 0x400) q += 4;
            if (rf & 0x800) q += 4;
            if (mine && size && off + size <= b.length) {
              const raw = b.subarray(off, off + size);
              frames.push({ t: t == null ? null : t / init.timescale, data: concat(adtsHeader(f, raw.length), raw), rate: f.rate, ch: f.ch, samples: 1024 });
            }
            off += size;
            if (t != null) t += dur;
          }
          end = off;
        }
        trafEnd = end;
      }
    }
    return { frames };
  }

  // What a stream's first bytes are: 'flv', 'hls' (a playlist), 'ts', 'adts', or null.
  function sniff(b) {
    if (b.length >= 3 && b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56) return 'flv';
    if (b.length >= 7 && String.fromCharCode(...b.subarray(0, 7)) === '#EXTM3U') return 'hls';
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf && String.fromCharCode(...b.subarray(3, 10)) === '#EXTM3U') return 'hls';
    if (b.length > 188 && b[0] === 0x47 && b[188] === 0x47) return 'ts';
    if (adtsAt(b, 0) || (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)) return 'adts';
    return null;
  }

  root.FoneDemux = { RATES, concat, adtsAt, adtsHeader, adtsFrames, parseASC, silentFrame, flvReader, adtsReader, tsAudio, tsReader, packedAudio, mp4Init, mp4Audio, ptsUnwrap, sniff, PTS_WRAP };
})(typeof globalThis !== 'undefined' ? globalThis : this);
