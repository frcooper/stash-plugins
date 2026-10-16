(function () {
  "use strict";

  const PLAYER_ID = "VideoJsPlayer"; // ui/v2.5/src/components/ScenePlayer/util.ts
  const DEFAULT_FPS = 30;
  const CUT_TAG = "{CUT}";
  const MAX_GAP = 32; // px between the loop line and the seek bar, at most
  const MARK_HEAD = 12; // px a mark sticks up above the loop line
  const REMOVE_DISTANCE = 40; // px a mark has to be dragged off the line to delete it

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

  function addMark(player, t) {
    const s = player.playbackLoops_;
    t = snap(player, t);
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

  function seekStart(player) {
    const s = player.playbackLoops_;
    s.last = null;
    player.currentTime(startTime(s));
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
      player.currentTime(lastFrameTime(s));
    } else {
      player.currentTime(startTime(s));
      if (player.paused()) play(player);
    }
  }

  // Called every frame (and on timeupdate). The loop only fires when playback
  // runs from inside the loop across its end, so seeking outside the loop and
  // playing on works like it does without one.
  function check(player) {
    const s = player.playbackLoops_;
    if (player.seeking()) {
      s.last = null;
      return;
    }
    const t = player.currentTime();
    const last = s.last;
    s.last = t;
    if (s.drag || !looping(s) || last == null) return;

    const f = fps();
    const [a, b] = times(s);
    const edge = b - 0.5 / f;
    if (last >= a - 1 / f && last < edge && t >= edge && t - last < 2) {
      endOfLoop(player);
    }
  }

  // Loop once / loop forever: pressing the active one switches looping off.
  // Switching a mode on keeps the playhead where it is if it's inside the loop
  // (so flipping between the two doesn't restart the loop), otherwise it goes
  // to the start of the loop; either way playback starts.
  function setMode(player, mode) {
    const s = player.playbackLoops_;
    if (s.marks.length < 2) return;
    if (s.mode === mode) {
      s.mode = "off";
    } else {
      s.mode = mode;
      const t = player.currentTime();
      if (t < s.marks[0].t || t >= lastFrameTime(s) + 0.25 / fps()) seekStart(player);
      if (player.paused()) play(player);
    }
    update(player);
  }

  function toggleForever(player) {
    setMode(player, "forever");
  }

  function loopOnce(player) {
    setMode(player, "once");
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

  async function sceneTagIds(id) {
    const res = await getClient().query({
      query: gql`
        query PlaybackLoopsSceneTags($id: ID!) {
          findScene(id: $id) {
            tags {
              id
            }
          }
        }
      `,
      variables: { id },
      fetchPolicy: "network-only",
    });
    const scene = res.data.findScene;
    return scene ? scene.tags.map((t) => t.id) : [];
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
      const [tagId, tagIds] = await Promise.all([
        findOrCreateCutTag(),
        sceneTagIds(s.sceneId),
      ]);
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

    // video.js thickens the seek bar on hover; measure it at rest
    const control = holder.closest(".vjs-progress-control");
    if (!s.thickness || !(control && control.matches(":hover"))) {
      s.thickness = hr.height;
    }
    const thick = s.thickness;
    const gap = Math.min(1.5 * thick, MAX_GAP);
    const br = bar.getBoundingClientRect();
    const lineTop = hr.top + hr.height / 2 - thick / 2 - gap - thick - br.top;
    const padBottom = gap / 2;

    const style = s.track.style;
    style.left = hr.left - br.left + "px";
    style.width = hr.width + "px";
    style.top = lineTop - MARK_HEAD + "px";
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
    drawTicks(player);
  }

  // second and minute steps for the graduations
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

  function drawTicks(player) {
    const s = player.playbackLoops_;
    const canvas = s.ticks;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);

    const d = duration(player);
    if (!d || !w) return;
    const pxPerSec = canvas.clientWidth / d;
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
        formatTime(m.t) + " · F " + frameOf(m.t) + " — drag to move, drag off or right-click to remove";
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
    [btn.once, btn.forever, btn.cut].forEach((b) => {
      b.classList.toggle("is-disabled", !two);
      b.setAttribute("aria-disabled", String(!two));
    });
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

  function showTip(player, clientX, t) {
    const s = player.playbackLoops_;
    const r = s.track.getBoundingClientRect();
    s.tip.style.left = Math.min(Math.max(clientX - r.left, 0), r.width) + "px";
    s.tip.textContent = formatTime(t) + " · F " + frameOf(t);
    s.tip.classList.add("is-shown");
  }

  // --- pointer handling -----------------------------------------------------

  function timeAt(player, clientX) {
    const r = player.playbackLoops_.line.getBoundingClientRect();
    const p = r.width ? Math.min(Math.max((clientX - r.left) / r.width, 0), 1) : 0;
    return snap(player, p * duration(player));
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
        mark = addMark(player, timeAt(player, e.clientX));
        if (!mark) return;
      }
      select(player, mark);
      s.drag = { mark, pointerId: e.pointerId };
      track.setPointerCapture(e.pointerId);
      showTip(player, e.clientX, mark.t);
    });

    track.addEventListener("pointermove", (e) => {
      const drag = s.drag;
      if (!drag || drag.pointerId !== e.pointerId) {
        if (duration(player)) showTip(player, e.clientX, timeAt(player, e.clientX));
        return;
      }
      const mark = drag.mark;
      const r = s.line.getBoundingClientRect();
      mark.removing = Math.abs(e.clientY - (r.top + r.height / 2)) > REMOVE_DISTANCE;
      const t = clampMark(player, mark, timeAt(player, e.clientX));
      if (t !== mark.t) {
        mark.t = t;
        if (player.paused() && !mark.removing) previewMark(player, mark);
      }
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

  // --- setup ----------------------------------------------------------------

  const ICONS = {
    once:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>',
    forever:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
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

    const onFrame = () => {
      if (s.video !== video) return;
      check(player);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  function attach(player) {
    if (player.playbackLoops_) return;

    const track = document.createElement("div");
    track.className = "pbl-track";
    track.innerHTML =
      '<div class="pbl-line"><div class="pbl-region"></div><canvas class="pbl-ticks"></canvas></div>' +
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
      thickness: 0,
      video: null,
      stashLoop: !!nativeLoop(),
      nativeLoop,
      track,
      line: track.querySelector(".pbl-line"),
      region: track.querySelector(".pbl-region"),
      ticks: track.querySelector(".pbl-ticks"),
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
    if (bar) {
      bar.append(track);

      const group = document.createElement("div");
      group.className = "pbl-buttons";
      s.buttons.once = makeButton(player, "once", "Loop once (play the loop, then pause)", loopOnce);
      s.buttons.forever = makeButton(player, "forever", "Loop forever (Shift+L)", toggleForever);
      s.buttons.cut = makeButton(player, "cut", "Cut loop (save it as a {CUT} marker)", cut);
      group.append(s.buttons.once, s.buttons.forever, s.buttons.cut);
      const anchor = bar.querySelector(".vjs-playback-rate, .vjs-fullscreen-control");
      if (anchor) anchor.before(group);
      else bar.append(group);
    }
    player.el().append(toastEl);

    bindPointer(player);

    const relayout = () => layout(player);
    const ro = new ResizeObserver(relayout);
    ro.observe(player.el());
    const holder = bar && bar.querySelector(".vjs-progress-holder");
    if (holder) ro.observe(holder);

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
      layout(player);
      render(player);
    });
    player.on("seeking", () => {
      s.last = null;
    });
    player.on("timeupdate", () => check(player));
    player.on("play", () => {
      // playing from the loop's last frame (where loop once stops) starts the
      // loop again rather than running on past the end mark
      if (!looping(s)) return;
      if (Math.abs(player.currentTime() - lastFrameTime(s)) < 1 / fps()) seekStart(player);
    });
    player.on(["fullscreenchange", "playerresize"], relayout);
    player.on("dispose", () => {
      ro.disconnect();
      s.video = null;
    });

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
        if (e.shiftKey) toggleForever(player);
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
