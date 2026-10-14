(function () {
  "use strict";

  const PLUGIN_ID = "Reencode";
  const DEFAULT_TAG = "{ORIGINAL}";
  const POLL_MS = 3000;
  // job descriptions set by the plugin: "Re-encode scene 12" / "Re-encode scene 12: finalize"
  const JOB_RE = /Re-encode scene (\d+)(: finalize)?$/;

  const api = window.PluginApi;
  const { gql, ApolloLink } = api.libraries.Apollo;
  const getClient = () => api.utils.StashService.getClient();

  let settings = {};
  let originalTagId = null;

  // scene id -> { busy, percent, title }. The button shows "Reencode" when
  // idle and the percentage while busy; how a run ended goes in the tooltip.
  const runs = new Map();
  let pollTimer = null;

  async function loadSettings() {
    try {
      const res = await getClient().query({
        query: gql`
          query ReencodeConfig {
            configuration {
              plugins(include: ["Reencode"])
            }
          }
        `,
        fetchPolicy: "network-only",
      });
      settings = (res.data.configuration.plugins || {})[PLUGIN_ID] || {};
    } catch (e) {
      console.warn("[Reencode] could not load settings", e);
    }
  }

  function tagName() {
    return (settings.tagName || "").trim() || DEFAULT_TAG;
  }

  async function loadTagId() {
    const name = tagName();
    try {
      const res = await getClient().query({
        query: gql`
          query ReencodeTag($name: String!) {
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
        variables: { name },
        fetchPolicy: "network-only",
      });
      const tag = res.data.findTags.tags.find(
        (t) => t.name.toLowerCase() === name.toLowerCase()
      );
      originalTagId = tag ? tag.id : null;
    } catch (e) {
      console.warn("[Reencode] could not look up the original tag", e);
    }
  }

  // --- hiding originals ------------------------------------------------------
  //
  // Every scene list (scenes page, performer/studio/tag/group tabs, the play
  // queue, scene pickers) goes through a query with a $scene_filter variable.
  // An Apollo link adds "tags excludes {ORIGINAL}" to it unless the filter
  // already mentions the tag, so the originals only show up when searched for.

  function declaresVar(query, name) {
    return query.definitions.some(
      (d) =>
        d.kind === "OperationDefinition" &&
        (d.variableDefinitions || []).some((v) => v.variable.name.value === name)
    );
  }

  function mentionsTag(filter, id) {
    if (!filter || typeof filter !== "object") return false;
    if (Array.isArray(filter)) return filter.some((f) => mentionsTag(f, id));
    return Object.entries(filter).some(([key, value]) => {
      if (key === "tags" && value && typeof value === "object") {
        const ids = [].concat(value.value || [], value.excludes || []);
        if (ids.some((v) => String(v) === String(id))) return true;
      }
      return mentionsTag(value, id);
    });
  }

  function excludeOriginals(filter, id) {
    const tags = { value: [id], modifier: "EXCLUDES", depth: 0 };
    if (!filter || Object.keys(filter).length === 0) return { tags };
    const nested = filter.AND || filter.OR || filter.NOT;
    if (!filter.tags && !nested) return { ...filter, tags };
    // keep the original filter's own AND/OR/NOT semantics intact
    return { AND: filter, tags };
  }

  const hideLink = new ApolloLink((operation, forward) => {
    const v = operation.variables || {};
    if (
      originalTagId &&
      !settings.showOriginals &&
      declaresVar(operation.query, "scene_filter") &&
      !(v.scene_ids && v.scene_ids.length) &&
      !mentionsTag(v.scene_filter, originalTagId)
    ) {
      operation.variables = {
        ...v,
        scene_filter: excludeOriginals(v.scene_filter, originalTagId),
      };
    }
    return forward(operation);
  });

  function installHideLink() {
    const client = getClient();
    if (client.reencodeHideLink_) return;
    client.reencodeHideLink_ = true;
    client.setLink(hideLink.concat(client.link));
  }

  // --- running -----------------------------------------------------------------

  async function fetchScene(id) {
    const res = await getClient().query({
      query: gql`
        query ReencodeScene($id: ID!) {
          findScene(id: $id) {
            id
            tags {
              id
              name
            }
            files {
              id
              basename
              size
              video_codec
              width
              height
            }
          }
        }
      `,
      variables: { id },
      fetchPolicy: "network-only",
    });
    return res.data.findScene;
  }

  async function fetchJobs() {
    const res = await getClient().query({
      query: gql`
        query ReencodeJobs {
          jobQueue {
            id
            status
            description
            progress
          }
        }
      `,
      fetchPolicy: "network-only",
    });
    return res.data.jobQueue || [];
  }

  async function fetchStatus(sceneId) {
    const res = await getClient().mutate({
      mutation: gql`
        mutation ReencodeStatus($id: ID!, $args: Map) {
          runPluginOperation(plugin_id: $id, args: $args)
        }
      `,
      variables: { id: PLUGIN_ID, args: { mode: "status", scene_id: sceneId } },
    });
    return res.data.runPluginOperation || {};
  }

  function humanSize(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1000 && i < units.length - 1) {
      n /= 1000;
      i++;
    }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  }

  async function start(sceneId) {
    await loadSettings();
    const scene = await fetchScene(sceneId);
    if (!scene || !scene.files.length) {
      window.alert("This scene has no file to re-encode.");
      return;
    }
    const tag = tagName().toLowerCase();
    if (scene.tags.some((t) => t.name.toLowerCase() === tag)) {
      window.alert(
        "This scene holds an original file (tagged " +
          tagName() +
          "). Re-encode the scene it was replaced on instead."
      );
      return;
    }

    const f = scene.files[0];
    const target =
      (settings.outputArgs || "").trim()
        ? "custom ffmpeg options"
        : (settings.videoCodec || "").trim() || "AV1 (libsvtav1)";
    const container = ((settings.container || "").trim() || "mp4").replace(/^\./, "");
    const keep = settings.keepOriginalAttached
      ? "The original stays attached to this scene as a secondary file."
      : "The original moves to its own scene tagged " +
        tagName() +
        (settings.showOriginals ? "." : ", hidden from scene lists.");

    const ok = window.confirm(
      "Re-encode " +
        f.basename +
        "?\n\n" +
        [f.video_codec, f.width && f.height ? f.width + "x" + f.height : "", humanSize(f.size || 0)]
          .filter(Boolean)
          .join(", ") +
        "  →  " +
        target +
        ", ." +
        container +
        "\n\nThe new file becomes this scene's file. " +
        keep
    );
    if (!ok) return;

    await getClient().mutate({
      mutation: gql`
        mutation ReencodeRun($id: ID!, $description: String, $args: Map) {
          runPluginTask(plugin_id: $id, description: $description, args_map: $args)
        }
      `,
      variables: {
        id: PLUGIN_ID,
        description: "Re-encode scene " + sceneId,
        args: { mode: "encode", scene_id: sceneId },
      },
    });

    track(sceneId);
  }

  function track(sceneId) {
    runs.set(sceneId, { busy: true, percent: 0, title: "" });
    renderButtons();
    if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
  }

  async function poll() {
    let jobs;
    try {
      jobs = await fetchJobs();
    } catch (e) {
      return;
    }

    const active = new Map();
    for (const job of jobs) {
      const m = JOB_RE.exec(job.description || "");
      if (m) active.set(m[1], { job, finalize: !!m[2] });
    }

    for (const [sceneId, run] of runs) {
      if (!run.busy) continue;
      const a = active.get(sceneId);
      if (a) {
        // the encode is all but the last moment of a run, so its progress
        // is the run's; once it ends, the scan and swap show as 100%
        if (a.finalize) run.percent = 100;
        else if (a.job.status === "RUNNING" && a.job.progress > 0)
          run.percent = Math.min(99, Math.floor(a.job.progress * 100));
        continue;
      }

      // no job left for this scene: ask the plugin how it ended
      run.busy = false;
      try {
        const s = await fetchStatus(sceneId);
        if (s.state === "done") {
          run.title = "Re-encoded to " + (s.file || "a new file");
          await loadTagId();
          getClient().refetchQueries({ include: "active" });
        } else if (s.state === "error") {
          run.title = "Last re-encode failed: " + (s.message || "see the Stash log");
        } else {
          run.title = "Last re-encode was cancelled or stopped early; see the Stash log";
        }
      } catch (e) {
        run.title = "Last re-encode failed: " + (e.message || e);
      }
    }

    renderButtons();
    if (![...runs.values()].some((r) => r.busy)) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // pick up a run that started before this page load
  async function checkRunning(sceneId) {
    if (runs.has(sceneId)) return;
    try {
      const jobs = await fetchJobs();
      const running = jobs.some((job) => {
        const m = JOB_RE.exec(job.description || "");
        return m && m[1] === sceneId;
      });
      if (running && !runs.has(sceneId)) track(sceneId);
    } catch (e) {
      // ignore
    }
  }

  // --- button ------------------------------------------------------------------

  function currentSceneId() {
    const m = /\/scenes\/(\d+)(?:\/|$)/.exec(window.location.pathname);
    return m ? m[1] : null;
  }

  // Match the neighbouring buttons' text, whatever the theme or custom CSS
  // does to them, and never grow wider than "Scrape with…".
  function matchNeighbours(btn) {
    const container = btn.closest(".edit-buttons-container") || document;
    const like = container.querySelector(".edit-buttons .btn:not(.reencode-button)");
    if (like) {
      const cs = window.getComputedStyle(like);
      for (const prop of ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "textTransform"]) {
        btn.style[prop] = cs[prop];
      }
    }
    const scrape = container.querySelector(".scraper-group .dropdown-toggle");
    if (scrape && scrape.offsetWidth > 0) btn.style.maxWidth = scrape.offsetWidth + "px";
  }

  function renderButton(btn) {
    const run = runs.get(btn.dataset.sceneId);
    const busy = !!(run && run.busy);
    btn.disabled = busy;
    btn.querySelector(".reencode-label").textContent = busy ? run.percent + "%" : "Reencode";
    btn.title = busy
      ? "Re-encoding this scene's file"
      : (run && run.title) || "Re-encode this scene's file";
    matchNeighbours(btn);
  }

  function renderButtons() {
    document.querySelectorAll(".reencode-button").forEach(renderButton);
  }

  function addButton() {
    const sceneId = currentSceneId();
    const bar = document.querySelector("#scene-edit-details .edit-buttons");
    if (!sceneId || !bar) return;

    const existing = bar.querySelector(".reencode-button");
    if (existing && existing.dataset.sceneId === sceneId) {
      // the scrape button may only now be laid out (e.g. the tab just opened)
      matchNeighbours(existing);
      return;
    }
    if (existing) existing.remove();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-warning edit-button reencode-button";
    btn.dataset.sceneId = sceneId;
    // the hidden copy of "Reencode" keeps the width the same while the
    // percentage shows
    btn.innerHTML =
      '<span class="reencode-label"></span><span class="reencode-sizer" aria-hidden="true">Reencode</span>';
    btn.addEventListener("click", () => {
      const run = runs.get(sceneId);
      if (run && run.busy) return;
      runs.delete(sceneId);
      renderButton(btn);
      start(sceneId).catch((e) => {
        console.error("[Reencode]", e);
        window.alert("Could not start the re-encode: " + (e.message || e));
      });
    });
    // after Delete, so it sits between Delete and the scrape buttons
    bar.append(btn);
    renderButton(btn);
    checkRunning(sceneId);
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      addButton();
    }, 50);
  }).observe(document.body, { childList: true, subtree: true });

  (async function init() {
    await loadSettings();
    if (settings.showOriginals) return;
    installHideLink();
    await loadTagId();
    // lists loaded before the plugin did weren't filtered
    if (originalTagId) getClient().refetchQueries({ include: "active" });
  })();

  addButton();
})();
