"""Re-encodes a scene's file and swaps the new file in as the scene's file.

Runs as a Stash raw-interface plugin. Modes (args["mode"]):

  encode    job: encode the scene's primary file next to it, then queue a scan
            of the new file and a finalize job (the job queue is serial, so
            finalize runs after the scan)
  finalize  job: move the new file onto the scene as its primary file, split
            the original off into its own scene tagged {ORIGINAL}
  status    operation: report how the last run for a scene ended

Only the standard library is used, so it runs on any Python 3.8+.
"""

import collections
import datetime
import json
import os
import shlex
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.request

PLUGIN_ID = "Reencode"
DEFAULT_TAG = "{ORIGINAL}"
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")

# Encoders tried in order when no video encoder is configured.
DEFAULT_VIDEO_ENCODERS = ["libsvtav1", "libx265"]

VIDEO_DEFAULT_ARGS = {
    "libsvtav1": "-crf 30 -preset 6 -pix_fmt yuv420p10le",
    "libaom-av1": "-crf 30 -b:v 0 -cpu-used 4 -row-mt 1 -pix_fmt yuv420p10le",
    "librav1e": "-qp 80 -speed 6",
    "av1_nvenc": "-preset p6 -rc vbr -cq 32 -b:v 0",
    "av1_qsv": "-preset slow -global_quality 28",
    "av1_amf": "-quality quality -rc cqp -qp_i 120 -qp_p 120",
    "libx265": "-crf 24 -preset medium -pix_fmt yuv420p10le",
    "hevc_nvenc": "-preset p6 -rc vbr -cq 26 -b:v 0",
    "hevc_qsv": "-preset slow -global_quality 24",
    "hevc_amf": "-quality quality -rc cqp -qp_i 24 -qp_p 24",
    "hevc_videotoolbox": "-q:v 60",
    "libx264": "-crf 20 -preset slow -pix_fmt yuv420p",
    "h264_nvenc": "-preset p6 -rc vbr -cq 22 -b:v 0",
    "libvpx-vp9": "-crf 32 -b:v 0 -row-mt 1",
}

HEVC_ENCODERS = {
    "libx265",
    "hevc_nvenc",
    "hevc_qsv",
    "hevc_amf",
    "hevc_vaapi",
    "hevc_videotoolbox",
}

# ffmpeg muxer names for extensions it wouldn't recognise behind ".part"
MUXERS = {
    "mkv": "matroska",
    "mk3d": "matroska",
    "m4v": "mp4",
    "ts": "mpegts",
    "m2ts": "mpegts",
    "mts": "mpegts",
    "wmv": "asf",
    "mpg": "mpeg",
    "mpeg": "mpeg",
    "3gp": "3gp",
}

MP4_LIKE = {"mp4", "m4v", "mov"}


class PluginError(Exception):
    pass


# --- logging (Stash's plugin log protocol on stderr) ---------------------------


def log(level, msg):
    for line in str(msg).splitlines() or [""]:
        sys.stderr.write("\x01%s\x02%s\n" % (level, line))
    sys.stderr.flush()


def progress(p):
    sys.stderr.write("\x01p\x02%.4f\n" % max(0.0, min(1.0, p)))
    sys.stderr.flush()


# --- GraphQL -------------------------------------------------------------------


