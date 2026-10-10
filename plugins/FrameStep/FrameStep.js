(function () {
  "use strict";

  const PLAYER_ID = "VideoJsPlayer"; // ui/v2.5/src/components/ScenePlayer/util.ts
  const DEFAULT_FPS = 30;

  const api = window.PluginApi;

  // frame rate of the current scene's primary file, captured from ScenePlayer props
  let sceneFps = null;
  let settings = {};

  api.patch.before("ScenePlayer", function (...args) {
    const files = args[0] && args[0].scene && args[0].scene.files;
    const rate = files && files.length ? files[0].frame_rate : 0;
    sceneFps = rate > 0 ? rate : null;
    return args;
  });

  async function loadSettings() {
    try {
      const res = await api.utils.StashService.getClient().query({
        query: api.libraries.Apollo.gql`
          query FrameStepConfig {
            configuration {
              plugins(include: ["FrameStep"])
            }
          }
        `,
        fetchPolicy: "network-only",
      });
      settings = (res.data.configuration.plugins || {}).FrameStep || {};
    } catch (e) {
      console.warn("[FrameStep] could not load settings", e);
    }
  }

  function getPlayer() {
    const el = document.getElementById(PLAYER_ID);
    const player = el && el.player;
    return player && !player.isDisposed() ? player : null;
  }

  function fps() {
    const override = Number(settings.fpsOverride);
    if (override > 0) return override;
    return sceneFps || DEFAULT_FPS;
  }

  // Presentation time of the frame currently on screen. requestVideoFrameCallback
  // gives the exact timestamp; without it, fall back to snapping currentTime to
  // the frame grid.
  function shownFrameTime(player, state, f) {
    const t = player.currentTime();
    const mt = state.mediaTime;
    if (mt != null && Math.abs(t - mt) < 1 / f) return mt;
    return Math.floor(t * f + 1e-3) / f;
  }

  // Keep a time within the middle of the first and last frames. currentTime can
  // sit at exactly duration, which would otherwise count as a frame past the end.
  function clampToFrames(player, t, f) {
    t = Math.max(t, 0.5 / f);
    const duration = player.duration();
    if (duration > 0) {
      t = Math.min(t, (Math.floor(duration * f - 0.5) + 0.5) / f);
    }
    return t;
  }

  function frameNumber(player, state) {
    const f = fps();
    const t = clampToFrames(player, shownFrameTime(player, state, f), f);
    return Math.floor(t * f + 1e-3);
  }

  function step(player, frames) {
    const state = player.frameStep_;
    if (!state || player.readyState() < 1) return;

    if (!player.paused()) player.pause();

    const f = fps();
    const now = player.currentTime();

    // Seek to the middle of the target frame so rounding can't land us on a
    // neighbour. While a previous step is still seeking (key held down), chain
    // off its target rather than the stale frame on screen.
    let base;
    if (state.target != null && Math.abs(now - state.target) < 1e-3) {
      base = state.target;
    } else {
      base = shownFrameTime(player, state, f) + 0.5 / f;
    }

    base = clampToFrames(player, base, f);
    const target = clampToFrames(player, base + frames / f, f);

    state.target = target;
    player.currentTime(target);
    updateCounter(player);
  }

  function trackFrames(player) {
    const state = player.frameStep_;
    const video = player.el().querySelector("video");
    if (!video || video === state.video) return;

    state.video = video;
    state.mediaTime = null;
    if (typeof video.requestVideoFrameCallback !== "function") return;

    const onFrame = (_now, meta) => {
      if (state.video !== video) return;
      state.mediaTime = meta.mediaTime;
      updateCounter(player);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  function updateCounter(player) {
    const state = player.frameStep_;
    if (!state || !state.counter) return;
    const n = player.readyState() >= 1 ? frameNumber(player, state) : 0;
    state.counter.textContent = "F " + n;
    state.counter.title = "Frame " + n + " @ " + +fps().toFixed(3) + " fps";
  }

  const ICONS = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h2.5v14H5zM19 5v14L9 12z"/></svg>',
    forward:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 5H19v14h-2.5zM5 5v14l10-7z"/></svg>',
  };

  function keyHint(key) {
    return settings.useBareKeys ? key : "Shift+" + key;
  }

  function makeButton(player, dir) {
    const label = dir < 0 ? "Previous frame" : "Next frame";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "vjs-control vjs-button vjs-frame-step " +
      (dir < 0 ? "vjs-frame-step-back" : "vjs-frame-step-forward");
    btn.title = label + " (" + keyHint(dir < 0 ? "," : ".") + ")";
    btn.innerHTML =
      ICONS[dir < 0 ? "back" : "forward"] +
      '<span class="vjs-control-text">' +
      label +
      "</span>";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      step(player, dir);
      // don't leave focus on the button, or space would step instead of play/pause
      player.el().focus();
    });
    return btn;
  }

  function attach(player) {
    if (player.frameStep_) return;
    const state = {
      video: null,
      mediaTime: null,
      target: null,
      counter: null,
    };
    player.frameStep_ = state;

    player.toggleClass("vjs-frame-step-no-buttons", !!settings.hideButtons);
    player.toggleClass("vjs-frame-step-no-counter", !!settings.hideCounter);

    const bar = player.controlBar && player.controlBar.el();
    if (bar) {
      const back = makeButton(player, -1);
      const forward = makeButton(player, 1);
      const play = bar.querySelector(".vjs-play-control");
      if (play) {
        play.after(back, forward);
      } else {
        bar.prepend(back, forward);
      }

      state.counter = document.createElement("div");
      state.counter.className = "vjs-control vjs-frame-step-counter";
      const duration = bar.querySelector(".vjs-duration");
      if (duration) {
        duration.after(state.counter);
      } else {
        bar.append(state.counter);
      }
    }

    trackFrames(player);
    player.on("loadstart", () => {
      state.target = null;
      trackFrames(player);
    });
    player.on(["seeked", "timeupdate", "loadedmetadata"], () =>
      updateCounter(player)
    );
    player.on("dispose", () => {
      state.video = null;
    });
    updateCounter(player);
  }

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      el.isContentEditable
    );
  }

  // Capture phase on window so this runs before Mousetrap and video.js; when
  // useBareKeys is on, cancelling keydown also suppresses the keypress event
  // Mousetrap uses for Stash's own , and . shortcuts.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.shiftKey === !!settings.useBareKeys) return;

      let dir;
      if (e.code === "Comma") dir = -1;
      else if (e.code === "Period") dir = 1;
      else return;

      if (isEditable(e.target) || document.querySelector(".modal.show")) return;
      const player = getPlayer();
      if (!player || !player.frameStep_) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      step(player, dir);
    },
    true
  );

  // The player is created and destroyed as the user navigates, so watch the DOM
  // for a new instance.
  let checkQueued = false;
  function checkForPlayer() {
    checkQueued = false;
    const player = getPlayer();
    if (!player || player.frameStep_ || player.frameStepPending_) return;
    player.frameStepPending_ = true;
    loadSettings().then(() => {
      if (!player.isDisposed()) attach(player);
    });
  }

  new MutationObserver(() => {
    if (checkQueued) return;
    checkQueued = true;
    // not requestAnimationFrame: that never fires in a background tab
    setTimeout(checkForPlayer, 50);
  }).observe(document.body, { childList: true, subtree: true });

  checkForPlayer();
})();
