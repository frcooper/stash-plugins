# Reencode

A Stash plugin that re-encodes a scene's file with ffmpeg and swaps the new file in, so the scene looks like it had the new file all along.

- An orange **Reencode** button on the scene's **Edit** tab, between Delete and the scrape buttons. While the job runs, it shows the progress.
- The new file is written next to the original and becomes the scene's file. Everything else stays on the scene as it is: title, performers, tags, markers, play and O history, groups, galleries, stash IDs, cover.
- The original file moves to its own scene tagged `{ORIGINAL}`. Scenes with that tag are hidden from every scene list, and only show up when you filter by the tag (e.g. open the tag's page).

By default the new file is AV1 (SVT-AV1, CRF 30, 10-bit) in MP4. If the audio is AAC, MP3 or Opus it is copied; otherwise it is encoded to AAC. If your ffmpeg has no SVT-AV1, it uses x265 (HEVC) instead. Both play directly in current browsers, but HEVC needs hardware support.

## Requirements

- Stash with Python set up for plugins (**Settings → System → Python path**, or `python` on the PATH). The Docker image includes it.
- ffmpeg with the encoder you want. The plugin uses the ffmpeg Stash uses unless you set a path.

## Install

Add this repository as a plugin source (see the [repository README](../../README.md#install)), then install **Reencode** from **Settings → Plugins → Available Plugins**. Refresh the browser tab afterwards.

## What happens when you click it

1. A confirmation shows the current file and what it will be encoded to.
2. **Encode job:** ffmpeg writes `<name>.<ext>.part` next to the original. Stash doesn't scan `.part` files. When ffmpeg finishes, the plugin checks the new file's length matches the original, then renames it:
   - Different container (e.g. `.mkv` → `.mp4`): the new file is `<name>.mp4`.
   - Same container: the original is renamed to `<name>.original.mp4` through Stash, and the new file takes the original name. That way funscripts and captions that match by name keep working.
3. **Scan job:** Stash scans the new file.
4. **Finalize job:** the new file is moved onto the scene and made its primary file. The scene the scan made for it is deleted. The original file goes into a new scene titled like the original, marked organized, and tagged `{ORIGINAL}`. Sprites, previews, marker previews and the phash are then generated for the scene's new file.

The jobs show in Stash's job queue and can be cancelled there. Cancelling the encode also stops ffmpeg on Linux and Windows. The `.part` file is left behind; the next re-encode of that scene overwrites it.

Nothing is deleted. To get rid of originals, filter scenes by `{ORIGINAL}` and delete them with **Delete file** ticked.

## Settings

| Setting | Effect |
|---|---|
| Video encoder | Any ffmpeg encoder (`libsvtav1`, `libx265`, `hevc_nvenc`, `av1_qsv`, `copy`, …). Blank: `libsvtav1`, falling back to `libx265`. |
| Video encoder options | Blank uses defaults for known encoders, e.g. `-crf 30 -preset 6 -pix_fmt yuv420p10le` for `libsvtav1`, `-crf 24 -preset medium -pix_fmt yuv420p10le` for `libx265`. |
| Audio encoder | Any ffmpeg encoder, or `copy`. Blank: copy if browsers can play it, otherwise `aac` (`libopus` for webm). |
| Audio encoder options | Blank: `-b:a 192k` when encoding. |
| Container | Extension of the new file: `mp4`, `mkv`, `webm`, … Blank: `mp4`. MKV keeps subtitles and attachments; MP4 and WebM drop subtitles. |
| Input options | Placed before `-i`, e.g. `-hwaccel cuda`. |
| Extra output options | Added after the codec options, e.g. `-vf scale=-2:1080`. |
| Replace all output options | Your own output arguments in place of the generated stream mapping and codec options. The plugin still adds the output format, progress reporting and file name. |
| ffmpeg path | Blank: the ffmpeg Stash is configured with, then `ffmpeg` on the PATH, then the copy in Stash's config folder. |
| Original tag | Blank: `{ORIGINAL}`. Created on first use, with auto-tagging turned off. |
| Don't tag the original | Leave the original on the scene as a secondary file instead of splitting it off. |
| Show originals in scene lists | Turn off the hiding. |
| Don't generate for the new file | Skip queueing sprite, preview, marker and phash generation after the swap. |

Options are split like a shell command line, so quote values with spaces.

The button and the hiding read the settings when the page loads, so reload the page after changing them. The encode reads them when the job starts.

## How the hiding works

The UI adds an Apollo link in front of Stash's GraphQL client. Every query with a `$scene_filter` variable gets `tags excludes {ORIGINAL}` added to it, unless the filter already mentions the tag (included or excluded). This covers the scenes page, the scene tabs on performers, studios, tags and groups, the play queue and scene pickers. Queries for specific scene IDs are left alone.

The hiding happens only in the browser. Scene counts, the API and other clients still see the originals.

## Limitations

- The first file on the scene is re-encoded. Other files on the scene stay as they are.
- The encode runs in Stash's job queue, so other jobs wait until it finishes.
- Cancelling on macOS leaves ffmpeg running until it finishes.
- The new file needs as much free space as it takes up, in the original's folder.
