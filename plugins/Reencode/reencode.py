"""Re-encodes Stash scenes' files and swaps the new file in as the scene's file.

As the Reencode plugin, Stash runs it with the raw interface. args["mode"]:

  encode    job: encode the scene's primary file next to it, then queue a scan
            of the new file and a finalize job (the job queue is serial, so
            finalize runs after the scan)
  finalize  job: move the new file onto the scene as its primary file, then
            delete the original, or move it to the backup folder
  status    operation: report how the last run for a scene ended

From the command line, on any Windows, Linux or macOS machine that can reach
Stash and see its files over a share, it re-encodes every scene with a tag:

  python reencode.py --stash http://nas:9999 --tag "{REENCODE}" --map /data=//nas/media

Run it with --help for the options. Only the standard library is used, so it
runs on any Python 3.8+.
"""

import argparse
import collections
import datetime
import json
import ntpath
import os
import posixpath
import re
import shlex
import shutil
import signal
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

PLUGIN_ID = "Reencode"
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")

# Encoders tried in order when no video encoder is configured.
DEFAULT_VIDEO_ENCODERS = ["libsvtav1", "libx265"]

VIDEO_DEFAULT_ARGS = {
    "libsvtav1": "-crf 28 -preset 4 -pix_fmt yuv420p10le -g 240"
    " -svtav1-params tune=0:enable-variance-boost=1",
    "libaom-av1": "-crf 30 -b:v 0 -cpu-used 4 -row-mt 1 -pix_fmt yuv420p10le",
    "librav1e": "-qp 80 -speed 6",
    "av1_nvenc": "-preset p6 -rc vbr -cq 32 -b:v 0",
    "av1_qsv": "-preset slow -global_quality 28",
    "av1_amf": "-quality quality -rc cqp -qp_i 120 -qp_p 120",
    "libx265": "-crf 24 -preset medium -pix_fmt yuv420p10le",
    "hevc_nvenc": "-preset p7 -tune hq -rc vbr -cq 24 -b:v 0 -multipass fullres"
    " -rc-lookahead 32 -spatial-aq 1 -temporal-aq 1 -bf 4 -b_ref_mode middle"
    " -pix_fmt p010le -profile:v main10",
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

SCENE_FIELDS = """
  id title
  tags { id name }
  files { id path basename duration size video_codec audio_codec width height format }
"""


class PluginError(Exception):
    pass


# --- logging -------------------------------------------------------------------
#
# As a plugin, messages go to stderr in Stash's plugin log protocol. From the
# command line they are plain text, with a progress line on a terminal.

CLI = False
VERBOSE = False
_progress_shown = False


def _end_progress_line():
    global _progress_shown
    if _progress_shown:
        sys.stderr.write("\n")
        _progress_shown = False


def log(level, msg):
    lines = str(msg).splitlines() or [""]
    if CLI:
        if level == "d" and not VERBOSE:
            return
        _end_progress_line()
        prefix = {"w": "warning: ", "e": "error: "}.get(level, "")
        for line in lines:
            sys.stderr.write(prefix + line + "\n")
    else:
        for line in lines:
            sys.stderr.write("\x01%s\x02%s\n" % (level, line))
    sys.stderr.flush()


def progress(p, speed=""):
    global _progress_shown
    p = max(0.0, min(1.0, p))
    if not CLI:
        sys.stderr.write("\x01p\x02%.4f\n" % p)
    elif sys.stderr.isatty():
        sys.stderr.write("\r  %5.1f%%  %-12s" % (p * 100, ("speed " + speed) if speed else ""))
        _progress_shown = True
    sys.stderr.flush()


# --- GraphQL -------------------------------------------------------------------


class Stash:
    def __init__(self, url, headers=None, verify=True):
        self.url = url.rstrip("/")
        if not self.url.endswith("/graphql"):
            self.url += "/graphql"
        self.headers = {"Content-Type": "application/json", "Accept": "application/json"}
        self.headers.update(headers or {})
        self.ssl = None
        if self.url.startswith("https:") and not verify:
            self.ssl = ssl._create_unverified_context()

    @classmethod
    def from_plugin(cls, conn):
        scheme = conn.get("Scheme") or "http"
        host = conn.get("Host") or "localhost"
        if host in ("0.0.0.0", "::", "[::]"):
            host = "localhost"
        if ":" in host and not host.startswith("["):
            host = "[%s]" % host
        headers = {}
        cookie = conn.get("SessionCookie") or {}
        if cookie.get("Name"):
            headers["Cookie"] = "%s=%s" % (cookie["Name"], cookie.get("Value", ""))
        # the server is local; its certificate may be self-signed
        url = "%s://%s:%s/graphql" % (scheme, host, conn.get("Port") or 9999)
        return cls(url, headers, verify=False)

    def call(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(self.url, data=body, headers=self.headers)
        try:
            with urllib.request.urlopen(req, context=self.ssl, timeout=120) as res:
                data = json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise PluginError("Stash refused the request (HTTP %s); check the API key" % e.code)
            raise PluginError("Stash returned HTTP %s" % e.code)
        except urllib.error.URLError as e:
            raise PluginError("can't reach Stash at %s: %s" % (self.url, e.reason))
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
        data = self.call("query ($id: ID!) { findScene(id: $id) { %s } }" % SCENE_FIELDS, {"id": scene_id})
        scene = data["findScene"]
        if not scene:
            raise PluginError("scene %s not found" % scene_id)
        return scene

    def scenes_with_tag(self, tag_id):
        data = self.call(
            """query ($f: SceneFilterType) {
              findScenes(scene_filter: $f, filter: {per_page: -1, sort: "id", direction: ASC}) {
                scenes { %s }
              }
            }"""
            % SCENE_FIELDS,
            {"f": {"tags": {"value": [tag_id], "modifier": "INCLUDES", "depth": 0}}},
        )
        return data["findScenes"]["scenes"]

    def scenes_with_file(self, path):
        q = """query ($f: SceneFilterType) {
          findScenes(scene_filter: $f, filter: {per_page: -1}) { scenes { id files { id path } } }
        }"""
        found = []
        for crit in (
            {"value": path, "modifier": "EQUALS"},
            {"value": stash_pathmod(path).basename(path), "modifier": "INCLUDES"},
        ):
            scenes = self.call(q, {"f": {"path": crit}})["findScenes"]["scenes"]
            found = [
                (s, f)
                for s in scenes
                for f in s["files"]
                if same_stash_path(f["path"], path)
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

    def remove_tag(self, scene_id, tag_id):
        self.call(
            "mutation ($input: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $input) { id } }",
            {"input": {"ids": [scene_id], "tag_ids": {"ids": [tag_id], "mode": "REMOVE"}}},
        )

    def job_status(self, job_id):
        data = self.call("query ($id: ID!) { findJob(input: {id: $id}) { status } }", {"id": job_id})
        job = data["findJob"]
        return job and job["status"]

    def wait_for_job(self, job_id, timeout=None, what="job"):
        """Returns when the job has ended, or False on timeout."""
        start = last_note = time.monotonic()
        while True:
            if self.job_status(job_id) in (None, "FINISHED", "CANCELLED", "FAILED"):
                return True
            now = time.monotonic()
            if timeout and now - start > timeout:
                return False
            if now - last_note > 60:
                log("i", "Still waiting for Stash's %s (other jobs may be ahead of it)" % what)
                last_note = now
            time.sleep(2)

    def run_task(self, description, args):
        data = self.call(
            """mutation ($id: ID!, $description: String, $args: Map) {
              runPluginTask(plugin_id: $id, description: $description, args_map: $args)
            }""",
            {"id": PLUGIN_ID, "description": description, "args": args},
        )
        return data["runPluginTask"]


# --- paths -----------------------------------------------------------------------
#
# Stash reports paths as its own machine sees them, which may be a different OS
# from the one running this script. Stash-side paths are handled with ntpath or
# posixpath by their look, never with os.path.


def is_windows_path(p):
    return bool(re.match(r"^[A-Za-z]:([\\/]|$)", p)) or p.startswith("\\\\")


def stash_pathmod(p):
    return ntpath if is_windows_path(p) else posixpath


def _path_key(p, windows):
    return p.replace("/", "\\").rstrip("\\").lower() if windows else p.rstrip("/")


def same_stash_path(a, b):
    windows = is_windows_path(a) or is_windows_path(b)
    return _path_key(a, windows) == _path_key(b, windows)


def _relative_parts(path, prefix, windows):
    """The components of path below prefix, or None if it isn't below it."""
    sep = "\\" if windows else "/"
    p, pre = _path_key(path, windows), _path_key(prefix, windows)
    if p == pre:
        return []
    if not p.startswith(pre + sep):
        return None
    rest = path[len(pre) + 1:]
    return [part for part in re.split(r"[\\/]" if windows else "/", rest) if part]


class PathMap:
    """Translates between paths as Stash sees them and as this machine sees them."""

    def __init__(self, pairs=()):
        # longest Stash prefix first, so nested mappings win
        self.pairs = sorted(pairs, key=lambda p: len(p[0]), reverse=True)

    @classmethod
    def parse(cls, specs):
        pairs = []
        for spec in specs:
            stash_prefix, sep, local_prefix = spec.partition("=")
            if not sep or not stash_prefix or not local_prefix:
                raise PluginError("--map needs STASH_PATH=LOCAL_PATH, got %r" % spec)
            if re.match(r"^[A-Za-z]:$", local_prefix):
                local_prefix += "\\"  # "Z:" alone means the drive's current folder
            pairs.append((stash_prefix, local_prefix))
        return cls(pairs)

    def to_local(self, stash_path):
        for stash_prefix, local_prefix in self.pairs:
            parts = _relative_parts(stash_path, stash_prefix, is_windows_path(stash_prefix))
            if parts is not None:
                return os.path.join(local_prefix, *parts) if parts else local_prefix
        if self.pairs and not os.path.exists(stash_path):
            raise PluginError("no --map covers %s" % stash_path)
        return stash_path

    def to_stash(self, local_path):
        for stash_prefix, local_prefix in self.pairs:
            parts = _relative_parts(local_path, local_prefix, os.name == "nt")
            if parts is not None:
                if not parts:
                    return stash_prefix
                sep = "\\" if is_windows_path(stash_prefix) else "/"
                return stash_prefix.rstrip("\\/") + sep + sep.join(parts)
        return local_path


# --- run state, read back by the UI ---------------------------------------------


def state_path(scene_id):
    return os.path.join(STATE_DIR, "%s.json" % scene_id)


def write_state(scene_id, state, **extra):
    if CLI or not scene_id:
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


def find_tool(name, configured, stash_config_dir=""):
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


def find_ffprobe(ffmpeg, fallback=""):
    folder, base = os.path.split(ffmpeg)
    sibling = os.path.join(folder, base.lower().replace("ffmpeg", "ffprobe"))
    return find_tool("ffprobe", sibling if folder and os.path.isfile(sibling) else fallback)


class Tools:
    def __init__(self, ffmpeg, ffprobe):
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.encoders = available_encoders(ffmpeg)


def available_encoders(ffmpeg):
    out = subprocess.run(
        [ffmpeg, "-hide_banner", "-encoders"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        universal_newlines=True,
        errors="replace",
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
            errors="replace",
            timeout=120,
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
        errors="replace",
        timeout=300,
    ).stdout
    return float(json.loads(out)["format"]["duration"])


def split_args(s):
    return shlex.split(s) if s and s.strip() else []


def video_encoder(settings, encoders):
    vcodec = (settings.get("videoCodec") or "").strip()
    if not vcodec:
        vcodec = next((e for e in DEFAULT_VIDEO_ENCODERS if e in encoders), None)
        if not vcodec:
            raise PluginError(
                "this ffmpeg has none of %s; set a video encoder"
                % ", ".join(DEFAULT_VIDEO_ENCODERS)
            )
    elif vcodec != "copy" and encoders and vcodec not in encoders:
        raise PluginError("this ffmpeg has no %s encoder" % vcodec)
    return vcodec


def container(settings):
    return (settings.get("container") or "").strip().lstrip(".").lower() or "mp4"


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

    vcodec = video_encoder(settings, encoders)
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

    try:
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
                progress(done, speed)
                if time.monotonic() - last_log > 300:
                    log("i", "%.0f%% (speed %s)" % (done * 100, speed or "?"))
                    last_log = time.monotonic()
        proc.wait()
    finally:
        # interrupted: make sure ffmpeg has let go of the output before cleanup
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        _end_progress_line()
    reader.join(timeout=5)
    if proc.returncode != 0:
        raise PluginError("ffmpeg exited with code %s:\n%s" % (proc.returncode, "\n".join(tail)))


# --- encoding ----------------------------------------------------------------------


def check_scene(scene):
    """Returns the scene's primary file, or raises if it can't be re-encoded."""
    if not scene["files"]:
        raise PluginError("scene %s has no files" % scene["id"])
    return scene["files"][0]


def backup_dir(settings, paths, create=True):
    """The local folder originals are moved to, or None to delete them.
    Checked before encoding, so a bad setting doesn't waste an encode."""
    if not settings.get("backupOriginals"):
        return None
    local = settings.get("backupDirLocal")  # --backup-dir, already local
    if not local:
        folder = (settings.get("backupFolder") or "").strip()
        if not folder:
            raise PluginError("backing up originals is on, but no backup folder is set")
        local = paths.to_local(folder)
    local = os.path.abspath(local)
    if create:
        try:
            os.makedirs(local, exist_ok=True)
        except OSError as e:
            raise PluginError("can't create the backup folder %s: %s" % (local, e))
    elif not os.path.isdir(local):
        log("i", "The backup folder %s doesn't exist yet; it will be created" % local)
    return local


def free_path(path):
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    for n in range(2, 1000):
        candidate = "%s (%d)%s" % (stem, n, ext)
        if not os.path.exists(candidate):
            return candidate
    raise PluginError("no free file name for %s" % path)


def pick_names(src, ext):
    """Returns (new file path, new basename for the original or None)."""
    folder = os.path.dirname(src)
    stem = os.path.splitext(os.path.basename(src))[0]
    target = os.path.join(folder, "%s.%s" % (stem, ext))
    if not os.path.exists(target):
        return target, None
    if os.path.normcase(target) == os.path.normcase(src):
        # same container: the new file takes the original's name and the
        # original is renamed, so sidecar files (funscripts, captions) that
        # match by name follow the new file
        for n in range(1, 100):
            suffix = ".original" if n == 1 else ".original%d" % n
            name = "%s%s.%s" % (stem, suffix, os.path.splitext(src)[1].lstrip("."))
            if not os.path.exists(os.path.join(folder, name)):
                return target, name
    return pick_free_suffix(target), None


def pick_free_suffix(target):
    stem, ext = os.path.splitext(target)
    for n in range(1, 100):
        path = "%s%s%s" % (stem, ".reencoded" if n == 1 else ".reencoded%d" % n, ext)
        if not os.path.exists(path):
            return path
    raise PluginError("no free file name for %s" % target)


def move_into_place(part, target):
    # A network share can take a moment to show the original's rename. Never
    # overwrite: on Linux os.rename would replace whatever is at target.
    for _ in range(20):
        if not os.path.exists(target):
            os.rename(part, target)
            return
        time.sleep(0.5)
    raise PluginError("%s still exists; the new file is left at %s" % (target, part))


def human_size(n):
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024:
            return "%.1f %s" % (n, unit)
        n /= 1024.0
    return "%.1f TiB" % n


def encode_file(stash, original, settings, tools, paths):
    """Encodes the file next to itself and renames it into place. Returns the
    new file's path as Stash sees it."""
    src_stash = original["path"]
    src = paths.to_local(src_stash)
    if not os.path.isfile(src):
        raise PluginError("can't read %s" % src)

    ext = container(settings)
    output_args = build_output_args(
        settings, ext, tools.encoders, probe_audio_codecs(tools.ffprobe, src)
    )

    target, original_rename = pick_names(src, ext)
    part = target + ".part"  # not a video extension, so a scan meanwhile skips it

    cmd = [tools.ffmpeg, "-hide_banner", "-nostdin", "-y"]
    cmd += split_args(settings.get("inputArgs") or "")
    cmd += ["-i", src] + output_args
    cmd += ["-f", MUXERS.get(ext, ext), "-progress", "pipe:1", "-nostats", part]

    log("i", "Re-encoding %s" % src)
    started = time.monotonic()
    want = original.get("duration") or 0
    try:
        run_ffmpeg(cmd, want)
        if tools.ffprobe:
            try:
                got = probe_duration(tools.ffprobe, part)
            except Exception as e:
                raise PluginError("ffprobe can't read the new file: %s" % e)
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
                        "destination_folder": stash_pathmod(src_stash).dirname(src_stash),
                        "destination_basename": original_rename,
                    }
                },
            )
            log("i", "Renamed original to %s" % original_rename)
        except Exception as e:
            log("w", "could not rename the original (%s); keeping its name" % e)
            target = pick_free_suffix(target)
    move_into_place(part, target)

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
    return paths.to_stash(target)


def scan(stash, path):
    return stash.call(
        "mutation ($input: ScanMetadataInput!) { metadataScan(input: $input) }",
        {"input": {"paths": [path]}},
    )["metadataScan"]


def swap(stash, scene_id, new_path, original_file_id, original_name, settings, paths, backup):
    """Makes the scanned new file the scene's primary file, then deletes the
    original or moves it to the backup folder. Returns where the original
    went, or None if it was deleted."""
    found = stash.scenes_with_file(new_path)
    if not found:
        raise PluginError(
            "Stash didn't add %s to the library; check it isn't excluded, then scan it and re-run" % new_path
        )
    new_scene, new_file = found[0]

    scene = stash.scene(scene_id)
    if new_scene["id"] != scene["id"]:
        # The scan made a scene for the new file. The file is that scene's
        # primary, which sceneAssignFile refuses to move, so merge the scene
        # in instead: its files move over, the scene's own metadata and
        # primary file stay, and the scan-made scene is deleted.
        stash.call(
            "mutation ($input: SceneMergeInput!) { sceneMerge(input: $input) { id } }",
            {"input": {"source": [new_scene["id"]], "destination": scene_id}},
        )
    stash.call(
        "mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
        {"input": {"id": scene_id, "primary_file_id": new_file["id"]}},
    )
    log("i", "Scene %s now uses %s" % (scene_id, new_path))

    # only let go of the original once Stash confirms the scene plays the new file
    scene = stash.scene(scene_id)
    if not same_stash_path(scene["files"][0]["path"], new_path):
        raise PluginError("scene %s didn't switch to the new file; the original was left alone" % scene_id)
    original = next((f for f in scene["files"] if str(f["id"]) == str(original_file_id)), None)
    went_to = None
    if not original:
        log("w", "original file %s is no longer on scene %s; leaving it alone" % (original_file_id, scene_id))
    elif backup is None:
        # Stash deletes it from disk, or moves it to its trash folder if one is set
        stash.call("mutation ($ids: [ID!]!) { deleteFiles(ids: $ids) }", {"ids": [str(original_file_id)]})
        log("i", "Deleted the original %s" % original["path"])
    else:
        # by its name before any rename to make room for the new file
        name = original_name or stash_pathmod(original["path"]).basename(original["path"])
        went_to = free_path(os.path.join(backup, name))
        try:
            shutil.move(paths.to_local(original["path"]), went_to)
        except OSError as e:
            raise PluginError(
                "couldn't move the original to the backup folder (%s); it is still on the scene "
                "as a second file, %s" % (e, original["path"])
            )
        # drop Stash's record of the old location without touching the moved file
        stash.call("mutation ($ids: [ID!]!) { destroyFiles(ids: $ids) }", {"ids": [str(original_file_id)]})
        log("i", "Moved the original to %s" % went_to)

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
    return went_to


# --- plugin modes --------------------------------------------------------------------


def plugin_encode(stash, conn, args):
    scene_id = str(args.get("scene_id") or "")
    if not scene_id:
        raise PluginError("run this from the Reencode button on a scene's edit panel")
    settings = stash.settings()
    original = check_scene(stash.scene(scene_id))
    backup_dir(settings, PathMap())  # fail now, not after the encode

    cfg_ffmpeg, cfg_ffprobe = stash.ffmpeg_config()
    ffmpeg = find_tool("ffmpeg", (settings.get("ffmpegPath") or "").strip() or cfg_ffmpeg, conn.get("Dir") or "")
    if not ffmpeg:
        raise PluginError("ffmpeg not found; set its path in the plugin settings")
    tools = Tools(ffmpeg, find_ffprobe(ffmpeg, cfg_ffprobe))

    write_state(scene_id, "encoding", file=original["path"])
    target = encode_file(stash, original, settings, tools, PathMap())
    scan_job = scan(stash, target)
    stash.run_task(
        "Re-encode scene %s: finalize" % scene_id,
        {
            "mode": "finalize",
            "scene_id": scene_id,
            "new_path": target,
            "original_file_id": original["id"],
            "original_name": original["basename"],
            "scan_job_id": scan_job,
        },
    )
    write_state(scene_id, "finalizing", file=target)
    return {"new_path": target}


def plugin_finalize(stash, args):
    scene_id = str(args["scene_id"])
    settings = stash.settings()
    # the queue is serial, so the scan has normally finished already
    if args.get("scan_job_id"):
        stash.wait_for_job(args["scan_job_id"], timeout=3600, what="scan")
    paths = PathMap()
    went_to = swap(
        stash, scene_id, args["new_path"], args["original_file_id"],
        args.get("original_name") or "", settings, paths, backup_dir(settings, paths),
    )
    write_state(scene_id, "done", file=args["new_path"], backup=went_to)
    return {"scene_id": scene_id, "backup": went_to}


def plugin_main():
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    args = data.get("args") or {}
    conn = data.get("server_connection") or {}
    mode = args.get("mode")
    scene_id = str(args.get("scene_id") or "")
    try:
        if mode == "status":
            result = read_state(scene_id) or {"state": "none"}
        elif mode == "encode":
            result = plugin_encode(Stash.from_plugin(conn), conn, args)
        elif mode == "finalize":
            result = plugin_finalize(Stash.from_plugin(conn), args)
        else:
            raise PluginError("unknown mode %r" % mode)
        print(json.dumps({"output": result}))
    except Exception as e:
        msg = str(e) or e.__class__.__name__
        log("e", "Reencode: " + msg)
        if mode in ("encode", "finalize"):
            write_state(scene_id, "error", message=msg)
        print(json.dumps({"error": msg}))


# --- command line ------------------------------------------------------------------------


class DeferInterrupt:
    """Holds off Ctrl+C while Stash is mid-swap, so a scene isn't left half done."""

    def __enter__(self):
        self.hit = False
        try:
            self.old = signal.signal(signal.SIGINT, self._handler)
        except ValueError:  # not the main thread
            self.old = None
        return self

    def _handler(self, *_):
        if not self.hit:
            log("w", "Finishing this scene first, then stopping.")
        self.hit = True

    def __exit__(self, *exc):
        if self.old is not None:
            signal.signal(signal.SIGINT, self.old)
        return False


CLI_SETTINGS = [
    # (flag, setting key, help)
    ("--video-codec", "videoCodec", "ffmpeg video encoder, e.g. libsvtav1, libx265, hevc_nvenc, av1_qsv"),
    ("--video-args", "videoArgs", "video encoder options, e.g. --video-args=\"-crf 28 -preset 4\""),
    ("--audio-codec", "audioCodec", "ffmpeg audio encoder, or copy"),
    ("--audio-args", "audioArgs", "audio encoder options"),
    ("--container", "container", "extension of the new file: mp4, mkv, webm, ..."),
    ("--input-args", "inputArgs", "options placed before -i, e.g. --input-args=\"-hwaccel cuda\""),
    ("--extra-args", "extraArgs", "options added after the codec options"),
    ("--output-args", "outputArgs", "replace all generated output options with these"),
]


def cli_parser():
    p = argparse.ArgumentParser(
        prog="reencode.py",
        description=(
            "Re-encode every Stash scene with a tag on this machine, then swap the new file "
            "in the way the Reencode button does. Encoder settings come from the Reencode "
            "plugin's settings in Stash, if it is installed; the options below override them."
        ),
        epilog=(
            "Stash reports file paths as its own machine sees them. Use --map to say where "
            "they are on this machine, e.g. --map /data=//nas/media or --map /data=Z:\\ "
            "(repeat for each library folder). Options whose value starts with - need the "
            "--option=value form."
        ),
    )
    p.add_argument("--stash", required=True, metavar="URL", help="Stash's address, e.g. http://nas:9999")
    p.add_argument(
        "--api-key",
        default=os.environ.get("STASH_API_KEY"),
        help="API key from Stash's Settings > Security, if it has a password (default: $STASH_API_KEY)",
    )
    p.add_argument("--tag", required=True, help="re-encode the scenes with this tag; it is removed from each one that finishes")
    p.add_argument("--map", action="append", default=[], metavar="STASH_PATH=LOCAL_PATH", help="where a Stash folder is on this machine")
    p.add_argument("--ffmpeg", help="ffmpeg to use (default: ffmpeg on the PATH)")
    p.add_argument("--limit", type=int, metavar="N", help="stop after N scenes")
    p.add_argument("--dry-run", action="store_true", help="list what would be done and check the files can be found")
    p.add_argument(
        "--backup",
        action="store_true",
        help="move originals to the backup folder instead of deleting them (the folder comes from "
             "--backup-dir or the plugin's settings)",
    )
    p.add_argument("--backup-dir", metavar="DIR", help="back up originals to this folder on this machine (implies --backup)")
    p.add_argument("--no-generate", action="store_true", help="don't queue preview/sprite/phash generation in Stash")
    p.add_argument("--insecure", action="store_true", help="don't verify Stash's HTTPS certificate")
    p.add_argument("-v", "--verbose", action="store_true", help="also show debug messages, such as the ffmpeg command")
    for flag, _, help_text in CLI_SETTINGS:
        p.add_argument(flag, help=help_text)
    return p


def cli_main(argv):
    global CLI, VERBOSE
    CLI = True
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # paths a Windows console can't show
        except AttributeError:
            pass

    opts = cli_parser().parse_args(argv)
    VERBOSE = opts.verbose
    try:
        return run_cli(opts)
    except PluginError as e:
        log("e", e)
        return 2
    except KeyboardInterrupt:
        log("w", "Stopped.")
        return 130


def run_cli(opts):
    headers = {"ApiKey": opts.api_key} if opts.api_key else {}
    url = opts.stash if "://" in opts.stash else "http://" + opts.stash
    stash = Stash(url, headers, verify=not opts.insecure)
    paths = PathMap.parse(opts.map)

    try:
        settings = stash.settings()
    except PluginError as e:
        if "can't reach" in str(e) or "refused" in str(e):
            raise
        log("d", "no Reencode plugin settings: %s" % e)
        settings = {}
    for flag, key, _ in CLI_SETTINGS:
        value = getattr(opts, flag[2:].replace("-", "_"))
        if value is not None:
            settings[key] = value
    if opts.backup or opts.backup_dir:
        settings["backupOriginals"] = True
    if opts.backup_dir:
        settings["backupDirLocal"] = opts.backup_dir
    if opts.no_generate:
        settings["skipGenerate"] = True

    backup = backup_dir(settings, paths, create=not opts.dry_run)
    if backup:
        log("i", "Originals will be moved to %s" % backup)
    else:
        log("i", "Originals will be deleted once the new file is in place (use --backup to keep them)")

    tag_id = stash.find_tag(opts.tag)
    if not tag_id:
        raise PluginError("Stash has no tag named %s" % opts.tag)
    scenes = stash.scenes_with_tag(tag_id)
    if opts.limit is not None:
        scenes = scenes[: max(opts.limit, 0)]
    log("i", "%d scene(s) tagged %s" % (len(scenes), opts.tag))
    if not scenes:
        return 0

    if opts.dry_run:
        return dry_run(scenes, settings, paths, backup)

    ffmpeg = find_tool("ffmpeg", opts.ffmpeg)
    if not ffmpeg:
        raise PluginError("ffmpeg not found; put it on the PATH or pass --ffmpeg")
    tools = Tools(ffmpeg, find_ffprobe(ffmpeg))
    if not tools.ffprobe:
        log("w", "ffprobe not found next to ffmpeg or on the PATH; new files won't be checked")
    log("i", "Encoding with %s, .%s" % (
        "custom output options" if (settings.get("outputArgs") or "").strip() else video_encoder(settings, tools.encoders),
        container(settings),
    ))

    done = failed = 0
    for i, scene in enumerate(scenes, 1):
        log("i", "")
        log("i", "[%d/%d] scene %s: %s" % (
            i, len(scenes), scene["id"], scene["title"] or (scene["files"][0]["basename"] if scene["files"] else "")))
        try:
            stop = cli_scene(stash, scene, tag_id, settings, tools, paths, backup)
            done += 1
        except PluginError as e:
            log("e", e)
            failed += 1
            continue
        if stop:
            break

    log("i", "")
    log("i", "%d re-encoded, %d failed, %d not started" % (done, failed, len(scenes) - done - failed))
    return 1 if failed else 0


def cli_scene(stash, scene, trigger_tag_id, settings, tools, paths, backup):
    """Re-encodes one scene. Returns True if the user asked to stop."""
    original = check_scene(scene)
    new_path = encode_file(stash, original, settings, tools, paths)
    with DeferInterrupt() as deferred:
        log("i", "Scanning %s in Stash" % new_path)
        stash.wait_for_job(scan(stash, new_path), what="scan")
        swap(stash, scene["id"], new_path, original["id"], original["basename"], settings, paths, backup)
        stash.remove_tag(scene["id"], trigger_tag_id)
    return deferred.hit


def dry_run(scenes, settings, paths, backup):
    ext = container(settings)
    missing = 0
    for scene in scenes:
        try:
            original = check_scene(scene)
            local = paths.to_local(original["path"])
        except PluginError as e:
            log("e", "scene %s: %s" % (scene["id"], e))
            missing += 1
            continue
        if not os.path.isfile(local):
            log("e", "scene %s: %s not found on this machine" % (scene["id"], local))
            missing += 1
            continue
        target, _ = pick_names(local, ext)
        log("i", "scene %s: %s (%s, %s)" % (
            scene["id"], local, original.get("video_codec") or "?", human_size(original.get("size") or 0)))
        log("i", "    new file: %s" % target)
        log("i", "    original: %s" % (
            "moved to " + os.path.join(backup, original["basename"]) if backup else "deleted"))
    if missing:
        log("e", "%d scene(s) can't be re-encoded from here" % missing)
    return 1 if missing else 0


def main():
    if len(sys.argv) > 1:
        sys.exit(cli_main(sys.argv[1:]))
    if sys.stdin.isatty():
        cli_parser().print_help()
        sys.exit(2)
    plugin_main()


if __name__ == "__main__":
    main()
