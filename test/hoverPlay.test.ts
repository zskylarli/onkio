import { describe, expect, it } from "vitest";
import {
  FILE_DWELL_MS,
  PREVIEW_DWELL_MS,
  decideHoverPlayback,
  playbackTransition,
  type AudioStatus,
  type HoverTarget,
} from "../src/views/hoverPlay";

const silent: AudioStatus = { pid: null, playing: false, origin: null };
const hoverPlaying = (pid: string): AudioStatus => ({ pid, playing: true, origin: "hover" });
const hoverPaused = (pid: string): AudioStatus => ({ pid, playing: false, origin: "hover" });
const clickPlaying = (pid: string): AudioStatus => ({ pid, playing: true, origin: "click" });

const withPreview = (pid: string): HoverTarget => ({ pid, playable: true, local: false });
const withFile = (pid: string): HoverTarget => ({ pid, playable: true, local: true });
const noAudio = (pid: string): HoverTarget => ({ pid, playable: false, local: false });

describe("decideHoverPlayback with browsing off", () => {
  it("never plays on hover, however long the pointer rests", () => {
    expect(decideHoverPlayback(withPreview("a"), silent, false)).toEqual({ kind: "none" });
    expect(decideHoverPlayback(withFile("a"), silent, false)).toEqual({ kind: "none" });
  });

  it("leaves audio a click started alone while the pointer moves over the map", () => {
    // Off is the default, so the Play button is the only way audio happens, and
    // moving the pointer afterwards must not silence it.
    expect(decideHoverPlayback(null, clickPlaying("a"), false)).toEqual({ kind: "none" });
    expect(decideHoverPlayback(withPreview("b"), clickPlaying("a"), false)).toEqual({
      kind: "none",
    });
    expect(decideHoverPlayback(noAudio("c"), clickPlaying("a"), false)).toEqual({
      kind: "none",
    });
  });

  it("silences hover audio still running from before the mode was switched off", () => {
    expect(decideHoverPlayback(withPreview("a"), hoverPlaying("a"), false)).toEqual({
      kind: "stop",
    });
  });
});

describe("decideHoverPlayback with browsing on", () => {
  it("plays the dot the pointer rests on, after a dwell", () => {
    expect(decideHoverPlayback(withPreview("a"), silent, true)).toEqual({
      kind: "start",
      pid: "a",
      delayMs: PREVIEW_DWELL_MS,
    });
  });

  it("waits longer for a local file than for a preview", () => {
    // A file read and decode cannot be abandoned once it has started.
    expect(FILE_DWELL_MS).toBeGreaterThan(PREVIEW_DWELL_MS);
    expect(decideHoverPlayback(withFile("a"), silent, true)).toEqual({
      kind: "start",
      pid: "a",
      delayMs: FILE_DWELL_MS,
    });
  });

  it("does not restart the dot that is already playing", () => {
    // The most noticeable flaw in hover preview: a pointer twitch inside a dot
    // chopping the audio back to zero.
    expect(decideHoverPlayback(withPreview("a"), hoverPlaying("a"), true)).toEqual({
      kind: "keep",
    });
    expect(decideHoverPlayback(withPreview("a"), clickPlaying("a"), true)).toEqual({
      kind: "keep",
    });
  });

  it("picks a dot up again after the pointer left it and came back", () => {
    expect(decideHoverPlayback(withPreview("a"), hoverPaused("a"), true)).toEqual({
      kind: "start",
      pid: "a",
      delayMs: PREVIEW_DWELL_MS,
    });
  });

  it("moves to a different dot rather than staying on the current one", () => {
    expect(decideHoverPlayback(withPreview("b"), hoverPlaying("a"), true)).toEqual({
      kind: "start",
      pid: "b",
      delayMs: PREVIEW_DWELL_MS,
    });
  });

  it("stops when the pointer leaves the dots", () => {
    expect(decideHoverPlayback(null, hoverPlaying("a"), true)).toEqual({ kind: "stop" });
  });

  it("stops on a dot that has no audio instead of carrying the last one over", () => {
    // Otherwise the sound belongs to whichever dot was hovered several dots ago.
    expect(decideHoverPlayback(noAudio("b"), hoverPlaying("a"), true)).toEqual({
      kind: "stop",
    });
  });

  it("still refuses to interrupt click-started audio when the pointer leaves", () => {
    expect(decideHoverPlayback(null, clickPlaying("a"), true)).toEqual({ kind: "none" });
    expect(decideHoverPlayback(noAudio("b"), clickPlaying("a"), true)).toEqual({
      kind: "none",
    });
  });

  it("does nothing when there is nothing playing and nothing to play", () => {
    expect(decideHoverPlayback(null, silent, true)).toEqual({ kind: "none" });
    expect(decideHoverPlayback(noAudio("a"), silent, true)).toEqual({ kind: "none" });
  });

  it("does not ask to stop audio that has already stopped", () => {
    expect(decideHoverPlayback(null, hoverPaused("a"), true)).toEqual({ kind: "none" });
  });
});

describe("playbackTransition", () => {
  it("resumes when the element already holds exactly this audio", () => {
    expect(playbackTransition("blob:abc", "blob:abc")).toBe("resume");
  });

  it("loads when the source differs", () => {
    expect(playbackTransition("blob:abc", "blob:def")).toBe("load");
  });

  it("loads when nothing has been loaded yet", () => {
    expect(playbackTransition(null, "blob:abc")).toBe("load");
  });

  it("loads when a track's source changed from a preview to a local file", () => {
    // Connecting a folder mid-session upgrades a track, and keying on the URL
    // rather than the track is what notices.
    expect(playbackTransition("https://cdn.test/preview.m4a", "blob:abc")).toBe("load");
  });
});
