# Playback Loops

A Stash UI plugin that replaces the scene player's looping.

## Using it

When the player's controls are showing, a second line sits above the seek bar: the loop line. It is the same length and thickness as the seek bar, drawn in the seek bar's inverted colours, with time graduations along it.

- **Click the loop line** to set a mark. With two marks set, the video loops between them. Hover the line to see the time and frame under the pointer.
- **Drag a mark** sideways to move it. It stops one frame short of the other mark. While the video is paused, dragging shows the frame the mark lands on.
- **Remove a mark** by dragging it off the line (up or down) and letting go, by right-clicking it, or by clicking it and pressing **Delete** or **Backspace**. **Esc** drops the selection.
- Play, pause, seeking and the other player controls work as usual during a loop. The loop only jumps back when playback runs from inside the loop over its end mark, so you can seek out of the loop and keep watching.

The control bar gets three buttons:

| Button | Effect |
|---|---|
| Loop once | Plays the loop from the start mark and pauses at the end mark. Press play there to go again. |
| Loop forever | Loops until you switch it off (press it again). Setting the second mark turns this on. |
| Cut loop | Saves the loop as a scene marker (see below). |

Keys: **l** sets a mark at the current time (a third press clears both marks), **Shift+L** toggles loop forever.

### Cut markers

Cut loop creates a marker on the scene with:

- **Start / end time:** the start and end marks.
- **Title:** the start and end as frame numbers, e.g. `F1200-F1530`.
- **Primary tag:** `{CUT}`, created if it doesn't exist yet.
- **Tags:** the scene's own tags.

The end mark is the frame the loop jumps back on, so it isn't played as part of the loop; the marker's end time is that same point.

Marker end times need Stash 0.28 or later.

## Install

Add this repository as a plugin source (see the [repository README](../../README.md#install)), then install **Playback Loops** from **Settings → Plugins → Available Plugins**. Refresh the browser tab afterwards.

## What it replaces

This plugin takes over all of the player's looping:

- Stash's A/B loop is switched off: the **l** key now sets loop marks, and the A/B loop buttons (**Settings → Interface → Show A/B loop controls**) are hidden.
- **Shift+L** toggles this plugin's loop instead of video.js's whole-video loop.
- Stash's automatic looping of short videos (**Maximum loop duration**) still applies while no marked loop is running, and is suspended while one is.
- When the end mark is at the very end of the video, reaching the end loops instead of moving on to the next scene in the queue.

It is not compatible with other plugins that replace the same controls (other A/B loop or looping plugins, or ones that rebind **l** / **Shift+L**). Use one or the other.

## Limitations

- Loops are frame-snapped using the frame rate Stash detected for the file (30 fps if unknown). Browsers can't loop to the exact frame, so the jump can land a frame early or late, more so with transcoded streams.
- Marks are kept per scene for as long as the scene is open; they are cleared when another scene loads. Cut a loop to keep it.