class Stash:
    def __init__(self, conn):
        scheme = conn.get("Scheme") or "http"
        host = conn.get("Host") or "localhost"
        if host in ("0.0.0.0", "::", "[::]"):
            host = "localhost"
        if ":" in host and not host.startswith("["):
            host = "[%s]" % host
        self.url = "%s://%s:%s/graphql" % (scheme, host, conn.get("Port") or 9999)
        self.headers = {"Content-Type": "application/json", "Accept": "application/json"}
        cookie = conn.get("SessionCookie") or {}
        if cookie.get("Name"):
            self.headers["Cookie"] = "%s=%s" % (cookie["Name"], cookie.get("Value", ""))
        # the server is local; its certificate may be self-signed
        self.ssl = ssl._create_unverified_context() if scheme == "https" else None
        self.config_dir = conn.get("Dir") or ""

    def call(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(self.url, data=body, headers=self.headers)
        with urllib.request.urlopen(req, context=self.ssl, timeout=120) as res:
            data = json.loads(res.read().decode())
        if data.get("errors"):
            raise PluginError("GraphQL: " + "; ".join(e.get("message", "?") for e in data["errors"]))
        return data["data"]

    def settings(self):
        data = self.call('query { configuration { plugins(include: ["%s"]) } }' % PLUGIN_ID)
        return (data["configuration"]["plugins"] or {}).get(PLUGIN_ID) or {}

    def ffmpeg_config(self):
        try:
            g = self.call("query { configuration { general { ffmpegPath ffprobePath } } }")
            g = g["configuration"]["general"]
            return g.get("ffmpegPath") or "", g.get("ffprobePath") or ""
        except Exception:
            # older Stash without configurable ffmpeg paths
            return "", ""

    def scene(self, scene_id):
        data = self.call(
            """query ($id: ID!) {
              findScene(id: $id) {
                id title
                tags { id name }
                files { id path basename duration size video_codec audio_codec width height format }
              }
            }""",
            {"id": scene_id},
        )
        scene = data["findScene"]
        if not scene:
            raise PluginError("scene %s not found" % scene_id)
        return scene

    def scenes_with_file(self, path):
        q = """query ($f: SceneFilterType) {
          findScenes(scene_filter: $f, filter: {per_page: -1}) { scenes { id files { id path } } }
        }"""
        found = []
        for crit in (
            {"value": path, "modifier": "EQUALS"},
            {"value": os.path.basename(path), "modifier": "INCLUDES"},
        ):
            scenes = self.call(q, {"f": {"path": crit}})["findScenes"]["scenes"]
            found = [
                (s, f)
                for s in scenes
                for f in s["files"]
                if same_path(f["path"], path)
            ]
            if found:
                break
        return found

    def find_tag(self, name):
        data = self.call(
            """query ($name: String!) {
              findTags(tag_filter: {name: {value: $name, modifier: EQUALS}}, filter: {per_page: -1}) {
                tags { id name }
              }
            }""",
            {"name": name},
        )
        for t in data["findTags"]["tags"]:
            if t["name"].lower() == name.lower():
                return t["id"]
        return None

    def ensure_tag(self, name):
        tag_id = self.find_tag(name)
        if tag_id:
            return tag_id
        data = self.call(
            "mutation ($input: TagCreateInput!) { tagCreate(input: $input) { id } }",
            {
                "input": {
                    "name": name,
                    "description": "Original files replaced by the Reencode plugin.",
                    "ignore_auto_tag": True,
                }
            },
        )
        log("i", "Created tag %s" % name)
        return data["tagCreate"]["id"]

    def job_status(self, job_id):
        data = self.call("query ($id: ID!) { findJob(input: {id: $id}) { status } }", {"id": job_id})
        job = data["findJob"]
        return job and job["status"]

    def run_task(self, description, args):
        data = self.call(
            """mutation ($id: ID!, $description: String, $args: Map) {
              runPluginTask(plugin_id: $id, description: $description, args_map: $args)
            }""",
            {"id": PLUGIN_ID, "description": description, "args": args},
        )
        return data["runPluginTask"]


def same_path(a, b):
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


# --- run state, read back by the UI ---------------------------------------------


def state_path(scene_id):
    return os.path.join(STATE_DIR, "%s.json" % scene_id)


def write_state(scene_id, state, **extra):
    if not scene_id:
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        data = dict(extra, state=state, time=datetime.datetime.now().isoformat(timespec="seconds"))
        with open(state_path(scene_id), "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError as e:
        log("w", "could not write state: %s" % e)


def read_state(scene_id):
    try:
        with open(state_path(scene_id), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# --- ffmpeg ----------------------------------------------------------------------


def find_tool(name, configured, stash_config_dir):
    exe = name + (".exe" if os.name == "nt" else "")
    for candidate in (configured, shutil.which(name)):
        if candidate and (os.path.isfile(candidate) or shutil.which(candidate)):
            return candidate
    # Stash downloads its own copy into the config directory
    if stash_config_dir:
        local = os.path.join(stash_config_dir, exe)
        if os.path.isfile(local):
            return local
    return None


def available_encoders(ffmpeg):
    out = subprocess.run(
        [ffmpeg, "-hide_banner", "-encoders"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        universal_newlines=True,
    ).stdout
    names = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and len(parts[0]) == 6 and parts[0][0] in "VAS":
            names.add(parts[1])
    return names


def probe_audio_codecs(ffprobe, path):
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=codec_name", "-of", "json", path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            universal_newlines=True,
            timeout=60,
        ).stdout
        return [s.get("codec_name") for s in json.loads(out).get("streams", [])]
    except Exception:
        return None


def probe_duration(ffprobe, path):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        universal_newlines=True,
        timeout=120,
    ).stdout
    return float(json.loads(out)["format"]["duration"])


def split_args(s):
    return shlex.split(s) if s and s.strip() else []


def build_output_args(settings, ext, encoders, audio_codecs):
    """Everything between the input and the output file name."""
    custom = settings.get("outputArgs") or ""
    if custom.strip():
        return split_args(custom)

    args = ["-map", "0:V:0", "-map", "0:a?"]
    if ext in ("mkv", "mk3d"):
        # matroska takes any subtitle and attachment (fonts) as-is
        args += ["-map", "0:s?", "-map", "0:t?", "-c:s", "copy", "-c:t", "copy"]
    args += ["-map_metadata", "0", "-map_chapters", "0"]

    vcodec = (settings.get("videoCodec") or "").strip()
    if not vcodec:
        vcodec = next((e for e in DEFAULT_VIDEO_ENCODERS if e in encoders), None)
        if not vcodec:
            raise PluginError(
                "this ffmpeg has none of %s; set a video encoder in the plugin settings"
                % ", ".join(DEFAULT_VIDEO_ENCODERS)
            )
    elif vcodec != "copy" and encoders and vcodec not in encoders:
        raise PluginError("this ffmpeg has no %s encoder" % vcodec)
    vargs = settings.get("videoArgs") or ""
    if not vargs.strip():
        vargs = VIDEO_DEFAULT_ARGS.get(vcodec, "")
    args += ["-c:v", vcodec] + split_args(vargs)
    # Safari and Stash's direct play only accept HEVC in MP4 tagged hvc1
    if vcodec in HEVC_ENCODERS and ext in MP4_LIKE and "-tag:v" not in vargs:
        args += ["-tag:v", "hvc1"]

    acodec = (settings.get("audioCodec") or "").strip()
    aargs = settings.get("audioArgs") or ""
    if not acodec:
        playable = {"opus", "vorbis"} if ext == "webm" else {"aac", "mp3", "opus"}
        if audio_codecs is not None and all(c in playable for c in audio_codecs):
            acodec = "copy"
        else:
            acodec = "libopus" if ext == "webm" else "aac"
    if acodec != "copy" and not aargs.strip():
        aargs = "-b:a 192k"
    args += ["-c:a", acodec] + split_args(aargs)

    args += split_args(settings.get("extraArgs") or "")
    if ext in MP4_LIKE:
        args += ["-movflags", "+faststart"]
    return args


def kill_with_parent():
    """Make ffmpeg die with this process. Stash kills the plugin process when
    the job is cancelled, which would otherwise leave ffmpeg running."""
    if sys.platform.startswith("linux"):
        import ctypes
        import signal

        libc = ctypes.CDLL(None, use_errno=True)

        def preexec():
            libc.prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG

        return preexec, None

    if os.name == "nt":
        try:
            return None, _windows_kill_job()
        except Exception as e:
            log("d", "could not create job object: %s" % e)
    return None, None


def _windows_kill_job():
    import ctypes
    from ctypes import wintypes

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BASIC_LIMIT),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

    job = k32.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())

    def assign(proc):
        if not k32.AssignProcessToJobObject(job, int(proc._handle)):
            log("d", "could not assign ffmpeg to job object: %s" % ctypes.WinError(ctypes.get_last_error()))

    # the handle stays open for the life of this process; closing it on exit
    # is what kills ffmpeg
    return assign


