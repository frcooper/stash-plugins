# Changelog

## 0.1.3

- The loop line now sits above the bars Stash draws for markers with an end time (such as cuts), instead of on top of them. A cut no longer looks like a loop region that stays after the marks are cleared.

## 0.1.2

- Pressing the loop once or loop forever button that's already on does nothing.
- New clear loop button: removes both marks and plays on normally from where the video is.
- Cut loop does nothing (beyond a short notice) when the scene already has a marker over the same frames.
- Shift+L switches looping off and back on, keeping the marks.
- If playback ends up at the start of the video right after a loop jump, the plugin seeks back to the loop once and logs a warning to the browser console.

## 0.1.1

- Switching between loop once and loop forever no longer jumps back to the start of the loop when the playhead is already inside it. Pressing the active loop button switches looping off.
- A cut now shows up in the scene's markers pane and on the seek bar straight away, without a page reload.
- Each loop jump is logged to the browser console (debug level) to help track down looping problems.

## 0.1.0

- Initial release: loop line above the seek bar with draggable start / end marks, loop once / loop forever, and cut loop to a `{CUT}` marker.
- Replaces Stash's A/B loop (`l` and its buttons) and loop toggle (Shift+L).
