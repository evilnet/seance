/**
 * When the push mute list (pushMute.ts) is read, in a module of its own:
 * pushMute.ts and presence.ts import each other, and presence.ts computes
 * its fallback from this as it loads, which threw whenever pushMute.ts was
 * the first of the two to be imported. This module imports nothing.
 */

/** SUB/GET wait this long after registration: the connect burst is over by then. */
export const MUTE_READ_DELAY_MS = 10_000;
