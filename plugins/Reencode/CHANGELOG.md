# Changelog

## 0.4.0

- The default `libsvtav1` options favour quality and file size over speed: `-crf 28 -preset 4 -pix_fmt yuv420p10le -g 240 -svtav1-params tune=0:enable-variance-boost=1` (was `-crf 30 -preset 6 -pix_fmt yuv420p10le`). Encodes take about twice as long. Set **Video encoder options** to the old value to keep the old speed.
- The default `hevc_nvenc` options use NVENC's slowest preset, two-pass analysis, lookahead, adaptive quantisation, B-frames as references and 10-bit output: `-preset p7 -tune hq -rc vbr -cq 24 -b:v 0 -multipass fullres -rc-lookahead 32 -spatial-aq 1 -temporal-aq 1 -bf 4 -b_ref_mode middle -pix_fmt p010le -profile:v main10`. They need a 20-series card or newer.
- The settings and README note that `av1_nvenc` needs an NVIDIA 40-series card or newer.

## 0.3.0

- **Originals are now deleted by default** once the new file is in place and Stash confirms the scene uses it. Deletion goes through Stash, so Stash's trash folder is used if you've set one.
- New settings **Back up originals** and **Backup folder**: when on, originals are moved to the backup folder under their own name and Stash forgets them. The command-line equivalents are `--backup` and `--backup-dir`.
- Removed the `{ORIGINAL}` tag, the separate scenes for originals, and the hiding of those scenes, along with the **Original tag**, **Don't tag the original** and **Show originals in scene lists** settings. Scenes already tagged `{ORIGINAL}` by earlier versions now show in scene lists again. Filter by the tag to delete or keep them.
- The button now only shows "Reencode", or the percentage done while a re-encode runs. How the last run ended is in its tooltip.
- The button stays the same width in both states, and is never wider than the "Scrape with…" button.
- The button copies its font from the Save and Delete buttons, and uses Stash's own warning (orange) button style.

## 0.2.0

- Fixed the swap failing with "cannot reassign primary file": the scene Stash makes when it scans the new file is now merged into the original scene.
- `reencode.py` can run from the command line on another Windows, Linux or macOS machine. It re-encodes every scene with a given tag, mapping Stash's paths to a local share with `--map`, and has `--dry-run` and `--limit`.

## 0.1.0

- Initial release: Reencode button on the scene edit panel, ffmpeg re-encode with configurable encoders and options (default AV1 in MP4), new file swapped in as the scene's file.
- Originals move to their own scene tagged {ORIGINAL}, hidden from scene lists unless filtered by the tag.
