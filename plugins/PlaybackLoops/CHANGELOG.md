# Changelog

## 0.1.1

- Switching between loop once and loop forever no longer jumps back to the start of the loop when the playhead is already inside it. Pressing the active loop button switches looping off.
- A cut now shows up in the scene's markers pane and on the seek bar straight away, without a page reload.
- Each loop jump is logged to the browser console (debug level) to help track down looping problems.

## 0.1.0

- Initial release: loop line above the seek bar with draggable start / end marks, loop once / loop forever, and cut loop to a `{CUT}` marker.
- Replaces Stash's A/B loop (`l` and its buttons) and loop toggle (Shift+L).