def run_ffmpeg(cmd, duration):
    preexec, assign = kill_with_parent()
    log("d", "ffmpeg: " + subprocess.list2cmdline(cmd))
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        errors="replace",
        preexec_fn=preexec,
    )
    if assign:
        assign(proc)

    tail = collections.deque(maxlen=40)

    def read_stderr():
        for line in proc.stderr:
            tail.append(line.rstrip())

    reader = threading.Thread(target=read_stderr, daemon=True)
    reader.start()

    last_log = time.monotonic()
    speed = ""
    for line in proc.stdout:
        key, _, value = line.strip().partition("=")
        if key == "speed":
            speed = value
        elif key in ("out_time_us", "out_time_ms") and duration:
            try:
                done = int(value) / 1e6 / duration
            except ValueError:
                continue
            progress(done)
            if time.monotonic() - last_log > 300:
                log("i", "%.0f%% (speed %s)" % (done * 100, speed or "?"))
                last_log = time.monotonic()

    proc.wait()
    reader.join(timeout=5)
    if proc.returncode != 0:
        raise PluginError("ffmpeg exited with code %s:\n%s" % (proc.returncode, "\n".join(tail)))


# --- modes -----------------------------------------------------------------------


def tag_name(settings):
    return (settings.get("tagName") or "").strip() or DEFAULT_TAG


