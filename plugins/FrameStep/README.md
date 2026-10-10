# Frame Step

A Stash UI plugin that adds frame-by-frame stepping to the scene player.

- **Shift+,** / **Shift+.** step one frame back / forward (hold to keep stepping). Stepping pauses playback.
- Previous / next frame buttons next to play/pause in the control bar.
- A frame counter (`F 1234`) after the duration; hover it to see the frame rate in use.

## Install

Add this repository as a plugin source (see the [repository README](../../README.md#install)), then install **Frame Step** from **Settings → Plugins → Available Plugins**. Refresh the browser tab afterwards.

## Settings

| Setting | Effect |
|---|---|
| Use , and . without Shift | Step with plain `,` and `.`, as in YouTube and mpv. This replaces Stash's own `,` (collapse details) and `.` (toggle scrubber) shortcuts on the scene page. |
| Hide control bar buttons | Keyboard only. |
| Hide frame counter | |
| Frame rate override | Use this frame rate instead of the one Stash detected for the file. 0 = use the file's rate. |

Settings are read when a player is created, so reload the page after changing them.

## How it works

The plugin reads the file's `frame_rate` from the `ScenePlayer` props through `PluginApi.patch.before`. It then finds the video.js instance through `#VideoJsPlayer` and uses `requestVideoFrameCallback` to get the exact timestamp of the frame on screen. Each step seeks to the middle of the target frame, so rounding can't land on a neighboring frame.

## Limitations

- Frame accuracy depends on the stream. Direct play is exact. With transcoded HLS/DASH streams, seeks snap to whatever the transcoder produces, so steps can be uneven.
- Variable frame rate files are stepped on a fixed grid at the average frame rate Stash reports.
- The keys are physical key positions (`Comma` / `Period`), so on non-QWERTY layouts they are the keys in those positions.
