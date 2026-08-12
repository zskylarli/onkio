/**
 * Hover playback policy for Browsing mode (§6).
 *
 * Deliberately separate from the audio element, because every decision here has
 * a wrong answer that is only detectable by ear, which is the worst place to
 * find one: whether a hover should play at all, how long the pointer has to rest
 * first, and whether a play request would interrupt audio that is already the
 * right audio.
 *
 * The rule that shapes the rest: hover audio is transient and pointer movement
 * owns it, while audio a click started is deliberate and pointer movement must
 * leave it alone. Without that split, moving the pointer anywhere over the map
 * would silence the track whose Play button was just pressed.
 */

export type HoverTarget = {
  pid: string;
  /** a preview URL or a resolved local file exists */
  playable: boolean;
  /** resolved to a file on disk rather than to a 30s preview */
  local: boolean;
};

export type PlayOrigin = "hover" | "click";

export type AudioStatus = {
  /** pid the element is loaded with, null when nothing has been loaded yet */
  pid: string | null;
  playing: boolean;
  origin: PlayOrigin | null;
};

export type HoverAction =
  /** leave the audio exactly as it is */
  | { kind: "none" }
  /** silence hover audio; anything a click started is left alone */
  | { kind: "stop" }
  /** this dot is already playing, so do not touch it */
  | { kind: "keep" }
  | { kind: "start"; pid: string; delayMs: number };

/**
 * How long the pointer has to rest before a hover plays. The dwell is also the
 * only throttle on a sweep across a dense region, since every pointer move
 * cancels a dwell that has not fired.
 *
 * A local file waits longer than a preview: a preview is a streamed request that
 * costs nothing to abandon, whereas a file is read and decoded whole, and once
 * that has started it cannot be taken back.
 */
export const PREVIEW_DWELL_MS = 350;
export const FILE_DWELL_MS = 550;

export function decideHoverPlayback(
  target: HoverTarget | null,
  status: AudioStatus,
  browsing: boolean
): HoverAction {
  const releaseHoverAudio: HoverAction =
    status.origin === "hover" && status.playing ? { kind: "stop" } : { kind: "none" };

  if (!browsing) return releaseHoverAudio;
  // Nothing under the pointer, or nothing to hear from what is.
  if (!target?.playable) return releaseHoverAudio;
  if (status.pid === target.pid && status.playing) return { kind: "keep" };
  return {
    kind: "start",
    pid: target.pid,
    delayMs: target.local ? FILE_DWELL_MS : PREVIEW_DWELL_MS,
  };
}

/**
 * Whether a play request can resume what is loaded or has to load it afresh.
 * Assigning `src` restarts from zero even when the value has not changed, so
 * this is what stops a pointer twitch chopping hover audio back to the start,
 * and what lets a dot left and re-entered carry on where it paused.
 */
export function playbackTransition(
  loadedUrl: string | null,
  wantUrl: string
): "resume" | "load" {
  return loadedUrl !== null && loadedUrl === wantUrl ? "resume" : "load";
}