def pick_names(src, ext):
    """Returns (new file path, new basename for the original or None)."""
    folder = os.path.dirname(src)
    stem = os.path.splitext(os.path.basename(src))[0]
    target = os.path.join(folder, "%s.%s" % (stem, ext))
    if not os.path.exists(target):
        return target, None
    if same_path(target, src):
        # same container: the new file takes the original's name and the
        # original is renamed, so sidecar files (funscripts, captions) that
        # match by name follow the new file
        for n in range(1, 100):
            suffix = ".original" if n == 1 else ".original%d" % n
            name = "%s%s.%s" % (stem, suffix, os.path.splitext(src)[1].lstrip("."))
            if not os.path.exists(os.path.join(folder, name)):
                return target, name
    for n in range(1, 100):
        suffix = ".reencoded" if n == 1 else ".reencoded%d" % n
        path = os.path.join(folder, "%s%s.%s" % (stem, suffix, ext))
        if not os.path.exists(path):
            return path, None
    raise PluginError("no free file name next to %s" % src)


def encode(stash, args):
    scene_id = str(args.get("scene_id") or "")
    if not scene_id:
        raise PluginError("run this from the Reencode button on a scene's edit panel")
    settings = stash.settings()
    scene = stash.scene(scene_id)
    if not scene["files"]:
        raise PluginError("scene %s has no files" % scene_id)

    tag = tag_name(settings).lower()
    if any(t["name"].lower() == tag for t in scene["tags"]):
        raise PluginError("scene %s is an original (tagged %s); re-encode the scene it came from" % (scene_id, tag_name(settings)))

    original = scene["files"][0]
    src = original["path"]
    if not os.path.isfile(src):
        raise PluginError("can't read %s from the plugin" % src)

    cfg_ffmpeg, cfg_ffprobe = stash.ffmpeg_config()
    ffmpeg = find_tool("ffmpeg", (settings.get("ffmpegPath") or "").strip() or cfg_ffmpeg, stash.config_dir)
    if not ffmpeg:
        raise PluginError("ffmpeg not found; set its path in the plugin settings")
    sibling = os.path.join(os.path.dirname(ffmpeg), os.path.basename(ffmpeg).replace("ffmpeg", "ffprobe"))
    ffprobe = find_tool("ffprobe", sibling if os.path.isfile(sibling) else cfg_ffprobe, stash.config_dir)

    ext = (settings.get("container") or "").strip().lstrip(".").lower() or "mp4"
    output_args = build_output_args(
        settings, ext, available_encoders(ffmpeg), probe_audio_codecs(ffprobe, src)
    )

    target, original_rename = pick_names(src, ext)
    part = target + ".part"  # not a video extension, so a scan meanwhile skips it

    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y"]
    cmd += split_args(settings.get("inputArgs") or "")
    cmd += ["-i", src] + output_args
    cmd += ["-f", MUXERS.get(ext, ext), "-progress", "pipe:1", "-nostats", part]

    write_state(scene_id, "encoding", file=src)
    log("i", "Re-encoding %s" % src)
    started = time.monotonic()
    try:
        run_ffmpeg(cmd, original.get("duration") or 0)
        if ffprobe:
            try:
                got = probe_duration(ffprobe, part)
            except Exception as e:
                raise PluginError("ffprobe can't read the new file: %s" % e)
            want = original.get("duration") or 0
            if want and abs(got - want) > max(2.0, want * 0.01):
                raise PluginError("new file is %.1fs long but the original is %.1fs" % (got, want))
    except BaseException:
        try:
            os.remove(part)
        except OSError:
            pass
        raise

    if original_rename:
        try:
            stash.call(
                "mutation ($input: MoveFilesInput!) { moveFiles(input: $input) }",
                {
                    "input": {
                        "ids": [original["id"]],
                        "destination_folder": os.path.dirname(src),
                        "destination_basename": original_rename,
                    }
                },
            )
            log("i", "Renamed original to %s" % original_rename)
        except Exception as e:
            log("w", "could not rename the original (%s); keeping its name" % e)
            target = pick_free_suffix(target)
    os.rename(part, target)

    size = os.path.getsize(target)
    log(
        "i",
        "Encoded %s in %s: %s -> %s (%.0f%%)"
        % (
            os.path.basename(target),
            datetime.timedelta(seconds=round(time.monotonic() - started)),
            human_size(original.get("size") or 0),
            human_size(size),
            100.0 * size / original["size"] if original.get("size") else 0,
        ),
    )

    scan_job = stash.call(
        "mutation ($input: ScanMetadataInput!) { metadataScan(input: $input) }",
        {"input": {"paths": [target]}},
    )["metadataScan"]
    stash.run_task(
        "Re-encode scene %s: finalize" % scene_id,
        {
            "mode": "finalize",
            "scene_id": scene_id,
            "new_path": target,
            "original_file_id": original["id"],
            "scan_job_id": scan_job,
        },
    )
    write_state(scene_id, "finalizing", file=target)
    return {"new_path": target}


