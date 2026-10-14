# Changelog

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
