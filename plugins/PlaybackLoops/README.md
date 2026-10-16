# Playback Loops

A Stash UI plugin that replaces the scene player's looping.

## Using it

When the player's controls are showing, a second line sits above the seek bar: the loop line. It is the same length and thickness as the seek bar, drawn in the seek bar's inverted colours, with time graduations along it. For a direct-streamed MP4 or MOV file, small amber triangles on the line show where the keyframes are.

- **Click the loop line** to set a mark. With two marks set, the video loops between them. Hover the line to see the time and frame under the pointer.
- **Drag a mark** sideways to move it. It stops one frame short of the other mark. While the video is paused, dragging shows the frame the mark lands on.
- **Hold Shift** while setting or dragging the start mark (or a lone mark) to snap it to the nearest keyframe. A loop that starts on a keyframe jumps back without a pause (see Limitations). Shift-clicking a start mark snaps it where it is. The end mark always stays frame-accurate. A mark on a keyframe says so in its tooltip.
- **Remove a mark** by dragging it off the line (up or down) and letting go, by right-clicking it, or by clicking it and pressing **Delete** or **Backspace**. **Esc** drops the selection.
- **Click a marker bar** to loop that marker. Stash draws markers that have an end time (cuts among them) as bars; this plugin moves them below the seek bar. Clicking one replaces the marks with the marker's start and end and plays the loop from its start, in the loop mode that's on (loop forever if neither is).
- Play, pause, seeking and the other player controls work as usual during a loop. The loop only jumps back when playback runs from inside the loop over its end mark, so you can seek out of the loop and keep watching.

The control bar gets three buttons:

| Button | Effect |
|---|---|
| Loop once | Plays to the end mark and pauses there; press play to go again. |
| Loop forever | Loops until you switch it off. Setting the second mark turns this on. |
| Cut loop | Saves the loop as a scene marker (see below). |
| Clear loop | Removes both marks. Playback carries on normally from where it is. |

Switching to loop once or loop forever keeps the playhead where it is if it's inside the loop, and goes to the start mark if it isn't. Pressing the mode that's already on does nothing.

Keys: **l** sets a mark at the current time (a third press clears both marks), **Shift+L** switches looping off and back on without removing the marks.

### Cut markers

Cut loop creates a marker on the scene with:

- **Start / end time:** the start and end marks.
- **Title:** the start and end as frame numbers, e.g. `F1200-F1530`.
- **Primary tag:** `{CUT}`, created if it doesn't exist yet.
- **Tags:** the scene's own tags.

If the scene already has a marker over the same frames, cut does nothing.

The end mark is the frame the loop jumps back on, so it isn't played as part of the loop; the marker's end time is that same point.

Marker end times need Stash 0.28 or later.

## Install

Add this repository as a plugin source (see the [repository README](../../README.md#install)), then install **Playback Loops** from **Settings → Plugins → Available Plugins**. Refresh the browser tab afterwards.

## What it replaces

This plugin takes over all of the player's looping:

- Stash's A/B loop is switched off: the **l** key now sets loop marks, and the A/B loop buttons (**Settings → Interface → Show A/B loop controls**) are hidden.
- **Shift+L** switches this plugin's loop off and on instead of toggling video.js's whole-video loop.
- Stash's automatic looping of short videos (**Maximum loop duration**) still applies while no marked loop is running, and is suspended while one is.
- When the end mark is at the very end of the video, reaching the end loops instead of moving on to the next scene in the queue.

It is not compatible with other plugins that replace the same controls (other A/B loop or looping plugins, or ones that rebind **l** / **Shift+L**). Use one or the other.

## Limitations

- Loops are frame-snapped using the frame rate Stash detected for the file (30 fps if unknown). Browsers can't loop to the exact frame, so the jump can land a frame early or late, more so with transcoded streams.
- **The jump back costs a seek.** A browser seek decodes from the keyframe before the target up to the target, so the further the start mark is past a keyframe, the longer the last frame of the loop stays on screen. Measured in Chrome with an 8.3 s keyframe interval and the start 7.7 s past a keyframe: about 80 ms at 360p, 320 ms at 1080p and 1.2 s at 2160p. With the start on a keyframe it's about 6 ms at any of those sizes, shorter than a frame. Snap the start to a keyframe (Shift) for a seamless loop; files with short keyframe intervals pause less wherever the start is.
- Keyframes are only shown, and Shift only snaps, for files Stash streams directly in an MP4 or MOV container, from a server that answers Range requests (Stash does). The plugin reads the file's index (its moov box) with a few small requests and doesn't download the video. MKV, WebM, transcoded, HLS and DASH streams get no keyframe ticks.
- The jump is made while the loop's last frame is showing, so the end mark's frame isn't shown, in browsers that support `requestVideoFrameCallback` (Chrome, Edge, Safari, Firefox 132+). Elsewhere, or with dropped frames, the end mark's frame can flash before the jump.
- Marks are kept per scene for as long as the scene is open; they are cleared when another scene loads. Cut a loop to keep it.