def pick_free_suffix(target):
    stem, ext = os.path.splitext(target)
    for n in range(1, 100):
        path = "%s%s%s" % (stem, ".reencoded" if n == 1 else ".reencoded%d" % n, ext)
        if not os.path.exists(path):
            return path
    raise PluginError("no free file name for %s" % target)


def human_size(n):
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024:
            return "%.1f %s" % (n, unit)
        n /= 1024.0
    return "%.1f TiB" % n


def finalize(stash, args):
    scene_id = str(args["scene_id"])
    new_path = args["new_path"]
    original_file_id = str(args["original_file_id"])
    settings = stash.settings()

    # the queue is serial, so the scan has normally finished already
    scan_job = args.get("scan_job_id")
    deadline = time.monotonic() + 3600
    while scan_job and time.monotonic() < deadline:
        status = stash.job_status(scan_job)
        if status in (None, "FINISHED", "CANCELLED", "FAILED"):
            break
        time.sleep(2)

    found = stash.scenes_with_file(new_path)
    if not found:
        raise PluginError(
            "Stash didn't add %s to the library; check it isn't excluded, then scan it and re-run" % new_path
        )
    new_scene, new_file = found[0]

    scene = stash.scene(scene_id)
    if new_scene["id"] != scene["id"]:
        stash.call(
            "mutation ($input: AssignSceneFileInput!) { sceneAssignFile(input: $input) }",
            {"input": {"scene_id": scene_id, "file_id": new_file["id"]}},
        )
    stash.call(
        "mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
        {"input": {"id": scene_id, "primary_file_id": new_file["id"]}},
    )
    log("i", "Scene %s now uses %s" % (scene_id, new_path))

    # the scan made a scene for the new file; it is empty now
    if new_scene["id"] != scene["id"] and len(new_scene["files"]) == 1:
        stash.call(
            "mutation ($input: SceneDestroyInput!) { sceneDestroy(input: $input) }",
            {"input": {"id": new_scene["id"], "delete_file": False, "delete_generated": False}},
        )

    archive_id = None
    if not settings.get("keepOriginalAttached"):
        original = next((f for f in scene["files"] if str(f["id"]) == original_file_id), None)
        if original:
            tag_id = stash.ensure_tag(tag_name(settings))
            data = stash.call(
                "mutation ($input: SceneCreateInput!) { sceneCreate(input: $input) { id } }",
                {
                    "input": {
                        "title": scene["title"] or os.path.splitext(original["basename"])[0],
                        "details": "Original file of scene %s, replaced by a re-encode on %s."
                        % (scene_id, datetime.date.today().isoformat()),
                        "organized": True,
                        "tag_ids": [tag_id],
                        "file_ids": [original_file_id],
                    }
                },
            )
            archive_id = data["sceneCreate"]["id"]
            log("i", "Moved the original to scene %s, tagged %s" % (archive_id, tag_name(settings)))
        else:
            log("w", "original file %s is no longer on scene %s; leaving it alone" % (original_file_id, scene_id))

    if not settings.get("skipGenerate"):
        stash.call(
            "mutation ($input: GenerateMetadataInput!) { metadataGenerate(input: $input) }",
            {
                "input": {
                    "sceneIDs": [scene_id],
                    "sprites": True,
                    "previews": True,
                    "markers": True,
                    "phashes": True,
                    "overwrite": False,
                }
            },
        )

    write_state(scene_id, "done", file=new_path, original_scene=archive_id)
    return {"scene_id": scene_id, "original_scene_id": archive_id}


def status(args):
    return read_state(str(args.get("scene_id") or "")) or {"state": "none"}


def main():
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    args = data.get("args") or {}
    mode = args.get("mode")
    scene_id = str(args.get("scene_id") or "")
    try:
        if mode == "status":
            result = status(args)
        else:
            stash = Stash(data.get("server_connection") or {})
            if mode == "encode":
                result = encode(stash, args)
            elif mode == "finalize":
                result = finalize(stash, args)
            else:
                raise PluginError("unknown mode %r" % mode)
        print(json.dumps({"output": result}))
    except Exception as e:
        msg = str(e) or e.__class__.__name__
        log("e", "Reencode: " + msg)
        if mode in ("encode", "finalize"):
            write_state(scene_id, "error", message=msg)
        print(json.dumps({"error": msg}))


if __name__ == "__main__":
    main()
