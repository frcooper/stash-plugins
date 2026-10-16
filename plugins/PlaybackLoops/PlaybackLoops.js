(function () {
  "use strict";

  const PLAYER_ID = "VideoJsPlayer"; // ui/v2.5/src/components/ScenePlayer/util.ts
  const DEFAULT_FPS = 30;
  const CUT_TAG = "{CUT}";
  const MAX_GAP = 32; // px between the loop line and the seek bar, at most
  const MARK_HEAD = 12; // px a mark sticks up above the loop line
  const REMOVE_DISTANCE = 40; // px a mark has to be dragged off the line to delete it
  const RANGE_LAYER = 9; // px between layers of Stash's marker ranges (markers.ts)
  const RANGE_MIN = 3; // px a marker range is squeezed to, at least

  const api = window.PluginApi;
  const { gql } = api.libraries.Apollo;
  const getClient = () => api.utils.StashService.getClient();

  // the current scene, captured from ScenePlayer props
  let sceneId = null;
  let sceneFps = null;

  api.patch.before("ScenePlayer", function (...args) {
    const scene = args[0] && args[0].scene;
    sceneId = scene ? scene.id : null;
    const files = scene && scene.files;
    const rate = files && files.length ? files[0].frame_rate : 0;
    sceneFps = rate > 0 ? rate : null;
    return args;
  });

  function getPlayer() {
    const el = document.getElementById(PLAYER_ID);
    const player = el && el.player;
    return player && !player.isDisposed() ? player : null;
  }

  function fps() {
    return sceneFps || DEFAULT_FPS;
  }

  function frameOf(t) {
    return Math.round(t * fps());
  }

  function duration(player) {
    const d = player.duration();
    return d > 0 && isFinite(d) ? d : 0;
  }

  function formatTime(t) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(2).padStart(5, "0");
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + s;
  }

  function play(player) {
    const p = player.play();
    if (p && p.catch) p.catch(() => {});
  }

  // --- keyframe index -------------------------------------------------------

  // A seek decodes from the keyframe before its target, so a loop that starts
  // on a keyframe jumps back without a pause. For a direct MP4/MOV stream the
  // keyframe times are read from the video track's sample tables in the moov
  // box, with a few small Range requests (the video itself isn't downloaded).
  // Anything else (other containers, transcodes, servers without Range
  // support, errors) has no index, quietly.

  const TOP_BOXES = ["ftyp", "moov", "mdat", "free", "skip", "wide", "uuid", "pnot", "meta", "pdin", "junk"];
  const MAX_MOOV = 64 * 1024 * 1024;

  function fourcc(v, pos) {
    return String.fromCharCode(v.getUint8(pos), v.getUint8(pos + 1), v.getUint8(pos + 2), v.getUint8(pos + 3));
  }

  function u64(v, pos) {
    return v.getUint32(pos) * 2 ** 32 + v.getUint32(pos + 4);
  }

  async function fetchRange(url, start, end, signal) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal.addEventListener("abort", abort);
    try {
      const res = await fetch(url, { headers: { Range: "bytes=" + start + "-" + end }, signal: ctrl.signal });
      if (res.status !== 206) {
        // a server that ignores Range would send the whole video
        ctrl.abort();
        throw new Error("no range support (HTTP " + res.status + ")");
      }
      const total = /\/(\d+)\s*$/.exec(res.headers.get("Content-Range") || "");
      return { view: new DataView(await res.arrayBuffer()), total: total ? +total[1] : Infinity };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // box header at pos: [type, header size, box size]
  function boxHeader(v, pos, end) {
    if (pos + 8 > v.byteLength) return null;
    let size = v.getUint32(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > v.byteLength) return null;
      size = u64(v, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    return size < header ? null : [fourcc(v, pos + 4), header, size];
  }

  // the moov box's contents, walking the top-level boxes (moov often comes
  // after mdat)
  async function readMoov(url, signal) {
    let pos = 0;
    let total = Infinity;
    for (let i = 0; i < 32 && pos + 8 <= total; i++) {
      const r = await fetchRange(url, pos, pos + 15, signal);
      total = Math.min(total, r.total);
      const box = boxHeader(r.view, 0, total - pos);
      if (!box || !TOP_BOXES.includes(box[0])) return null;
      const [type, header, size] = box;
      if (type === "moov") {
        if (size > MAX_MOOV) return null;
        return (await fetchRange(url, pos + header, pos + size - 1, signal)).view;
      }
      pos += size;
    }
    return null;
  }

  // calls fn(type, start, end) for the boxes in [start, end); fn returns
  // true to stop
  function eachBox(v, start, end, fn) {
    for (let pos = start; pos + 8 <= end; ) {
      const box = boxHeader(v, pos, end);
      if (!box || pos + box[2] > end) return;
      if (fn(box[0], pos + box[1], pos + box[2])) return;
      pos += box[2];
    }
  }

  function findBox(v, start, end, path) {
    let range = [start, end];
    for (const name of path.split("/")) {
      let found = null;
      eachBox(v, range[0], range[1], (type, s, e) => type === name && (found = [s, e]));
      if (!found) return null;
      range = found;
    }
    return range;
  }

  // timescale of an mvhd or mdhd box
  function timescale(v, [s]) {
    return v.getUint32(s + (v.getUint8(s) === 1 ? 20 : 12));
  }

  // Presentation times of the video track's sync samples, in seconds on the
  // video element's timeline: decode time (stts) plus composition offset
  // (ctts), shifted by the edit list. null without a usable sync sample table
  // (no stss means every frame is a keyframe; fragmented files keep their
  // samples outside moov).
  function parseKeyframes(v) {
    const end = v.byteLength;
    const mvhd = findBox(v, 0, end, "mvhd");
    let trak = null;
    eachBox(v, 0, end, (type, s, e) => {
      if (type !== "trak") return false;
      const hdlr = findBox(v, s, e, "mdia/hdlr");
      if (hdlr && fourcc(v, hdlr[0] + 8) === "vide") trak = [s, e];
      return !!trak;
    });
    if (!mvhd || !trak) return null;
    const mdhd = findBox(v, trak[0], trak[1], "mdia/mdhd");
    const stbl = findBox(v, trak[0], trak[1], "mdia/minf/stbl");
    if (!mdhd || !stbl) return null;
    const scale = timescale(v, mdhd);
    const stts = findBox(v, stbl[0], stbl[1], "stts");
    const stss = findBox(v, stbl[0], stbl[1], "stss");
    const ctts = findBox(v, stbl[0], stbl[1], "ctts");
    if (!scale || !stts || !stss) return null;

    // edit list: leading empty edits delay the track, the first real edit
    // says where in the media presentation starts
    let delay = 0;
    let mediaStart = 0;
    const elst = findBox(v, trak[0], trak[1], "edts/elst");
    if (elst) {
      const wide = v.getUint8(elst[0]) === 1;
      const n = v.getUint32(elst[0] + 4);
      const movieScale = timescale(v, mvhd) || 1;
      for (let i = 0, p = elst[0] + 8; i < n && p + (wide ? 20 : 12) <= elst[1]; i++, p += wide ? 20 : 12) {
        const dur = wide ? u64(v, p) : v.getUint32(p);
        const media = wide ? v.getInt32(p + 8) * 2 ** 32 + v.getUint32(p + 12) : v.getInt32(p + 4);
        if (media === -1) {
          delay += dur / movieScale;
        } else {
          mediaStart = media;
          break;
        }
      }
    }

    const syncCount = Math.min(v.getUint32(stss[0] + 4), (stss[1] - stss[0] - 8) / 4);
    if (!syncCount) return null;
    const sync = [];
    for (let i = 0; i < syncCount; i++) sync.push(v.getUint32(stss[0] + 8 + i * 4));

    // walk samples in decode order up to the last sync sample
    const runs = (box) => {
      const n = box ? Math.min(v.getUint32(box[0] + 4), (box[1] - box[0] - 8) / 8) : 0;
      return { box, n, i: 0, left: n ? v.getUint32(box[0] + 8) : 0 };
    };
    const next = (r, signed) => {
      while (r.left === 0 && r.i + 1 < r.n) r.left = v.getUint32(r.box[0] + 8 + ++r.i * 8);
      if (r.left === 0) return null;
      r.left--;
      const p = r.box[0] + 12 + r.i * 8;
      return signed ? v.getInt32(p) : v.getUint32(p);
    };
    const durations = runs(stts);
    const offsets = runs(ctts);
    const times = [];
    let dts = 0;
    let k = 0;
    for (let sample = 1; k < sync.length; sample++) {
      const d = next(durations, false);
      if (d === null) break;
      const cto = ctts ? next(offsets, true) || 0 : 0;
      if (sample === sync[k]) {
        const t = (dts + cto - mediaStart) / scale + delay;
        if (t >= 0) times.push(t);
        k++;
      }
      dts += d;
    }
    times.sort((a, b) => a - b);
    return times.length ? times : null;
  }

  // Stash's transcodes are /scene/<id>/stream.<ext> (and may be offset);
  // its direct stream is /scene/<id>/stream
  function canIndex(player) {
    const src = player.currentSrc();
    const type = (player.currentType() || "").toLowerCase();
    if (!src || /mpegurl|dash/.test(type)) return false;
    try {
      const url = new URL(src, location.href);
      return /^https?:$/.test(url.protocol) && !/\/stream\.\w+$/.test(url.pathname) && !/\.(m3u8|mpd)$/.test(url.pathname);
    } catch (e) {
      return false;
    }
  }

  function loadKeyframes(player) {
    const s = player.playbackLoops_;
    const src = player.currentSrc();
    if (s.keyframesSrc === src) return;
    if (s.keyframesAbort) s.keyframesAbort.abort();
    s.keyframesSrc = src;
    s.keyframes = null;
    s.keyframesAbort = null;
    drawKeyframes(player);
    if (!canIndex(player)) return;

    const ctrl = new AbortController();
    s.keyframesAbort = ctrl;
    readMoov(src, ctrl.signal)
      .then((moov) => {
        const times = moov && parseKeyframes(moov);
        if (ctrl.signal.aborted) return;
        s.keyframes = times;
        console.debug("[PlaybackLoops] keyframes", times ? times.length : "none");
        drawKeyframes(player);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) console.debug("[PlaybackLoops] no keyframe index:", e.message || e);
      })
      .finally(() => {
        if (s.keyframesAbort === ctrl) s.keyframesAbort = null;
      });
  }

  // the keyframe nearest to t inside [lo, hi], or null
  function nearestKeyframe(player, t, lo, hi) {
    const keys = player.playbackLoops_.keyframes;
    if (!keys) return null;
    let a = 0;
    let b = keys.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (keys[m] < t) a = m + 1;
      else b = m;
    }
    let best = null;
    [a - 1, a, a - 2, a + 1].forEach((i) => {
      const k = keys[i];
      if (k == null || k < lo || k > hi) return;
      if (best === null || Math.abs(k - t) < Math.abs(best - t)) best = k;
    });
    return best;
  }

  function isKeyframe(player, t) {
    const k = nearestKeyframe(player, t, -Infinity, Infinity);
    return k !== null && Math.abs(k - t) < 0.5 / fps();
  }

  // --- loop state -----------------------------------------------------------

  // Marks sit on frame boundaries. The loop plays frames [start, end): the end
  // mark is where playback jumps back, so its own frame is not part of the loop.
  function times(s) {
    return s.marks.map((m) => m.t);
  }

  function looping(s) {
    return s.marks.length === 2 && s.mode !== "off";
  }

  function startTime(s) {
    return s.marks[0].t + 0.5 / fps();
  }

  function lastFrameTime(s) {
    const f = fps();
    return Math.max(s.marks[0].t + 0.5 / f, s.marks[1].t - 0.5 / f);
  }

  function snap(player, t) {
    const f = fps();
    return Math.min(Math.max(Math.round(t * f) / f, 0), duration(player));
  }

  // exact: t is a keyframe time, keep it off the frame grid
  function addMark(player, t, exact) {
    const s = player.playbackLoops_;
    if (!exact) t = snap(player, t);
    const f = fps();
    const same = s.marks.find((m) => Math.abs(m.t - t) < 0.5 / f);
    if (same) return same;
    if (s.marks.length >= 2) return null;

    const mark = { t, el: null, removing: false };
    s.marks.push(mark);
    s.marks.sort((a, b) => a.t - b.t);
    if (s.marks.length === 2 && s.mode === "off") s.mode = "forever";
    update(player);
    return mark;
  }

  function removeMark(player, mark) {
    const s = player.playbackLoops_;
    s.marks = s.marks.filter((m) => m !== mark);
    if (mark.el) mark.el.remove();
    if (s.selected === mark) s.selected = null;
    if (s.marks.length < 2) s.mode = "off";
    update(player);
  }

  function clearMarks(player) {
    const s = player.playbackLoops_;
    s.marks.slice().forEach((m) => removeMark(player, m));
  }

  function select(player, mark) {
    const s = player.playbackLoops_;
    if (s.selected === mark) return;
    s.selected = mark;
    render(player);
  }

  // A mark can't be dragged onto or past the other one.
  function clampMark(player, mark, t) {
    const s = player.playbackLoops_;
    const f = fps();
    const i = s.marks.indexOf(mark);
    const other = s.marks[1 - i];
    if (other) {
      if (i === 0) t = Math.min(t, other.t - 1 / f);
      else t = Math.max(t, other.t + 1 / f);
    }
    return Math.min(Math.max(t, 0), duration(player));
  }

  // Seek for the loop. The `seeked` handler in attach() watches where it lands.
  function loopSeek(player, t) {
    const s = player.playbackLoops_;
    s.last = null;
    s.loopSeek = { t, until: performance.now() + 500, retried: false };
    player.currentTime(t);
  }

  // If something else sends playback to the start of the video right after a
  // loop seek, seek again once and say so in the console. Only a landing under
  // 0.5 s for a target past 1 s counts, and any input from the user (who may
  // well be seeking to the start) disarms it, so a good jump is never seeked
  // twice.
  function checkLoopSeek(player) {
    const s = player.playbackLoops_;
    const target = s.loopSeek;
    if (!target) return;
    if (performance.now() > target.until || target.t < 1) {
      s.loopSeek = null;
      return;
    }
    const now = player.currentTime();
    if (now >= 0.5) return;
    console.warn("[PlaybackLoops] loop seek to " + target.t.toFixed(3) + "s landed at " + now.toFixed(3) + "s");
    if (target.retried) {
      s.loopSeek = null;
      return;
    }
    target.retried = true;
    s.last = null;
    player.currentTime(target.t);
  }

  function seekStart(player) {
    loopSeek(player, startTime(player.playbackLoops_));
  }

  function endOfLoop(player) {
    const s = player.playbackLoops_;
    s.last = null;
    console.debug("[PlaybackLoops] end of loop", {
      mode: s.mode,
      at: player.currentTime(),
      marks: times(s),
      to: s.mode === "once" ? lastFrameTime(s) : startTime(s),
    });
    if (player.ended()) {
      // caught on the video's last timeupdate: its `ended` event is already
      // queued and must not reach video.js (which pauses) or Stash (which moves
      // on to the next scene)
      s.swallowEnded = true;
      setTimeout(() => (s.swallowEnded = false), 1000);
    }
    if (s.mode === "once") {
      player.pause();
      loopSeek(player, lastFrameTime(s));
    } else {
      seekStart(player);
      if (player.paused()) play(player);
    }
  }

  // Called for every frame shown, with its time (from the
  // requestVideoFrameCallback metadata), and on timeupdate. The loop only fires
  // when playback runs from inside the loop across its end, so seeking outside
  // the loop and playing on works like it does without one.
  // With frame times the jump is made while the loop's last frame is on screen,
  // as soon as the next frame would be the end mark's, so that frame (not part
  // of the loop) is never shown. timeupdate only catches a crossing that
  // already happened, for when frame callbacks aren't available.
  function check(player, frameTime) {
    const s = player.playbackLoops_;
    if (player.seeking()) {
      s.last = null;
      return;
    }
    const byFrame = frameTime != null;
    const t = byFrame ? frameTime : player.currentTime();
    const last = s.last;
    s.last = t;
    if (s.drag || !looping(s) || last == null) return;

    const f = fps();
    const [a, b] = times(s);
    const edge = b - 0.5 / f;
    const next = byFrame && !player.paused() ? t + 1 / f : t;
    if (last >= a - 1 / f && last < edge && next >= edge && t - last < 2) {
      endOfLoop(player);
    }
  }

  // Loop once / loop forever. Pressing the one that's already on does nothing.
  // Switching a mode on keeps the playhead where it is if it's inside the loop
  // (so flipping between the two doesn't restart the loop), otherwise it goes
  // to the start of the loop; either way playback starts.
  function setMode(player, mode) {
    const s = player.playbackLoops_;
    if (s.marks.length < 2 || s.mode === mode) return;
    s.mode = mode;
    const t = player.currentTime();
    if (t < s.marks[0].t || t >= lastFrameTime(s) + 0.25 / fps()) seekStart(player);
    if (player.paused()) play(player);
    update(player);
  }

  function loopForever(player) {
    setMode(player, "forever");
  }

  function loopOnce(player) {
    setMode(player, "once");
  }

  // Replace the marks with a loop over [a, b) and play it from its start, in
  // the mode that's on (loop forever if none is). A start on a keyframe (a
  // Shift-snapped cut) stays on it.
  function loopRange(player, a, b) {
    const s = player.playbackLoops_;
    const f = fps();
    if (!duration(player) || !(b > a)) return;
    const mode = s.mode === "off" ? "forever" : s.mode;
    clearMarks(player);
    const k = nearestKeyframe(player, a, a - 0.5 / f, a + 0.5 / f);
    const start = addMark(player, k === null ? a : k, k !== null);
    addMark(player, Math.max(b, start.t + 1 / f));
    if (s.marks.length < 2) return;
    s.mode = mode;
    seekStart(player);
    if (player.paused()) play(player);
    update(player);
  }

  // Shift+L: switch looping off and back on without losing the marks
  function toggleLooping(player) {
    const s = player.playbackLoops_;
    if (s.mode === "off") {
      setMode(player, "forever");
    } else {
      s.mode = "off";
      update(player);
    }
  }

  // l: mark the current time, a third press clears both marks (as Stash's own
  // A/B loop key did)
  function markHere(player) {
    const s = player.playbackLoops_;
    if (s.marks.length < 2) {
      const mark = addMark(player, player.currentTime());
      if (mark) select(player, mark);
    } else {
      clearMarks(player);
    }
  }

  // --- cut ------------------------------------------------------------------

  let cutTagId = null;

  async function findOrCreateCutTag() {
    if (cutTagId) return cutTagId;
    const res = await getClient().query({
      query: gql`
        query PlaybackLoopsFindTag($name: String!) {
          findTags(
            tag_filter: { name: { value: $name, modifier: EQUALS } }
            filter: { per_page: -1 }
          ) {
            tags {
              id
              name
            }
          }
        }
      `,
      variables: { name: CUT_TAG },
      fetchPolicy: "network-only",
    });
    const tags = res.data.findTags.tags;
    const tag = tags.find((t) => t.name === CUT_TAG) || tags[0];
    if (tag) {
      cutTagId = tag.id;
    } else {
      const created = await getClient().mutate({
        mutation: gql`
          mutation PlaybackLoopsCreateTag($input: TagCreateInput!) {
            tagCreate(input: $input) {
              id
            }
          }
        `,
        variables: { input: { name: CUT_TAG } },
      });
      cutTagId = created.data.tagCreate.id;
    }
    return cutTagId;
  }

  async function findScene(id) {
    const res = await getClient().query({
      query: gql`
        query PlaybackLoopsScene($id: ID!) {
          findScene(id: $id) {
            tags {
              id
            }
            scene_markers {
              seconds
              end_seconds
            }
          }
        }
      `,
      variables: { id },
      fetchPolicy: "network-only",
    });
    const scene = res.data.findScene;
    if (!scene) throw new Error("scene " + id + " not found");
    return scene;
  }

  async function cut(player) {
    const s = player.playbackLoops_;
    if (s.marks.length < 2 || s.cutting) return;
    if (!s.sceneId) {
      toast(player, "Cut failed: no scene", true);
      return;
    }

    s.cutting = true;
    render(player);
    const [a, b] = times(s);
    const title = "F" + frameOf(a) + "-F" + frameOf(b);
    try {
      const scene = await findScene(s.sceneId);
      // a marker over the same frames already exists: leave it at that
      const exists = scene.scene_markers.some(
        (m) =>
          m.end_seconds != null &&
          frameOf(m.seconds) === frameOf(a) &&
          frameOf(m.end_seconds) === frameOf(b)
      );
      if (exists) {
        toast(player, "Already cut: " + title);
        return;
      }

      const tagId = await findOrCreateCutTag();
      const tagIds = scene.tags.map((t) => t.id);
      await getClient().mutate({
        mutation: gql`
          mutation PlaybackLoopsCut($input: SceneMarkerCreateInput!) {
            sceneMarkerCreate(input: $input) {
              id
            }
          }
        `,
        variables: {
          input: {
            title,
            seconds: a,
            end_seconds: b,
            scene_id: s.sceneId,
            primary_tag_id: tagId,
            tag_ids: tagIds.filter((id) => id !== tagId),
          },
        },
        // what Stash's own marker create does (useSceneMarkerCreate): drop the
        // cached marker data so the markers pane, the seek bar and the marker
        // lists refetch
        update(cache) {
          cache.evict({
            id: cache.identify({ __typename: "Scene", id: s.sceneId }),
            fieldName: "scene_markers",
          });
          [tagId].concat(tagIds).forEach((id) =>
            cache.evict({
              id: cache.identify({ __typename: "Tag", id }),
              fieldName: "scene_marker_count",
            })
          );
          const DROP = (_value, { DELETE }) => DELETE;
          cache.modify({
            fields: {
              findScenes: DROP,
              findSceneMarkers: DROP,
              markerStrings: DROP,
              sceneMarkerTags: DROP,
              findStudios: DROP,
              findTags: DROP,
            },
          });
          cache.gc();
        },
      });
      toast(player, "Cut saved: " + title);
    } catch (e) {
      console.error("[PlaybackLoops] cut failed", e);
      cutTagId = null;
      toast(player, "Cut failed: " + (e.message || e), true);
    } finally {
      s.cutting = false;
      render(player);
    }
  }

  function toast(player, message, isError) {
    const s = player.playbackLoops_;
    s.toast.textContent = message;
    s.toast.classList.toggle("is-error", !!isError);
    s.toast.classList.add("is-shown");
    clearTimeout(s.toastTimer);
    s.toastTimer = setTimeout(() => s.toast.classList.remove("is-shown"), 2500);
  }

  // --- drawing --------------------------------------------------------------

  function parseColor(str) {
    const n = (str || "").match(/[\d.]+/g);
    if (!n || n.length < 3) return null;
    return { r: +n[0], g: +n[1], b: +n[2], a: n.length > 3 ? +n[3] : 1 };
  }

  function invert(str, fallback) {
    const c = parseColor(str);
    if (!c || c.a === 0) return fallback;
    return "rgba(" + (255 - c.r) + ", " + (255 - c.g) + ", " + (255 - c.b) + ", " + c.a + ")";
  }

  // Line up the loop line with the seek bar: same width and thickness, above it
  // by 1.5x the thickness (32px at most).
  function layout(player) {
    const s = player.playbackLoops_;
    const bar = player.controlBar && player.controlBar.el();
    const holder = bar && bar.querySelector(".vjs-progress-holder");
    const hr = holder && holder.getBoundingClientRect();
    if (!hr || hr.width === 0 || hr.height === 0) {
      s.track.classList.remove("has-layout");
      return;
    }

    // video.js thickens the seek bar (with a transition) while it is hovered or
    // focused, and the bar and the marker ranges above it move as it does.
    // Its thinnest is its rest state; place the line vertically only then, so
    // it stays put while the bar grows and shrinks.
    if (!s.thickness || hr.height < s.thickness) s.thickness = hr.height;
    const thick = s.thickness;
    const gap = Math.min(1.5 * thick, MAX_GAP);
    const padBottom = gap / 2;
    const br = bar.getBoundingClientRect();
    const pr = s.progress && s.progress.getBoundingClientRect();
    if (s.lineTop == null || hr.height <= thick + 0.5) {
      const middle = hr.top + hr.height / 2;
      s.lineTop = middle - thick / 2 - gap - thick - br.top;
      // the marker ranges go below the bar, clear of it at its thickest
      if (pr) {
        s.rangeTop = middle + thick / 2 + thick - pr.top;
        s.rangeBottom = pr.height - 1;
      }
    }

    const style = s.track.style;
    style.left = hr.left - br.left + "px";
    style.width = hr.width + "px";
    style.top = s.lineTop - MARK_HEAD + "px";
    style.height = MARK_HEAD + thick + padBottom + "px";
    style.setProperty("--pbl-thick", thick + "px");
    style.setProperty("--pbl-head", MARK_HEAD + "px");

    const play = holder.querySelector(".vjs-play-progress");
    const holderColor = getComputedStyle(holder).backgroundColor;
    const playColor = play ? getComputedStyle(play).backgroundColor : "";
    style.setProperty("--pbl-bg", invert(holderColor, "rgba(140, 122, 96, 0.5)"));
    style.setProperty("--pbl-fg", invert(playColor, "rgb(0, 0, 0)"));
    style.setProperty("--pbl-fg-raw", playColor || "rgb(255, 255, 255)");

    s.track.classList.add("has-layout");
    placeRanges(player);
    drawTicks(player);
    drawKeyframes(player);
  }

  // Stash draws markers that have an end time (cuts among them) as bars
  // stacked in layers above the seek bar, where the loop line goes. Move them
  // below the bar, the first layer nearest it, squeezed to fit above the
  // buttons. Stash sets each bar's layer as its `bottom`; the CSS overrides
  // that, and the layer is read back from it here.
  function placeRanges(player) {
    const s = player.playbackLoops_;
    if (!s.progress || s.rangeTop == null) return;
    const ranges = Array.from(s.progress.querySelectorAll(".vjs-marker-range"));
    s.progress.classList.add("pbl-ranges-below");
    if (!ranges.length) return;
    const layerOf = (el) => Math.max(0, Math.round((parseFloat(el.style.bottom) || 0) / RANGE_LAYER));
    const layers = Math.max(...ranges.map(layerOf)) + 1;
    const pitch = Math.max(Math.min(RANGE_LAYER, (s.rangeBottom - s.rangeTop) / layers), RANGE_MIN + 1);
    ranges.forEach((el) => {
      el.style.top = s.rangeTop + layerOf(el) * pitch + "px";
      el.style.height = pitch - 1 + "px";
    });
  }

  // second and minute steps for the graduations
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

  function drawTicks(player) {
    const s = player.playbackLoops_;
    const { ctx, w, h, dpr } = sizeCanvas(s.ticks);
    const d = duration(player);
    if (!d || !w) return;
    const pxPerSec = s.ticks.clientWidth / d;
    const minor = STEPS.find((step) => step * pxPerSec >= 6) || STEPS[STEPS.length - 1];
    const major =
      STEPS.find((step) => step % minor === 0 && step >= minor * 4) || minor * 5;

    const tickW = Math.max(1, Math.round(dpr));
    const minorH = Math.max(1, Math.round(s.thickness * dpr));
    ctx.fillStyle = "#fff";
    for (let i = 1; i * minor < d; i++) {
      const t = i * minor;
      const x = Math.round((t / d) * w - tickW / 2);
      const th = t % major === 0 ? h : minorH;
      ctx.fillRect(x, h - th, tickW, th);
    }
  }

  function sizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr };
  }

  // keyframes: small triangles in their own colour pointing down at the line,
  // left out where they're too close to tell apart
  function drawKeyframes(player) {
    const s = player.playbackLoops_;
    const keys = s.keyframes;
    s.track.classList.toggle("has-keyframes", !!keys);
    const { ctx, w, h } = sizeCanvas(s.keys);
    const d = duration(player);
    if (!keys || !d || !w) return;
    const half = h * 0.6;
    ctx.fillStyle = getComputedStyle(s.keys).color;
    let lastX = -Infinity;
    keys.forEach((t) => {
      const x = (t / d) * w;
      if (x - lastX < 2.5 * half) return;
      ctx.beginPath();
      ctx.moveTo(x - half, 0);
      ctx.lineTo(x + half, 0);
      ctx.lineTo(x, h);
      ctx.fill();
      lastX = x;
    });
  }

  function percent(player, t) {
    const d = duration(player);
    return d ? (t / d) * 100 + "%" : "0";
  }

  function render(player) {
    const s = player.playbackLoops_;
    s.track.classList.toggle("is-ready", duration(player) > 0);

    s.marks.forEach((m, i) => {
      if (!m.el) {
        m.el = document.createElement("div");
        m.el.className = "pbl-mark";
        s.line.append(m.el);
      }
      m.el.style.left = percent(player, m.t);
      m.el.classList.toggle("is-start", i === 0 && s.marks.length === 2);
      m.el.classList.toggle("is-end", i === 1);
      m.el.classList.toggle("is-selected", m === s.selected);
      m.el.classList.toggle("is-removing", m.removing);
      m.el.title =
        label(player, m.t) + " — drag to move (Shift snaps the start to a keyframe), drag off or right-click to remove";
    });

    const two = s.marks.length === 2;
    s.region.classList.toggle("is-shown", two);
    s.region.classList.toggle("is-active", looping(s));
    if (two) {
      const [a, b] = times(s);
      s.region.style.left = percent(player, a);
      s.region.style.width = percent(player, b - a);
    }

    const btn = s.buttons;
    btn.once.classList.toggle("is-active", two && s.mode === "once");
    btn.forever.classList.toggle("is-active", two && s.mode === "forever");
    btn.cut.classList.toggle("is-busy", !!s.cutting);
    const disable = (b, off) => {
      b.classList.toggle("is-disabled", off);
      b.setAttribute("aria-disabled", String(off));
    };
    [btn.once, btn.forever, btn.cut].forEach((b) => disable(b, !two));
    disable(btn.clear, s.marks.length === 0);
    btn.once.setAttribute("aria-pressed", String(two && s.mode === "once"));
    btn.forever.setAttribute("aria-pressed", String(two && s.mode === "forever"));
  }

  // Stash's own looping (short videos, Shift+L) goes through player.loop().
  // While a marked loop runs the native loop stays off; otherwise Stash gets
  // what it asked for.
  function syncNativeLoop(player) {
    const s = player.playbackLoops_;
    s.nativeLoop(s.stashLoop && !looping(s));
  }

  function update(player) {
    syncNativeLoop(player);
    render(player);
  }

  function label(player, t) {
    return formatTime(t) + " · F " + frameOf(t) + (isKeyframe(player, t) ? " · keyframe" : "");
  }

  function showTip(player, clientX, t) {
    const s = player.playbackLoops_;
    const r = s.track.getBoundingClientRect();
    s.tip.style.left = Math.min(Math.max(clientX - r.left, 0), r.width) + "px";
    s.tip.textContent = label(player, t);
    s.tip.classList.add("is-shown");
  }

  // --- pointer handling -----------------------------------------------------

  function timeAt(player, clientX) {
    const r = player.playbackLoops_.line.getBoundingClientRect();
    const p = r.width ? Math.min(Math.max((clientX - r.left) / r.width, 0), 1) : 0;
    return snap(player, p * duration(player));
  }

  // Shift snaps the start mark (or a lone mark, which may become the start) to
  // the nearest keyframe; mark is null for a mark about to be placed.
  function snapToKeyframe(player, mark, t) {
    const s = player.playbackLoops_;
    let hi = duration(player);
    const other = s.marks.find((m) => m !== mark);
    if (s.marks.length === 2 || (!mark && other)) {
      if (s.marks.length === 2 ? mark !== s.marks[0] : t >= other.t) return t;
      hi = s.marks[s.marks.length - 1].t - 1 / fps();
    }
    const k = nearestKeyframe(player, t, 0, hi);
    return k === null ? t : k;
  }

  // While paused, dragging a mark shows the frame it lands on: the first frame
  // of the loop for the start mark, the last one for the end mark.
  function previewMark(player, mark) {
    const s = player.playbackLoops_;
    const f = fps();
    const end = s.marks.length === 2 && s.marks[1] === mark;
    const t = end ? mark.t - 0.5 / f : mark.t + 0.5 / f;
    player.currentTime(Math.min(Math.max(t, 0), duration(player)));
  }

  function moveMark(player, mark, t) {
    if (t === mark.t) return;
    mark.t = t;
    if (player.paused() && !mark.removing) previewMark(player, mark);
  }

  function bindPointer(player) {
    const s = player.playbackLoops_;
    const track = s.track;

    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !duration(player)) return;
      e.preventDefault();
      e.stopPropagation();

      const markEl = e.target.closest(".pbl-mark");
      let mark = markEl ? s.marks.find((m) => m.el === markEl) : null;
      if (!mark) {
        if (s.marks.length >= 2) {
          select(player, null);
          return;
        }
        const t = timeAt(player, e.clientX);
        mark = addMark(player, e.shiftKey ? snapToKeyframe(player, null, t) : t, e.shiftKey);
        if (!mark) return;
      } else if (e.shiftKey) {
        moveMark(player, mark, snapToKeyframe(player, mark, mark.t));
        update(player);
      }
      select(player, mark);
      s.drag = { mark, pointerId: e.pointerId };
      track.setPointerCapture(e.pointerId);
      showTip(player, e.clientX, mark.t);
    });

    track.addEventListener("pointermove", (e) => {
      const drag = s.drag;
      if (!drag || drag.pointerId !== e.pointerId) {
        if (!duration(player)) return;
        const t = timeAt(player, e.clientX);
        showTip(player, e.clientX, e.shiftKey ? snapToKeyframe(player, null, t) : t);
        return;
      }
      const mark = drag.mark;
      const r = s.line.getBoundingClientRect();
      mark.removing = Math.abs(e.clientY - (r.top + r.height / 2)) > REMOVE_DISTANCE;
      let t = clampMark(player, mark, timeAt(player, e.clientX));
      if (e.shiftKey) t = snapToKeyframe(player, mark, t);
      moveMark(player, mark, t);
      render(player);
      showTip(player, e.clientX, mark.t);
    });

    const endDrag = (e) => {
      const drag = s.drag;
      if (!drag || drag.pointerId !== e.pointerId) return;
      s.drag = null;
      s.last = null;
      if (drag.mark.removing) removeMark(player, drag.mark);
      else update(player);
      if (!track.matches(":hover")) s.tip.classList.remove("is-shown");
      // keep keyboard control (space etc.) with the player
      player.el().focus();
    };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);

    track.addEventListener("pointerleave", () => {
      if (!s.drag) s.tip.classList.remove("is-shown");
    });

    track.addEventListener("contextmenu", (e) => {
      const markEl = e.target.closest(".pbl-mark");
      const mark = markEl && s.marks.find((m) => m.el === markEl);
      if (!mark) return;
      e.preventDefault();
      e.stopPropagation();
      removeMark(player, mark);
    });
  }

  // The start and end of the marker a range bar is drawn for. Stash's markers
  // plugin keeps its markers and their bars in matching lists; failing that,
  // they're read off where the bar is drawn.
  function rangeTimes(player, el) {
    try {
      const plugin = player.usingPlugin("markers") && player.markers();
      const i = plugin.markerDivs.findIndex((set) => set.range === el);
      const m = plugin.markers[i];
      if (m && m.end_seconds != null) return [m.seconds, m.end_seconds];
    } catch (e) {
      // a markers plugin that doesn't look like Stash's
    }
    const holder = player.el().querySelector(".vjs-progress-holder");
    const hr = holder && holder.getBoundingClientRect();
    const rr = el.getBoundingClientRect();
    const d = duration(player);
    if (!hr || !hr.width || !d) return null;
    const at = (x) => Math.min(Math.max((x - hr.left) / hr.width, 0), 1) * d;
    return [at(rr.left), at(rr.right)];
  }

  // Clicking a marker range loops it, from its start, straight away. The
  // progress control would otherwise seek to the point clicked.
  function bindRanges(player, progress) {
    const rangeAt = (e) => e.target instanceof Element && e.target.closest(".vjs-marker-range");
    ["mousedown", "touchstart"].forEach((type) =>
      progress.addEventListener(
        type,
        (e) => {
          if (rangeAt(e)) e.stopPropagation();
        },
        true
      )
    );
    progress.addEventListener(
      "pointerdown",
      (e) => {
        const el = rangeAt(e);
        if (!el) return;
        e.stopPropagation();
        if (e.button !== 0) return;
        e.preventDefault();
        const r = rangeTimes(player, el);
        if (r) loopRange(player, r[0], r[1]);
        // keep keyboard control (space etc.) with the player
        player.el().focus();
      },
      true
    );
  }

  // --- setup ----------------------------------------------------------------

  const ICONS = {
    once:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>',
    forever:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
    clear:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><path d="M3.5 2.1 21.9 20.5l-1.4 1.4L2.1 3.5z"/></svg>',
    cut:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/></svg>',
  };

  function makeButton(player, name, label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vjs-control vjs-button pbl-button pbl-" + name;
    btn.title = label;
    btn.innerHTML = ICONS[name] + '<span class="vjs-control-text">' + label + "</span>";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!btn.classList.contains("is-disabled")) onClick(player);
      player.el().focus();
    });
    return btn;
  }

  // Stash's A/B loop (videojs-abloop: the l key and its optional buttons) is
  // switched off for good; this plugin takes over looping.
  function disableAbLoop(player) {
    const ab = player.abLoopPlugin;
    if (!ab || typeof ab.setOptions !== "function" || ab.playbackLoopsBlocked_) return;
    ab.playbackLoopsBlocked_ = true;
    try {
      ab.disable();
    } catch (e) {
      // older versions of the plugin
    }
    const setOptions = ab.setOptions;
    ab.setOptions = function (opts, replaceAll) {
      return setOptions.call(this, Object.assign({}, opts, { enabled: false }), replaceAll);
    };
    ab.enable = ab.toggle = ab.resetToInitialOptions = function () {
      return this;
    };
  }

  function trackFrames(player) {
    const s = player.playbackLoops_;
    const video = player.el().querySelector("video");
    if (!video || video === s.video) return;
    s.video = video;
    if (typeof video.requestVideoFrameCallback !== "function") return;

    const onFrame = (now, meta) => {
      if (s.video !== video) return;
      // mediaTime is the shown frame's own time; Stash's offset streams put
      // the player's timeline ahead of the element's
      const t = meta && meta.mediaTime;
      check(player, t != null ? t + player.currentTime() - video.currentTime : null);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  function attach(player) {
    if (player.playbackLoops_) return;

    const track = document.createElement("div");
    track.className = "pbl-track";
    track.innerHTML =
      '<div class="pbl-line"><div class="pbl-region"></div><canvas class="pbl-ticks"></canvas>' +
      '<canvas class="pbl-keys"></canvas></div>' +
      '<div class="pbl-tip"></div>';
    const toastEl = document.createElement("div");
    toastEl.className = "pbl-toast";
    toastEl.setAttribute("role", "status");

    const nativeLoop = player.loop.bind(player);
    const s = {
      sceneId,
      marks: [], // { t, el, removing }, sorted, at most two
      selected: null,
      mode: "off", // "off" | "once" | "forever"
      last: null, // time at the previous check; null after a seek
      drag: null,
      cutting: false,
      swallowEnded: false,
      thickness: 0, // the seek bar's at rest; 0 to measure it afresh
      lineTop: null, // px from the control bar's top, set at rest
      rangeTop: null, // px from the progress control's top, set at rest
      rangeBottom: null,
      progress: null, // .vjs-progress-control, which holds the marker ranges
      video: null,
      stashLoop: !!nativeLoop(),
      nativeLoop,
      track,
      line: track.querySelector(".pbl-line"),
      region: track.querySelector(".pbl-region"),
      ticks: track.querySelector(".pbl-ticks"),
      keys: track.querySelector(".pbl-keys"),
      keyframes: null, // sorted keyframe times, when the stream has an index
      keyframesSrc: null,
      keyframesAbort: null,
      tip: track.querySelector(".pbl-tip"),
      toast: toastEl,
      toastTimer: null,
      buttons: {},
    };
    player.playbackLoops_ = s;

    player.loop = function (value) {
      if (value === undefined) return nativeLoop();
      s.stashLoop = !!value;
      syncNativeLoop(player);
    };
    disableAbLoop(player);

    const bar = player.controlBar && player.controlBar.el();
    s.progress = bar && bar.querySelector(".vjs-progress-control");
    if (bar) {
      bar.append(track);

      const group = document.createElement("div");
      group.className = "pbl-buttons";
      s.buttons.once = makeButton(player, "once", "Loop once (play the loop, then pause)", loopOnce);
      s.buttons.forever = makeButton(player, "forever", "Loop forever", loopForever);
      s.buttons.cut = makeButton(player, "cut", "Cut loop (save it as a {CUT} marker)", cut);
      s.buttons.clear = makeButton(player, "clear", "Clear loop (remove the marks, keep playing)", clearMarks);
      group.append(s.buttons.once, s.buttons.forever, s.buttons.cut, s.buttons.clear);
      const anchor = bar.querySelector(".vjs-playback-rate, .vjs-fullscreen-control");
      if (anchor) anchor.before(group);
      else bar.append(group);
    }
    player.el().append(toastEl);

    bindPointer(player);
    if (s.progress) bindRanges(player, s.progress);

    const relayout = () => layout(player);
    let playerSize = "";
    const ro = new ResizeObserver(() => {
      // the seek bar's rest thickness can change with the player's size
      // (fullscreen, for one): measure it again
      const pr = player.el().getBoundingClientRect();
      const size = pr.width + "x" + pr.height;
      if (size !== playerSize) {
        playerSize = size;
        s.thickness = 0;
        s.lineTop = null;
      }
      relayout();
    });
    ro.observe(player.el());
    const holder = bar && bar.querySelector(".vjs-progress-holder");
    if (holder) ro.observe(holder);
    // marker ranges come and go as the scene's markers load or change
    const mo = new MutationObserver(relayout);
    if (s.progress) mo.observe(s.progress, { childList: true });

    trackFrames(player);
    player.on("loadstart", () => {
      if (s.sceneId !== sceneId) {
        clearMarks(player);
        s.mode = "off";
      }
      s.sceneId = sceneId;
      s.last = null;
      trackFrames(player);
    });
    player.on(["loadedmetadata", "durationchange"], () => {
      loadKeyframes(player);
      layout(player);
      render(player);
    });
    player.on("seeking", () => {
      s.last = null;
    });
    player.on("seeked", () => checkLoopSeek(player));
    player.on("timeupdate", () => check(player));
    player.on("play", () => {
      // playing from the loop's last frame (where loop once stops) starts the
      // loop again rather than running on past the end mark
      if (!looping(s)) return;
      if (Math.abs(player.currentTime() - lastFrameTime(s)) < 1 / fps()) seekStart(player);
    });
    player.on(["fullscreenchange", "playerresize"], relayout);
    // the user may well be seeking to the start themselves
    const disarm = () => (s.loopSeek = null);
    player.el().addEventListener("pointerdown", disarm, true);
    player.el().addEventListener("keydown", disarm, true);
    player.on("dispose", () => {
      ro.disconnect();
      mo.disconnect();
      if (s.keyframesAbort) s.keyframesAbort.abort();
      s.video = null;
    });

    if (player.readyState() > 0) loadKeyframes(player);
    layout(player);
    update(player);
  }

  // --- global listeners -----------------------------------------------------

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
  }

  // Capture phase on window, so this runs before video.js's hotkeys and
  // Mousetrap: l and Shift+L are Stash's A/B loop and loop toggle.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isEditable(e.target) || document.querySelector(".modal.show")) return;
      const player = getPlayer();
      const s = player && player.playbackLoops_;
      if (!s) return;

      if (e.code === "KeyL") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        if (e.shiftKey) toggleLooping(player);
        else markHere(player);
        return;
      }

      if (e.shiftKey || !s.selected) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        removeMark(player, s.selected);
      } else if (e.key === "Escape") {
        select(player, null);
      }
    },
    true
  );

  // A loop whose end mark is at the very end of the video can reach `ended`
  // before the frame check catches it. Swallow that event (so Stash doesn't
  // move on to the next scene in the queue) and loop instead. Media events
  // don't bubble, but they do go through the capture phase.
  window.addEventListener(
    "ended",
    (e) => {
      const player = getPlayer();
      const s = player && player.playbackLoops_;
      if (!s || !(e.target instanceof Node) || !player.el().contains(e.target)) return;
      if (s.swallowEnded) {
        s.swallowEnded = false;
        e.stopImmediatePropagation();
        return;
      }
      if (!looping(s) || s.last == null) return;
      const [a, b] = times(s);
      if (s.last < a - 1 / fps() || s.last >= b) return;
      e.stopImmediatePropagation();
      endOfLoop(player);
    },
    true
  );

  // clicking anywhere else drops the mark selection
  document.addEventListener(
    "pointerdown",
    (e) => {
      const player = getPlayer();
      const s = player && player.playbackLoops_;
      if (!s || !s.selected) return;
      if (e.target instanceof Element && e.target.closest(".pbl-mark")) return;
      select(player, null);
    },
    true
  );

  // The player is created and destroyed as the user navigates, so watch the DOM
  // for a new instance.
  let checkQueued = false;
  function checkForPlayer() {
    checkQueued = false;
    const player = getPlayer();
    if (player && !player.playbackLoops_) attach(player);
  }

  new MutationObserver(() => {
    if (checkQueued) return;
    checkQueued = true;
    // not requestAnimationFrame: that never fires in a background tab
    setTimeout(checkForPlayer, 50);
  }).observe(document.body, { childList: true, subtree: true });

  checkForPlayer();
})();
