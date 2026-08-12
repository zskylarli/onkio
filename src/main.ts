import type { CollectionMeta, Library, Track } from "./types";
import type { ParseWorkerMsg } from "./parse/parse.worker";
import type { RekordboxWorkerMsg } from "./parse/rekordbox.worker";
import type { EmbedRequest, EmbedResponse } from "./embed/embed.worker";
import { buildFeatureMatrix } from "./features/matrix";
import { Scatter, type ColorMode, type Theme } from "./render/scatter";
import { EnrichmentQueue } from "./enrich/queue";
import { DspPool, type AudioSource } from "./dsp/pool";
import { getSourceStats } from "./enrich/adapter";
import {
  setSongBpmApiKey,
  getSongBpmApiKey,
  setSongBpmProxy,
  getSongBpmProxy,
} from "./enrich/sources/getsongbpm";
import {
  saveLibrary,
  loadLibrary,
  getAllOverrides,
  putOverride,
  clearCachedMisses,
  saveMusicFolder,
  loadMusicFolder,
  clearMusicFolder,
} from "./store/db";
import {
  folderPermission,
  indexFolder,
  pickMusicFolder,
  readLocalFile,
  requestFolderPermission,
  supportsFolderAccess,
  type FolderIndex,
  type LocalDirectoryHandle,
  type LocalFileHandle,
  type MusicFolder,
} from "./local/folder";
import {
  buildFileIndex,
  describeResolution,
  resolveTracks,
  type FolderResolution,
} from "./local/match";
import {
  evaluateSet,
  suggestNext,
  toM3U8,
  toTextTracklist,
} from "./views/setBuilder";
import { summarizeClusters, tasteReport } from "./views/taste";
import {
  ensureCollections,
  mergeLibraries,
  removeCollection,
  slugifyCollectionId,
  tagCollection,
  uniqueCollectionId,
} from "./collections/merge";
import {
  collectionCoverage,
  describeOutstanding,
  describeSoundInfluence,
  needsLookup,
  type CollectionCoverage,
} from "./collections/coverage";
import { collectionColor } from "./render/palette";
import {
  findGaps,
  suggestQueries,
  type Gap,
  type GapSide,
  type Neighborhood,
} from "./views/gaps";
import { resolveHighlight, type HighlightRequest } from "./views/highlight";
import { searchTracks, type SearchResults } from "./views/search";
import {
  decideHoverPlayback,
  playbackTransition,
  type AudioStatus,
  type PlayOrigin,
} from "./views/hoverPlay";
import { camelotDisplay, toCamelot } from "./music/camelot";
import { dismissInfoPopups, initInfoTips, repositionInfoPopups } from "./views/infoTip";
import { resolvePreviewUrl } from "./enrich/preview";

// ---------- state ----------

let library: Library | null = null;
let coords: Float32Array | null = null;
let clusters: Int32Array | null = null;
let clusterLabels = new Map<number, string>();
let pidToIndex = new Map<string, number>();
let scatter: Scatter | null = null;
let queue: EnrichmentQueue | null = null;
let queueRunning = false;
let dspPool: DspPool | null = null;
const setList: Track[] = [];
let suggestionMode = false;
let gaps: Gap[] = [];
let gapsVisible = false;
let legendVisible = true;

/** the library as it was before the last import, so an import is reversible */
let previousLibrary: Library | null = null;
let lastImportSummary = "";

/**
 * The connected music folder, what walking it found, and which tracks it
 * resolved to. All of it is memory-only apart from the handle itself: see
 * collectionCoverage on why file availability is never written into the library.
 */
let musicFolder: MusicFolder | null = null;
let localIndex: FolderIndex | null = null;
let localResolution: FolderResolution | null = null;
let localByPid = new Map<string, LocalFileHandle>();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const previewAudio = new Audio();
previewAudio.volume = 0.6;
let hoverTimer: number | undefined;

/**
 * A load that never arrives reports through the element, not through `play()`,
 * which resolves happily and then falls silent. Without this an expired preview
 * URL was indistinguishable on screen from a healthy one.
 */
previewAudio.addEventListener("error", () => {
  if (loadedAudio) failPlayback(loadedAudio.pid);
});

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * A toolbar toggle's state, both ways it is read: the accent fill for the eye
 * and `aria-pressed` for a screen reader, which a colour change tells nothing.
 */
function setToggleState(id: string, on: boolean): void {
  const btn = $(id);
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
}

// ---------- theme ----------

const THEME_KEY = "onkio.theme";

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  $("theme-toggle").textContent = theme === "dark" ? "☀" : "☾";
  $("theme-toggle").title = theme === "dark" ? "Switch to light" : "Switch to dark";
  scatter?.setTheme(theme);
  renderLegend();
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

applyTheme(
  (localStorage.getItem(THEME_KEY) as Theme | null) ??
    (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")
);

$("theme-toggle").addEventListener("click", () => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
});

// ---------- collapsible panel ----------

const SIDEBAR_KEY = "onkio.sidebar";

function setSidebarCollapsed(collapsed: boolean): void {
  $("app").classList.toggle("sidebar-collapsed", collapsed);
  localStorage.setItem(SIDEBAR_KEY, collapsed ? "hidden" : "shown");
  $("sidebar-toggle").title = collapsed ? "Show panel  [" : "Hide panel  [";
  $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  // The canvas resizes itself, but anchored popovers must follow it.
  requestAnimationFrame(repositionPopovers);
}

setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "hidden");

$("sidebar-toggle").addEventListener("click", () => {
  setSidebarCollapsed(!$("app").classList.contains("sidebar-collapsed"));
});

document.addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement | null;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  if (e.key === "[") setSidebarCollapsed(!$("app").classList.contains("sidebar-collapsed"));
  // "=" is the unshifted key "+" lives on, so both spellings zoom in.
  if (e.key === "+" || e.key === "=") scatter?.zoomBy(1);
  if (e.key === "-" || e.key === "_") scatter?.zoomBy(-1);
  if (e.key === "Escape") {
    clearSearch();
    closeTrackPopover();
    closeGapPopover();
    dismissInfoPopups();
  }
});

// ---------- info tooltips ----------

initInfoTips();

// The ⓘ popups sit outside the panel to avoid being clipped by it, so the panel
// scrolling moves their trigger out from under them.
$("sidebar").addEventListener("scroll", repositionPopovers, { passive: true });

// ---------- import ----------

const fileInput = $<HTMLInputElement>("file-input");
const fileDrop = $("file-drop");
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) void importFiles([...fileInput.files]);
});
fileDrop.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileDrop.classList.add("dragover");
});
fileDrop.addEventListener("dragleave", () => fileDrop.classList.remove("dragover"));
fileDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  fileDrop.classList.remove("dragover");
  const files = e.dataTransfer?.files;
  if (files?.length) void importFiles([...files]);
});

/**
 * Several files dropped together are imported one after another, not in
 * parallel: each one is a union against the library the previous one produced,
 * and two workers racing to append to the same library would lose tracks.
 *
 * Only the first file honours the add/replace choice. A drop of three files
 * means "these three together", so files two and three always join the first
 * rather than each replacing it in turn.
 */
async function importFiles(files: File[]): Promise<void> {
  for (const [i, file] of files.entries()) {
    await importFile(file, i === 0 ? importMode() : "add");
  }
  // Re-importing the same path should re-fire `change`, which it won't if the
  // input still holds the old selection.
  fileInput.value = "";
}

/**
 * The two supported exports are both `.xml` and the user shouldn't have to
 * tell us which is which — rekordbox announces itself in the root element,
 * within the first few hundred bytes.
 */
async function detectFormat(file: File): Promise<"rekordbox" | "apple"> {
  const head = await file.slice(0, 4096).text();
  return head.includes("DJ_PLAYLISTS") ? "rekordbox" : "apple";
}

async function importFile(file: File, mode: "add" | "replace"): Promise<void> {
  const format = await detectFormat(file);
  const parsed =
    format === "rekordbox" ? await parseRekordboxFile(file) : await parseAppleFile(file);
  if (!parsed) return;
  await adoptImport(parsed.library, file.name, format, parsed.detail, mode);
}

function parseRekordboxFile(
  file: File
): Promise<{ library: Library; detail: string } | null> {
  const status = $("import-status");
  status.textContent = "Parsing rekordbox collection…";
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./parse/rekordbox.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<RekordboxWorkerMsg>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        status.textContent = `Parsing… ${msg.tracks.toLocaleString()} tracks`;
      } else if (msg.type === "error") {
        status.textContent = `Parse failed: ${msg.message}`;
        worker.terminate();
        resolve(null);
      } else if (msg.type === "done") {
        worker.terminate();
        const { stats, ...lib } = msg.collection;
        const pct = (n: number) => Math.round((n / (stats.parsed || 1)) * 100);
        resolve({
          library: lib,
          detail:
            `${stats.parsed.toLocaleString()} tracks, ${lib.playlists.length} playlists — ` +
            `${pct(stats.withBpm)}% BPM, ${pct(stats.withKey)}% key` +
            (stats.skipped ? ` (${stats.skipped} sampler one-shots skipped)` : ""),
        });
      }
    };
    worker.postMessage({ file });
  });
}

function parseAppleFile(file: File): Promise<{ library: Library; detail: string } | null> {
  const status = $("import-status");
  status.textContent = "Parsing…";
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./parse/parse.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<ParseWorkerMsg>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        status.textContent = `Parsing… ${msg.tracks.toLocaleString()} tracks`;
      } else if (msg.type === "error") {
        status.textContent = `Parse failed: ${msg.message}`;
        worker.terminate();
        resolve(null);
      } else if (msg.type === "done") {
        worker.terminate();
        resolve({
          library: msg.library,
          detail:
            `${msg.library.tracks.length.toLocaleString()} tracks, ${msg.library.playlists.length} playlists ` +
            `(${msg.library.droppedPlaylists.length} auto-playlists dropped) in ${(msg.elapsedMs / 1000).toFixed(1)}s`,
        });
      }
    };
    worker.postMessage({ file });
  });
}

function importMode(): "add" | "replace" {
  const el = document.querySelector<HTMLInputElement>('input[name="import-mode"]:checked');
  return el?.value === "replace" ? "replace" : "add";
}

/**
 * Replace the loaded library or union the new file into it. Which one it was
 * has to be unmissable afterwards — a user who drops a second export and
 * silently loses the first has no way to tell, so the status line says what
 * happened in words and the import stays undoable.
 */
async function adoptImport(
  incoming: Library,
  fileName: string,
  format: "rekordbox" | "apple",
  detail: string,
  mode: "add" | "replace"
): Promise<void> {
  const status = $("import-status");
  const adding = library !== null && mode === "add";
  const existing = adding ? library!.collections ?? [] : [];
  const meta: CollectionMeta = {
    id: uniqueCollectionId(existing, slugifyCollectionId(fileName)),
    label: fileName.replace(/\.[a-z0-9]+$/i, ""),
    format,
    trackCount: incoming.tracks.length,
    addedAt: new Date().toISOString(),
  };
  const tagged = tagCollection(incoming, meta);

  if (adding) {
    const { library: merged, report } = mergeLibraries(library!, tagged);
    if (report.redundant) {
      // Nothing was added, so nothing is re-laid out and there is nothing to
      // undo. Saying so is the whole response: the alternative is a rebuild
      // that ends where it started and a collection row with no tracks.
      lastImportSummary =
        report.duplicatePids > 0
          ? `${meta.label} is already loaded — all ${report.duplicatePids.toLocaleString()} of its tracks are here already, so nothing changed.`
          : `${meta.label} holds no tracks, so nothing changed.`;
      status.textContent = lastImportSummary;
      return;
    }
    previousLibrary = library;
    lastImportSummary =
      `Added ${report.added.toLocaleString()} tracks from ${meta.label} — ` +
      `${merged.tracks.length.toLocaleString()} tracks from ${merged.collections!.length} collections in one space.` +
      (report.duplicatePids
        ? ` ${report.duplicatePids.toLocaleString()} were already here and were not added again.`
        : "") +
      (report.renamedPlaylists.length
        ? ` ${report.renamedPlaylists.length} playlist name${report.renamedPlaylists.length === 1 ? "" : "s"} clashed and were suffixed with the collection.`
        : "");
    status.textContent = lastImportSummary;
    await onLibraryLoaded(merged);
    // Which file a dot came from stops being obvious the moment there are two,
    // so colour by collection once rather than leaving it to be discovered.
    setColorMode("collection");
  } else {
    previousLibrary = library;
    lastImportSummary = `Replaced the library — ${meta.label}: ${detail}`;
    status.textContent = lastImportSummary;
    await onLibraryLoaded(tagged);
  }
  renderCollections();
}

$("undo-import").addEventListener("click", async () => {
  if (previousLibrary === null) return;
  const restore = previousLibrary;
  previousLibrary = null;
  $("import-status").textContent = `Undone — back to ${restore.tracks.length.toLocaleString()} tracks.`;
  await onLibraryLoaded(restore);
  renderCollections();
});

async function onLibraryLoaded(input: Library): Promise<void> {
  const lib = ensureCollections(input);
  // Manual overrides survive re-import (§4 stage 3) — keyed on Persistent ID.
  const overrides = await getAllOverrides();
  for (const t of lib.tracks) {
    const o = overrides.get(t.pid);
    if (!o) continue;
    if (o.bpm) {
      t.bpm = o.bpm;
      t.confidence = { ...t.confidence, bpm: 1 };
      t.source = { ...t.source, bpm: "manual" };
      t.bpmSuspect = false;
    }
    if (o.key) {
      t.key = o.key;
      t.confidence = { ...t.confidence, key: 1 };
      t.source = { ...t.source, key: "manual" };
    }
  }
  library = lib;
  pidToIndex = new Map(lib.tracks.map((t, i) => [t.pid, i]));
  await saveLibrary(lib);

  scatter?.setCollections(lib.collections ?? []);
  renderCollections();

  const pf = $<HTMLSelectElement>("playlist-filter");
  pf.innerHTML = '<option value="">— none —</option>';
  for (const p of lib.playlists) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.name} (${p.pids.length})`;
    pf.appendChild(opt);
  }
  // Hits index into the track array that just went away.
  searchInput.value = "";
  runSearch();

  $("local-section").hidden = false;
  $("map-controls").hidden = false;
  $("sound-section").hidden = false;
  $("enrich-section").hidden = false;
  // A folder may already be connected from before this import, and the walk it
  // produced is still good: re-match rather than going back to the disk.
  matchLocalFiles();

  queue = new EnrichmentQueue(onTrackEnriched, (remaining) => {
    $("enrich-status").textContent = queueRunning
      ? `${remaining.toLocaleString()} tracks remaining`
      : "paused";
    if (remaining === 0) {
      renderCoverage();
      renderLegend();
      if (library) void saveLibrary(library);
    }
  });
  await queue.init(lib.tracks);
  $("enrich-status").textContent = `${queue.remaining.toLocaleString()} tracks queued`;

  runEmbedding();
}

// ---------- local music folder ----------

/**
 * What the folder control can currently say. One value rather than a handful of
 * booleans, so the readout and the button label cannot disagree about which
 * situation we are in — and every branch is a state the user can act on.
 */
type LocalState =
  | { kind: "unsupported" }
  | { kind: "none" }
  | { kind: "needs-permission"; name: string }
  | { kind: "indexing"; name: string; files: number }
  | { kind: "ready"; name: string }
  | { kind: "error"; message: string };

let localState: LocalState = { kind: "none" };

function setLocalState(next: LocalState): void {
  localState = next;
  renderLocalStatus();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderLocalStatus(): void {
  const pick = $<HTMLButtonElement>("local-pick");
  const status = $("local-status");
  pick.disabled = false;
  $("local-forget").hidden = musicFolder === null;

  switch (localState.kind) {
    case "unsupported":
      pick.disabled = true;
      pick.textContent = "Choose music folder";
      status.textContent =
        "Playing your own files needs a Chromium browser: Chrome, Edge, Brave, Arc or Opera. " +
        "Firefox and Safari cannot grant access to a folder, so tracks here play from a 30-second preview where one exists.";
      return;

    case "none":
      pick.textContent = "Choose music folder";
      status.textContent =
        "No folder chosen. Tracks play from a 30-second preview where one exists.";
      return;

    case "needs-permission":
      pick.textContent = "Reconnect this folder";
      status.innerHTML =
        `<strong>${esc(localState.name)}</strong> is remembered from last time. ` +
        "Reading it needs one more click: a browser deliberately drops folder permission on reload.";
      return;

    case "indexing":
      pick.disabled = true;
      pick.textContent = "Scanning…";
      status.innerHTML = `Scanning <strong>${esc(localState.name)}</strong> — ${localState.files.toLocaleString()} audio files so far.`;
      return;

    case "ready": {
      pick.textContent = "Choose a different folder";
      const files = localIndex?.paths.length ?? 0;
      status.innerHTML =
        `<strong>${esc(localState.name)}</strong>: ` +
        esc(
          localResolution
            ? describeResolution(localResolution, files)
            : `${files.toLocaleString()} audio files scanned. Import a collection to match them.`
        ) +
        (localIndex?.truncated
          ? ` Stopped at ${files.toLocaleString()} files; anything past that was not scanned.`
          : "");
      return;
    }

    case "error":
      pick.textContent = "Choose music folder";
      status.textContent = localState.message;
      return;
  }
}

$("local-pick").addEventListener("click", () => void connectMusicFolder());

$("local-forget").addEventListener("click", async () => {
  musicFolder = null;
  localIndex = null;
  clearLocalMatches();
  await clearMusicFolder().catch(() => {});
  setLocalState(supportsFolderAccess() ? { kind: "none" } : { kind: "unsupported" });
  renderCoverage();
});

/**
 * Re-authorizing a remembered folder and choosing a new one are the same
 * button, because from where the user stands both are "let this read my music".
 */
async function connectMusicFolder(): Promise<void> {
  if (localState.kind === "needs-permission" && musicFolder) {
    const granted = await requestFolderPermission(musicFolder.handle);
    if (granted !== "granted") {
      setLocalState({
        kind: "error",
        message: `Reading ${musicFolder.name} was not allowed, so previews stay the only audio. The folder can be granted again at any time.`,
      });
      return;
    }
    await indexMusicFolder();
    return;
  }

  let handle: LocalDirectoryHandle | null;
  try {
    handle = await pickMusicFolder();
  } catch (err) {
    setLocalState({ kind: "error", message: `Could not open the folder: ${errorText(err)}` });
    return;
  }
  if (!handle) return; // picker dismissed
  musicFolder = { handle, name: handle.name, connectedAt: new Date().toISOString() };
  await saveMusicFolder(musicFolder).catch(() => {});
  await indexMusicFolder();
}

/**
 * Walk the folder, then match. The two are separate because importing another
 * collection later has to re-match against the same walk rather than ask the
 * disk again, and because a folder can be connected before a library exists.
 */
async function indexMusicFolder(): Promise<void> {
  const folder = musicFolder;
  if (!folder) return;
  setLocalState({ kind: "indexing", name: folder.name, files: 0 });
  try {
    localIndex = await indexFolder(folder.handle, (files) => {
      if (localState.kind === "indexing") {
        setLocalState({ kind: "indexing", name: folder.name, files });
      }
    });
  } catch (err) {
    localIndex = null;
    clearLocalMatches();
    setLocalState({
      kind: "error",
      message:
        `${folder.name} could not be read (${errorText(err)}). ` +
        "It may have been moved, renamed or deleted since it was chosen.",
    });
    renderCoverage();
    return;
  }
  setLocalState({ kind: "ready", name: folder.name });
  matchLocalFiles();
}

/** Resolve the loaded library against the folder already walked. */
function matchLocalFiles(): void {
  if (!localIndex || !library) {
    clearLocalMatches();
  } else {
    const index = buildFileIndex(localIndex.paths);
    localResolution = resolveTracks(library.tracks, index);
    const next = new Map<string, LocalFileHandle>();
    for (const [pid, file] of localResolution.matched) {
      next.set(pid, localIndex.handles[file]);
    }
    localByPid = next;
    releaseLocalAudio();
  }
  renderLocalStatus();
  renderCoverage();
  if (popoverTrack) renderTrackPopover();
}

function clearLocalMatches(): void {
  localResolution = null;
  localByPid = new Map();
  releaseLocalAudio();
}

/**
 * A remembered folder comes back as a live handle with no permission attached,
 * so without a click the most that can be established is which of the two
 * situations we are in.
 */
async function restoreMusicFolder(): Promise<void> {
  if (!supportsFolderAccess()) {
    setLocalState({ kind: "unsupported" });
    return;
  }
  const saved = await loadMusicFolder().catch(() => undefined);
  if (!saved?.handle) {
    setLocalState({ kind: "none" });
    return;
  }
  musicFolder = saved;
  // Chromium sometimes still holds the grant, in which case nothing is asked.
  if ((await folderPermission(saved.handle)) === "granted") await indexMusicFolder();
  else setLocalState({ kind: "needs-permission", name: saved.name });
}

// ---------- audio ----------

/**
 * One local file is held as an object URL at a time. A blob URL pins the whole
 * file in memory until revoked, and a crate is thousands of files, so switching
 * tracks releases the previous one instead of accumulating them.
 */
let localAudio: { pid: string; url: string } | null = null;

/** What the element is loaded with, so a hover can resume rather than restart. */
let loadedAudio: { pid: string; url: string; origin: PlayOrigin } | null = null;

/** Two hovers in a row both await a file read; the later one has to win. */
let playRequest = 0;

/** pid under the pointer right now, so a dwell that outlives it can be dropped. */
let hoveredPid: string | null = null;

function releaseLocalAudio(): void {
  if (!localAudio) return;
  // Revoking a URL the element is still holding breaks it mid-track, and this
  // also runs on import and on re-matching a folder, so the element lets go
  // first rather than only when playback happens to be switching tracks.
  if (loadedAudio?.url === localAudio.url) {
    previewAudio.pause();
    previewAudio.removeAttribute("src");
    loadedAudio = null;
  }
  URL.revokeObjectURL(localAudio.url);
  localAudio = null;
}

function isPlayable(t: Track): boolean {
  // A stored preview URL counts even when it has expired: it is evidence a
  // preview exists, and a fresh one is obtainable from it (enrich/preview).
  return localByPid.has(t.pid) || !!t.previewUrl || t.deezerId !== undefined;
}

/**
 * Why a dot is or is not making sound. Audio fails for several ordinary reasons
 * that look identical from the outside, and a preview whose signed URL has
 * expired used to be indistinguishable from one that simply never existed.
 */
type PlaybackState = "loading" | "playing" | "no-preview" | "unavailable" | "blocked";

const PLAYBACK_TEXT: Record<PlaybackState, string> = {
  loading: "finding audio",
  playing: "playing",
  "no-preview": "no preview found",
  unavailable: "preview unavailable",
  blocked: "click once to allow audio",
};

let playback: { pid: string; state: PlaybackState } | null = null;

function setPlayback(pid: string, state: PlaybackState | null): void {
  if (state === null) {
    // Only this track's own state is its to clear; a sweep that abandons one dot
    // must not wipe the report belonging to the dot now playing.
    if (playback?.pid !== pid) return;
    playback = null;
  } else {
    playback = { pid, state };
  }
  renderPlayback();
}

/**
 * Push the current state at both places a track can be on screen. The tooltip is
 * rebuilt on pointer movement, but a hover that resolves audio is a hover held
 * still, so its badge has to be updated in place rather than on the next move.
 */
function renderPlayback(): void {
  const note = document.getElementById("playback-note");
  if (note) {
    note.textContent =
      playback && popoverTrack?.pid === playback.pid ? PLAYBACK_TEXT[playback.state] : "";
  }
  const badge = tooltip.querySelector<HTMLElement>(".audio-badge");
  if (badge && playback && hoveredPid === playback.pid) {
    badge.textContent = PLAYBACK_TEXT[playback.state];
  }
}

// ---------- browsing mode ----------

const BROWSING_KEY = "onkio.browsing";

/**
 * Hover autoplay, off by default, driven by a toggle in the map toolbar. Playing
 * on every hover regardless is intrusive, and with a music folder connected a
 * hover pulls a whole file off disk rather than a 30-second clip, so it stays
 * something to ask for. Clicking a dot and pressing Play works either way.
 */
let browsing = false;

function setBrowsing(on: boolean): void {
  browsing = on;
  localStorage.setItem(BROWSING_KEY, on ? "on" : "off");
  // This click is itself the gesture the note asks for, and the note means
  // nothing while the mode is off.
  setAutoplayNote(false);
  setToggleState("browse-toggle", on);
  const btn = $("browse-toggle");
  btn.title = on
    ? "Browsing mode on — resting the pointer on a dot plays it"
    : "Browsing mode — rest the pointer on a dot to hear it, without clicking";
  // Switching off silences what it started now, rather than at the next hover.
  if (!on) stopHoverAudio();
}

$("browse-toggle").addEventListener("click", () => setBrowsing(!browsing));

setBrowsing(localStorage.getItem(BROWSING_KEY) === "on");

/**
 * A browser refuses to play audio until the page has been clicked. Turning
 * Browsing mode on is itself a click, so the ordinary route is already covered;
 * the exception is a reload that restored the setting as on and was hovered
 * before anything was clicked, and that is the case worth saying out loud rather
 * than leaving as a mode that appears broken.
 */
function setAutoplayNote(blocked: boolean): void {
  $("browse-note").hidden = !blocked;
}

function audioStatus(): AudioStatus {
  return {
    pid: loadedAudio?.pid ?? null,
    // `paused` covers a deliberate pause and a preview that has run out alike.
    playing: loadedAudio !== null && !previewAudio.paused,
    origin: loadedAudio?.origin ?? null,
  };
}

function stopHoverAudio(): void {
  if (loadedAudio?.origin !== "hover") return;
  previewAudio.pause();
}

/** Work out what a hover owes the audio, and do it. */
function applyHoverPlayback(track: Track | null): void {
  const target = track
    ? { pid: track.pid, playable: isPlayable(track), local: localByPid.has(track.pid) }
    : null;
  const action = decideHoverPlayback(target, audioStatus(), browsing);
  if (action.kind === "stop") stopHoverAudio();
  else if (action.kind === "start" && track) {
    hoverTimer = window.setTimeout(() => {
      void playTrack(track, "hover");
    }, action.delayMs);
  }
}

/**
 * Play a track: its own file where the folder resolved one, otherwise the 30s
 * preview. The file wins because it is the track itself rather than a clip of a
 * catalogue version of it, and for a personal edit it is the only audio there is.
 */
async function playTrack(t: Track, origin: PlayOrigin): Promise<void> {
  const request = ++playRequest;
  const handle = localByPid.get(t.pid);
  const local = handle ? await localAudioUrl(t.pid, handle, request) : null;

  let url = local;
  if (!url) {
    // A stored preview URL is a hint rather than an address: Deezer signs them
    // and they last 15 minutes, so the one on the track is usually dead.
    setPlayback(t.pid, "loading");
    const resolved = await resolvePreviewUrl(t);
    if (request !== playRequest) return;
    if (resolved.kind !== "url") {
      setPlayback(t.pid, resolved.kind === "none" ? "no-preview" : "unavailable");
      return;
    }
    url = resolved.url;
  }
  if (request !== playRequest) return;
  // Opening a file or minting a URL takes long enough for the pointer to have
  // moved on, and a dot that has been left must not start playing after the fact.
  if (origin === "hover" && hoveredPid !== t.pid) {
    setPlayback(t.pid, null);
    return;
  }

  const transition = playbackTransition(loadedAudio?.url ?? null, url);
  if (transition === "load") previewAudio.src = url;
  loadedAudio = { pid: t.pid, url, origin };
  void previewAudio
    .play()
    .then(() => {
      setAutoplayNote(false);
      setPlayback(t.pid, "playing");
    })
    .catch((err: unknown) => {
      // AbortError only means a newer load replaced this one, which is ordinary
      // mid-sweep. NotAllowedError is the autoplay policy, which is not.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setAutoplayNote(true);
        setPlayback(t.pid, "blocked");
        return;
      }
      // Everything else is a load that did not arrive. Reported rather than
      // discarded, and forgotten so a retry loads afresh instead of resuming an
      // element that is holding a URL it could not play.
      failPlayback(t.pid);
    });
}

/**
 * Give up on the loaded audio. `loadedAudio` is what `playbackTransition` reads
 * to decide between resuming and reloading, so leaving it set after a failure
 * makes every later attempt at that track resume an element stuck in an error
 * state, and the track can never recover inside the session.
 */
function failPlayback(pid: string): void {
  if (loadedAudio?.pid === pid) loadedAudio = null;
  setPlayback(pid, "unavailable");
}

async function localAudioUrl(
  pid: string,
  handle: LocalFileHandle,
  request: number
): Promise<string | null> {
  if (localAudio?.pid === pid) return localAudio.url;
  const file = await readLocalFile(handle);
  // Superseded while the file was opening: revoking now would pull the URL out
  // from under whatever started playing in the meantime.
  if (request !== playRequest) return null;
  if (!file) {
    // Moved or deleted since the walk, so stop offering it.
    localByPid.delete(pid);
    renderCoverage();
    return null;
  }
  releaseLocalAudio();
  localAudio = { pid, url: URL.createObjectURL(file) };
  return localAudio.url;
}

// ---------- embedding ----------

let embedWorker: Worker | null = null;

/**
 * One layout for whatever is loaded. Several imported files are a single
 * library by the time they get here, so they land in one space and are laid
 * out by the same fields as any other track.
 */
function runEmbedding(): void {
  if (!library) return;
  const status = $("embed-status");
  status.textContent = "Building features…";

  const matrix = buildFeatureMatrix(library.tracks, library.playlists, {
    semanticWeight: parseInt($<HTMLInputElement>("semantic-slider").value, 10) / 100,
    timbreWeight: parseInt($<HTMLInputElement>("timbre-slider").value, 10) / 100,
  });

  embedWorker?.terminate();
  const worker = new Worker(new URL("./embed/embed.worker.ts", import.meta.url), {
    type: "module",
  });
  embedWorker = worker;
  worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      status.textContent = `Embedding… ${Math.round((msg.epoch / msg.totalEpochs) * 100)}%`;
    } else if (msg.type === "error") {
      status.textContent = `Embedding failed: ${msg.message}`;
    } else {
      coords = msg.coords;
      clusters = msg.clusters;
      status.textContent = `Embedded in ${(msg.elapsedMs / 1000).toFixed(1)}s`;
      onEmbeddingReady();
    }
  };
  const req: EmbedRequest = { data: matrix.data, n: matrix.n, d: matrix.d, seed: 42 };
  worker.postMessage(req, [matrix.data.buffer]);
}

function onEmbeddingReady(): void {
  if (!library || !coords || !clusters) return;
  closeTrackPopover();
  closeGapPopover();

  clusterLabels = new Map(
    summarizeClusters(library.tracks, clusters).map((c) => [c.cluster, c.label])
  );
  gaps = findGaps(coords, clusters, library.tracks.length);

  if (!scatter) {
    scatter = new Scatter($<HTMLCanvasElement>("scatter-canvas"), {
      onHover: handleHover,
      onClick: handleClick,
      onGapClick: openGapPopover,
      onViewChange: () => {
        repositionPopovers();
        updatePriority();
      },
    });
    scatter.setTheme(currentTheme());
  }
  scatter.setClusterLabels(clusterLabels);
  scatter.setCollections(library.collections ?? []);
  scatter.setData({ tracks: library.tracks, coords, clusters });
  applyGapsVisibility();
  applyHighlight();
  renderLegend();
  renderCoverage();
  updatePriority();
}

/**
 * Priority follows the camera: whatever is on screen gets looked up first.
 * Debounced because it fires on every frame of a drag.
 */
let priorityTimer: number | undefined;

function updatePriority(): void {
  window.clearTimeout(priorityTimer);
  priorityTimer = window.setTimeout(() => {
    if (!scatter || !library) return;
    const visible = scatter.visiblePids();
    queue?.setPriority(visible, library.playlists.flatMap((p) => p.pids));
    const byPid = new Set(visible);
    const pending = library.tracks.filter(
      (t) => byPid.has(t.pid) && (!t.bpm || !t.key)
    ).length;
    if (!dspRunning) {
      $("dsp-status").textContent = pending
        ? `${pending.toLocaleString()} in view need analysis`
        : "nothing in view needs analysis";
    }
  }, 250);
}

// ---------- enrichment ----------

// Throttled by wall clock, not by count: a count-based interval never fires
// on a small library, so the readout sat at 0% while lookups were succeeding.
let lastReadout = 0;
let lastSave = 0;

function onTrackEnriched(t: Track): void {
  scatter?.update();
  const now = Date.now();
  if (now - lastReadout > 500) {
    lastReadout = now;
    renderLegend();
    renderCoverage();
  }
  if (library && now - lastSave > 10_000) {
    lastSave = now;
    void saveLibrary(library);
  }
  if (popoverTrack && t.pid === popoverTrack.pid) renderTrackPopover();
}

$("enrich-toggle").addEventListener("click", () => {
  if (!queue) return;
  if (queueRunning) {
    queue.stop();
    queueRunning = false;
    $("enrich-toggle").textContent = "Start lookups";
    $("enrich-status").textContent = "paused";
  } else {
    queueRunning = true;
    $("enrich-toggle").textContent = "Pause lookups";
    void queue.start();
  }
});

const gsbInput = $<HTMLInputElement>("gsb-key");
gsbInput.value = getSongBpmApiKey() ?? "";
gsbInput.addEventListener("change", () => setSongBpmApiKey(gsbInput.value));

const gsbProxyInput = $<HTMLInputElement>("gsb-proxy");
gsbProxyInput.value = getSongBpmProxy() ?? "";
gsbProxyInput.addEventListener("change", () => setSongBpmProxy(gsbProxyInput.value));

// ---------- DSP (§4 stage 2) ----------

/**
 * Analysis is on-demand and scoped to the viewport. Previously this was gated
 * to dance/electronic genres, which meant a pop-heavy library got zero
 * analysis and a status line reading "done — 0 analyzed"; genre now only
 * informs the half-time suspicion check, never whether we look at all.
 */
let dspRunning = false;

/**
 * The audio to analyze, best first. A local file beats a preview twice over: it
 * exists for personal edits and unreleased bounces that no catalogue carries,
 * and it is the master rather than a re-encode of a catalogue release. Only when
 * there is no file does this spend an online lookup on finding a preview.
 */
async function analysisSource(t: Track): Promise<AudioSource | null> {
  const handle = localByPid.get(t.pid);
  if (handle) {
    const file = await readLocalFile(handle);
    if (file) return { url: URL.createObjectURL(file), kind: "file" };
  }
  // Same expiry trap as playback: analysis fetches the URL itself, so a stale
  // one fails the decode rather than the download and looks like a track that
  // simply cannot be heard.
  const resolved = await resolvePreviewUrl(t);
  return resolved.kind === "url" ? { url: resolved.url, kind: "preview" } : null;
}

/**
 * Analyze one track from whatever audio is available, reporting whether
 * anything changed. A local file's object URL is released as soon as the decode
 * is done: a viewport of full tracks left as live blob URLs would exhaust
 * memory long before the pass finished.
 */
async function analyzeTrack(t: Track): Promise<boolean> {
  const source = await analysisSource(t);
  if (!source) return false;
  dspPool ??= new DspPool();
  try {
    const r = await dspPool.analyze(t, source);
    return !!r && DspPool.apply(t, r);
  } finally {
    if (source.kind === "file") URL.revokeObjectURL(source.url);
  }
}

$("dsp-start").addEventListener("click", async () => {
  if (!library) return;
  if (dspRunning) {
    dspRunning = false; // second click cancels
    return;
  }

  const byPid = new Map(library.tracks.map((t) => [t.pid, t]));
  const targets = scatter
    ? (scatter.visiblePids().map((p) => byPid.get(p)!).filter((t) => t && (!t.bpm || !t.key)))
    : [];

  const status = $("dsp-status");
  if (targets.length === 0) {
    status.textContent = "Nothing in view needs analysis.";
    return;
  }

  dspRunning = true;
  const button = $("dsp-start");
  button.textContent = "Stop analyzing";
  let done = 0;
  let found = 0;

  for (const t of targets) {
    if (!dspRunning) break;
    if (await analyzeTrack(t)) {
      found++;
      scatter?.update();
      if (popoverTrack?.pid === t.pid) renderTrackPopover();
    }
    done++;
    status.textContent = `${done} / ${targets.length} · ${found} resolved`;
    if (done % 20 === 0) {
      void saveLibrary(library);
      renderCoverage();
      renderLegend();
    }
  }

  void saveLibrary(library);
  renderCoverage();
  renderLegend();
  status.textContent = dspRunning
    ? `done — ${found} of ${targets.length} resolved`
    : `stopped — ${found} resolved`;
  dspRunning = false;
  button.textContent = "Analyze what's in view";
});

/**
 * Sound analysis: fetch a preview and measure its timbre, for tracks we
 * haven't heard yet. Scoped to the viewport because iTunes rate-limits at
 * roughly 20 lookups a minute — a whole crate is an hour of wall clock, so
 * this is meant to be run repeatedly on the region you care about. Progress
 * is saved as it goes and resumes on the next run.
 */
let soundRunning = false;

$("sound-analyze").addEventListener("click", async () => {
  if (!library) return;
  const button = $("sound-analyze");
  if (soundRunning) {
    soundRunning = false; // second click cancels
    return;
  }

  const byPid = new Map(library.tracks.map((t) => [t.pid, t]));
  const targets = (scatter?.visiblePids() ?? [])
    .map((p) => byPid.get(p))
    .filter((t): t is Track => !!t && !t.timbre);

  const status = $("sound-status");
  if (targets.length === 0) {
    status.textContent = "Everything in view has been analyzed.";
    return;
  }

  soundRunning = true;
  button.textContent = "Stop analyzing";
  let done = 0;
  let heard = 0;

  for (const t of targets) {
    if (!soundRunning) break;
    if (await analyzeTrack(t)) {
      if (t.timbre) heard++;
      scatter?.update();
      if (popoverTrack?.pid === t.pid) renderTrackPopover();
    }
    done++;
    status.textContent = `${done} / ${targets.length} · heard ${heard}`;
    if (done % 20 === 0) {
      void saveLibrary(library);
      renderCoverage();
    }
  }

  void saveLibrary(library);
  renderCoverage();
  status.textContent =
    (soundRunning ? "done" : "stopped") +
    ` — heard ${heard} of ${done}` +
    (heard < done
      ? `; ${done - heard} had neither a local file nor a preview${musicFolder ? "" : ". Connecting a music folder reaches the rest"}`
      : "") +
    ". Open 'Sound influence (advanced)' to use it.";
  soundRunning = false;
  button.textContent = "Analyze sound in view";
});

/** Analyze a single track immediately — used when you pin or queue one. */
async function analyzeOne(t: Track): Promise<void> {
  if (t.bpm && t.key) return;
  if (await analyzeTrack(t)) {
    scatter?.update();
    renderCoverage();
    if (popoverTrack?.pid === t.pid) renderTrackPopover();
    if (library) void saveLibrary(library);
  }
}

// ---------- collections + comparison ----------

function collectionSwatch(i: number): string {
  const c = collectionColor(i);
  return `<span class="coll-dot" style="background: rgb(${c.join(",")})"></span>`;
}

function renderCollections(): void {
  const list = $("collection-list");
  const cols = library?.collections ?? [];
  $("import-mode").hidden = library === null;
  $("import-undo").hidden = previousLibrary === null;
  if (cols.length === 0) {
    list.innerHTML = "";
    list.hidden = true;
    return;
  }
  list.hidden = false;
  list.innerHTML = cols
    .map(
      (c, i) => `<div class="coll-row">
        ${collectionSwatch(i)}
        <span class="coll-name" title="${esc(c.label)}">${esc(c.label)}</span>
        <span class="muted small">${c.format} · ${c.trackCount.toLocaleString()}</span>
        ${cols.length > 1 ? `<button class="link-btn" data-remove="${esc(c.id)}" title="Remove this collection">remove</button>` : ""}
      </div>`
    )
    .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!library) return;
      const id = btn.dataset.remove!;
      previousLibrary = library;
      const next = removeCollection(library, id);
      $("import-status").textContent =
        `Removed ${id} — ${next.tracks.length.toLocaleString()} tracks left.`;
      await onLibraryLoaded(next);
      renderCollections();
    });
  });
}

// ---------- coverage + diagnostics ----------

function coverageRow(label: string, count: number, total: number): string {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return `<div class="cov-row">
       <span>${esc(label)}</span>
       <span class="cov-bar"><span style="width:${pct}%"></span></span>
       <span class="cov-num">${Math.round(pct)}%</span>
     </div>`;
}

/**
 * Coverage is reported per file, because that is the grain at which the answer
 * differs: one export knows every BPM and the other knows none, and the pooled
 * average describes neither.
 */
function renderCoverage(): void {
  if (!library) return;
  const rows = collectionCoverage(library, new Set(localByPid.keys()));
  const parts = rows.map((r) => {
    const head =
      rows.length > 1
        ? `<div class="cov-group">
             ${collectionSwatch(rows.indexOf(r))}
             <span class="cov-group-name" title="${esc(r.label)}">${esc(r.label)}</span>
             <span class="muted small">${r.total.toLocaleString()}</span>
           </div>`
        : "";
    return (
      head +
      coverageRow("BPM", r.bpm, r.total) +
      coverageRow("Key", r.key, r.total) +
      coverageRow("Sound", r.sound, r.total) +
      coverageRow("Preview", r.preview, r.total) +
      // Only meaningful once a folder is connected; otherwise it is a row of
      // zeroes reporting on something that was never switched on.
      (musicFolder ? coverageRow("Files", r.local, r.total) : "")
    );
  });
  $("coverage").innerHTML = parts.join("");
  $("enrich-scope").textContent = describeOutstanding(rows);
  syncSoundInfluence(rows);

  const stats = getSourceStats();
  $("source-stats").innerHTML = Object.entries(stats)
    .map(
      ([name, s]) =>
        `<div>${name}: ${s.calls} calls · ${s.hits} hit · ${s.misses} miss · ${s.errors} err</div>`
    )
    .join("");
}

function syncSoundInfluence(rows: CollectionCoverage[]): void {
  const { enabled, note } = describeSoundInfluence(rows);
  $<HTMLInputElement>("timbre-slider").disabled = !enabled;
  $("timbre-note").textContent = note;
}

$("retry-misses").addEventListener("click", async () => {
  const removed = await clearCachedMisses();
  $("source-stats").innerHTML = `<div>cleared ${removed.toLocaleString()} cached misses — start lookups again</div>`;
  if (library && queue) {
    queue.refill(library.tracks.filter(needsLookup));
    $("enrich-status").textContent = `${queue.remaining.toLocaleString()} tracks requeued`;
  }
});

// ---------- hover tooltip ----------

const tooltip = $("tooltip");

function handleHover(track: Track | null, x: number, y: number): void {
  // Fires on every pointer move over the canvas, not only on entering a dot, so
  // any dwell that has not fired yet belongs to a position already left behind.
  window.clearTimeout(hoverTimer);
  hoveredPid = track?.pid ?? null;
  applyHoverPlayback(track);

  // The pinned popover already says everything the tooltip would, in the
  // same spot — showing both just stacks two boxes on one dot.
  if (!track || popoverTrack?.pid === track.pid) {
    tooltip.hidden = true;
    return;
  }
  tooltip.hidden = false;
  tooltip.style.left = `${x + 14}px`;
  tooltip.style.top = `${y + 14}px`;
  tooltip.innerHTML = `
    <div class="t-name">${esc(track.name)}</div>
    <div class="t-meta">${esc(track.artist ?? "")}${track.album ? " — " + esc(track.album) : ""}</div>
    <div>
      ${track.bpm ? `<span class="badge${track.bpmSuspect ? " warn" : ""}">${Math.round(track.bpm)} BPM${track.bpmSuspect ? " ⚠½×?" : ""}</span>` : ""}
      ${track.key ? `<span class="badge">${camelotDisplay(track.key)}</span>` : ""}
      ${track.genre ? `<span class="badge">${esc(track.genre)}</span>` : ""}
      ${track.year ? `<span class="badge">${track.year}</span>` : ""}
      ${browsing ? `<span class="badge audio-badge">${isPlayable(track) ? (localByPid.has(track.pid) ? "file" : "preview") : "no audio"}</span>` : ""}
    </div>
  `;
}

function handleClick(track: Track | null): void {
  setAutoplayNote(false);
  if (track) openTrackPopover(track);
  else {
    closeTrackPopover();
    closeGapPopover();
  }
}

// ---------- popover anchoring ----------

function anchorPopover(el: HTMLElement, worldX: number, worldY: number): void {
  const p = scatter?.project(worldX, worldY);
  if (!p) {
    el.style.visibility = "hidden";
    return;
  }
  const view = $("view-map");
  const vw = view.clientWidth;
  const vh = view.clientHeight;
  if (p[0] < -300 || p[1] < -300 || p[0] > vw + 300 || p[1] > vh + 300) {
    el.style.visibility = "hidden";
    return;
  }
  el.style.visibility = "visible";
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  let left = p[0] + 16;
  let top = p[1] + 16;
  if (left + pw > vw - 8) left = p[0] - pw - 16;
  if (top + ph > vh - 8) top = p[1] - ph - 16;
  el.style.left = `${Math.max(8, Math.min(left, vw - pw - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(top, vh - ph - 8))}px`;
}

function repositionPopovers(): void {
  if (popoverTrack && coords) {
    const i = pidToIndex.get(popoverTrack.pid);
    if (i !== undefined) anchorPopover($("track-popover"), coords[i * 2], coords[i * 2 + 1]);
  }
  if (popoverGap) anchorPopover($("gap-popover"), popoverGap.x, popoverGap.y);
  repositionInfoPopups();
}

window.addEventListener("resize", repositionPopovers);

// ---------- track popover (detail + manual overrides, §4 stage 3) ----------

let popoverTrack: Track | null = null;

function openTrackPopover(track: Track): void {
  popoverTrack = track;
  tooltip.hidden = true;
  closeGapPopover();
  renderTrackPopover();
}

function closeTrackPopover(): void {
  popoverTrack = null;
  $("track-popover").hidden = true;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderTrackPopover(): void {
  const t = popoverTrack;
  if (!t) return;
  const el = $("track-popover");
  el.hidden = false;

  const hasFile = localByPid.has(t.pid);
  const sharedName = localResolution?.ambiguous.get(t.pid)?.length ?? 0;
  const playable = hasFile ? "file" : t.previewUrl ? "preview" : null;

  const derived = (field: "bpm" | "key") => {
    const src = t.source?.[field];
    if (!src) return "";
    const conf = t.confidence?.[field];
    const confText = src === "manual" || conf === undefined
      ? ""
      : ` · ${Math.round(conf * 100)}% sure`;
    return `<span class="badge">${field}: ${esc(src)}${confText}</span>`;
  };

  el.innerHTML = `
    <button class="close" title="Close">✕</button>
    <h3>${esc(t.name)}</h3>
    <div class="sub">${esc(t.artist ?? "Unknown artist")}${t.album ? " — " + esc(t.album) : ""}</div>
    <div>
      ${t.genre ? `<span class="badge">${esc(t.genre)}</span>` : ""}
      ${t.year ? `<span class="badge">${t.year}</span>` : ""}
      ${t.durationMs ? `<span class="badge">${fmtDuration(t.durationMs)}</span>` : ""}
      ${t.bpmSuspect ? `<span class="badge warn">maybe half-time</span>` : ""}
      ${hasFile ? `<span class="badge">local file</span>` : ""}
      ${sharedName > 1 ? `<span class="badge warn" title="Left unmatched rather than guessed">${sharedName} files share this name</span>` : ""}
    </div>
    <hr />
    <div class="row"><span>BPM</span><input id="ov-bpm" type="number" step="0.1" value="${t.bpm ? Math.round(t.bpm * 10) / 10 : ""}" /></div>
    <div class="row"><span>Key</span><input id="ov-key" type="text" placeholder="8A / Am" value="${t.key ?? ""}" /></div>
    <div class="small">${derived("bpm")}${derived("key")}</div>
    <div class="actions">
      <button id="ov-save" class="primary">Save edits</button>
      <button id="add-to-set">Add to set</button>
      ${playable ? `<button id="play-audio">${playable === "file" ? "Play file" : "Play preview"}</button>` : ""}
    </div>
    <div id="playback-note" class="small muted"></div>
  `;

  el.querySelector<HTMLButtonElement>(".close")!.addEventListener("click", closeTrackPopover);

  $("ov-save").addEventListener("click", async () => {
    const bpmVal = parseFloat($<HTMLInputElement>("ov-bpm").value);
    const keyRaw = $<HTMLInputElement>("ov-key").value.trim();
    const keyVal = keyRaw ? toCamelot(keyRaw) : null;
    if (keyRaw && !keyVal) {
      alert(`Couldn't read "${keyRaw}" as a key — try 8A, 1m or Am.`);
      return;
    }
    const o: { bpm?: number; key?: string } = {};
    if (Number.isFinite(bpmVal) && bpmVal > 0) {
      o.bpm = bpmVal;
      t.bpm = bpmVal;
      t.confidence = { ...t.confidence, bpm: 1 };
      t.source = { ...t.source, bpm: "manual" };
      t.bpmSuspect = false;
    }
    if (keyVal) {
      o.key = keyVal;
      t.key = keyVal;
      t.confidence = { ...t.confidence, key: 1 };
      t.source = { ...t.source, key: "manual" };
    }
    await putOverride(t.pid, o);
    if (library) await saveLibrary(library);
    renderTrackPopover();
    scatter?.update();
    renderLegend();
    renderSet();
  });

  $("add-to-set").addEventListener("click", () => {
    setList.push(t);
    renderSet();
    // A track in a set needs BPM and key to be mixable at all, so earn them now.
    void analyzeOne(t);
  });

  if (playable) {
    // Explicit, so it plays regardless of Browsing mode and pointer movement
    // afterwards does not silence it.
    $("play-audio").addEventListener("click", () => void playTrack(t, "click"));
  }

  renderPlayback();

  const i = pidToIndex.get(t.pid);
  if (i !== undefined && coords) anchorPopover(el, coords[i * 2], coords[i * 2 + 1]);
}

// ---------- gaps overlay (§7.3) ----------

let popoverGap: Gap | null = null;

$("gaps-toggle").addEventListener("click", () => {
  gapsVisible = !gapsVisible;
  applyGapsVisibility();
  if (!gapsVisible) closeGapPopover();
});

$("reset-view").addEventListener("click", () => scatter?.resetView());
$("zoom-in").addEventListener("click", () => scatter?.zoomBy(1));
$("zoom-out").addEventListener("click", () => scatter?.zoomBy(-1));

function applyGapsVisibility(): void {
  setToggleState("gaps-toggle", gapsVisible);
  scatter?.setGaps(
    gapsVisible
      ? gaps.map((g, index) => ({
          index,
          x: g.x,
          y: g.y,
          a: [g.a.x, g.a.y] as [number, number],
          b: [g.b.x, g.b.y] as [number, number],
        }))
      : []
  );
}

function closeGapPopover(): void {
  popoverGap = null;
  $("gap-popover").hidden = true;
}

function topOf(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

/** Describe one side of a gap from everything in that cluster. */
function neighborhoodOf(side: GapSide): Neighborhood {
  const genres = new Map<string, number>();
  const artists = new Map<string, number>();
  const years: number[] = [];
  if (library && clusters) {
    for (let i = 0; i < library.tracks.length; i++) {
      if (clusters[i] !== side.cluster) continue;
      const t = library.tracks[i];
      if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + 1);
      if (t.artist) artists.set(t.artist, (artists.get(t.artist) ?? 0) + 1);
      if (t.year) years.push(t.year);
    }
  }
  years.sort((a, b) => a - b);
  const median = years.length ? years[Math.floor(years.length / 2)] : undefined;
  return {
    label: clusterLabels.get(side.cluster) ?? `Cluster ${side.cluster + 1}`,
    genres: topOf(genres, 3),
    artists: topOf(artists, 3),
    decade: median ? Math.floor(median / 10) * 10 : undefined,
  };
}

function sideLine(n: Neighborhood, side: GapSide): string {
  const parts = [
    counted(side.size, "track"),
    n.genres.join(", "),
    n.artists.slice(0, 2).join(", "),
  ].filter(Boolean);
  return `<div class="small muted"><strong>${esc(n.label)}</strong> — ${esc(parts.join(" · "))}</div>`;
}

function openGapPopover(index: number): void {
  const g = gaps[index];
  if (!g) return;
  closeTrackPopover();
  popoverGap = g;
  // Frame the pair, not the emptiness: a gap only means anything with the two
  // sides it runs between on screen beside it.
  const reach = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) / 2 + Math.max(g.a.spread, g.b.spread);
  scatter?.zoomTo(g.x, g.y, reach);

  const a = neighborhoodOf(g.a);
  const b = neighborhoodOf(g.b);
  const queries = suggestQueries(a, b);

  const el = $("gap-popover");
  el.hidden = false;
  el.innerHTML = `
    <button class="close" title="Close">✕</button>
    <h3>Gap ${index + 1}</h3>
    <div class="sub">
      You have <span class="side-name">${esc(a.label)}</span> and
      <span class="side-name">${esc(b.label)}</span>, but almost nothing between them.
    </div>
    ${sideLine(a, g.a)}
    ${sideLine(b, g.b)}
    ${
      queries.length
        ? `<hr /><div class="small muted">Try searching (click to copy):</div>
           <div id="gap-queries">${queries
             .map((q) => `<span class="chip" data-q="${esc(q)}">${esc(q)}</span>`)
             .join("")}</div>
           <div class="small" style="margin-top:8px">
             <a href="https://bandcamp.com/search?q=${encodeURIComponent(queries[0])}" target="_blank" rel="noopener">Bandcamp ↗</a> ·
             <a href="https://www.discogs.com/search/?q=${encodeURIComponent(queries[0])}" target="_blank" rel="noopener">Discogs ↗</a> ·
             <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(queries[0])}" target="_blank" rel="noopener">YouTube ↗</a>
           </div>`
        : ""
    }
    <div class="actions"><button id="gap-reset">Back to full map</button></div>
  `;

  el.querySelector<HTMLButtonElement>(".close")!.addEventListener("click", closeGapPopover);
  $("gap-reset").addEventListener("click", () => {
    scatter?.resetView();
    closeGapPopover();
  });
  el.querySelectorAll<HTMLElement>(".chip").forEach((chip) => {
    chip.addEventListener("click", async () => {
      await navigator.clipboard.writeText(chip.dataset.q ?? "").catch(() => {});
      chip.classList.add("copied");
      const original = chip.textContent;
      chip.textContent = "copied ✓";
      setTimeout(() => {
        chip.textContent = original;
        chip.classList.remove("copied");
      }, 1000);
    });
  });

  anchorPopover(el, g.x, g.y);
}

// ---------- legend ----------

$("legend-toggle").addEventListener("click", () => {
  legendVisible = !legendVisible;
  renderLegend();
});

function renderLegend(): void {
  const el = $("legend");
  const entries = scatter?.legendEntries() ?? [];
  setToggleState("legend-toggle", legendVisible && entries.length > 0);
  if (!legendVisible || entries.length === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const mode = $<HTMLSelectElement>("color-mode").value;
  const titles: Record<string, string> = {
    cluster: "Clusters",
    bpm: "BPM",
    key: "Key (Camelot)",
    year: "Decade",
  };
  $("legend-title").textContent = titles[mode] ?? "Legend";

  const shown = entries.slice(0, 16);
  const hiddenCount = entries.length - shown.length;
  $("legend-items").innerHTML =
    shown
      .map(
        (e) => `<div class="legend-row">
          <span class="legend-swatch" style="background: rgb(${e.color.join(",")})"></span>
          <span class="legend-label" title="${esc(e.label)}">${esc(e.label)}</span>
          <span class="legend-count">${e.count.toLocaleString()}</span>
        </div>`
      )
      .join("") +
    (hiddenCount > 0 ? `<div class="legend-row muted small">+${hiddenCount} more</div>` : "");
}

// ---------- set builder (§7.1) ----------

$("suggest-toggle").addEventListener("change", (e) => {
  suggestionMode = (e.target as HTMLInputElement).checked;
  applyHighlight();
});
$("set-clear").addEventListener("click", () => {
  setList.length = 0;
  renderSet();
});
$("export-m3u8").addEventListener("click", () => {
  const blob = new Blob([toM3U8(setList)], { type: "audio/x-mpegurl" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "onkio-set.m3u8";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("export-text").addEventListener("click", async () => {
  await navigator.clipboard.writeText(toTextTracklist(setList));
  $("export-text").textContent = "Copied!";
  setTimeout(() => ($("export-text").textContent = "Copy tracklist"), 1200);
});

function renderSet(): void {
  const list = $("set-list");
  list.innerHTML = "";
  const transitions = evaluateSet(setList);
  setList.forEach((t, i) => {
    const li = document.createElement("li");
    const warnings = i > 0 ? transitions[i - 1].warnings : [];
    const warnText = warnings
      .map((w) => {
        if (w.kind === "key") return w.compat === "clash" ? "key clash" : "key near-miss";
        if (w.kind === "bpm") return `Δ${w.deltaPct}% BPM`;
        return w.kind === "key-unknown" ? "key unknown" : "bpm unknown";
      })
      .join(" · ");
    li.innerHTML = `
      <div class="grow">
        <div>${esc(t.artist ?? "?")} — ${esc(t.name)}</div>
        <div class="muted small">${t.key ? camelotDisplay(t.key) : "?"} · ${t.bpm ? Math.round(t.bpm) + " BPM" : "?"}${t.source?.bpm ? " · " + esc(t.source.bpm) : ""}</div>
        ${warnText ? `<div class="warnings">⚠ ${warnText}</div>` : ""}
      </div>
      <button class="remove" data-i="${i}">✕</button>
    `;
    li.querySelector(".remove")!.addEventListener("click", () => {
      setList.splice(i, 1);
      renderSet();
    });
    list.appendChild(li);
  });
  drawSparkline();
  applyHighlight();
}

function drawSparkline(): void {
  const canvas = $<HTMLCanvasElement>("sparkline");
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bpms = setList.map((t) => t.bpm ?? NaN);
  const valid = bpms.filter((b) => !isNaN(b));
  if (valid.length < 2) return;
  const min = Math.min(...valid) - 5;
  const max = Math.max(...valid) + 5;
  const css = getComputedStyle(document.documentElement);
  ctx.strokeStyle = css.getPropertyValue("--accent").trim() || "#5eead4";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  bpms.forEach((b, i) => {
    if (isNaN(b)) return;
    const x = (i / Math.max(1, bpms.length - 1)) * (canvas.width - 20) + 10;
    const y = canvas.height - 12 - ((b - min) / (max - min)) * (canvas.height - 24);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = css.getPropertyValue("--muted").trim() || "#8a93a6";
  ctx.font = "10px system-ui";
  ctx.fillText(`${Math.round(min + 5)}–${Math.round(max - 5)} BPM`, 10, 12);
}

// ---------- map controls ----------

$<HTMLSelectElement>("color-mode").addEventListener("change", (e) => {
  scatter?.setColorMode((e.target as HTMLSelectElement).value as ColorMode);
  renderLegend();
});

function setColorMode(mode: ColorMode): void {
  $<HTMLSelectElement>("color-mode").value = mode;
  scatter?.setColorMode(mode);
  renderLegend();
}

$<HTMLInputElement>("semantic-slider").addEventListener("change", () => {
  // recompute on release, not on drag (§5.3)
  runEmbedding();
});

$<HTMLInputElement>("timbre-slider").addEventListener("change", () => {
  runEmbedding();
});

$<HTMLSelectElement>("playlist-filter").addEventListener("change", applyHighlight);

// ---------- highlighting ----------

function counted(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function searchHighlight(): HighlightRequest | null {
  if (!library || searchHits.matches.length === 0) return null;
  const tracks = library.tracks;
  return {
    source: "search",
    label: counted(searchHits.matches.length, "search match", "search matches"),
    name: "the search",
    pids: searchHits.matches.map((i) => tracks[i].pid),
  };
}

function suggestionHighlight(): HighlightRequest | null {
  if (!library || !suggestionMode || setList.length === 0) return null;
  const suggestions = suggestNext(setList[setList.length - 1], library.tracks, 200);
  return {
    source: "suggestions",
    label: counted(suggestions.length, "suggested next track"),
    name: "suggestion mode",
    pids: suggestions.map((s) => s.to.pid),
  };
}

function playlistHighlight(): HighlightRequest | null {
  const name = $<HTMLSelectElement>("playlist-filter").value;
  if (!library || !name) return null;
  const pl = library.playlists.find((p) => p.name === name);
  if (!pl) return null;
  return {
    source: "playlist",
    label: `${counted(pl.pids.length, "track")} in "${name}"`,
    name: "the playlist filter",
    pids: pl.pids,
  };
}

/**
 * Single owner of the map's highlight, in precedence order: a search is what
 * you just typed, suggestions belong to a set you are actively building, and
 * the playlist filter is the standing choice underneath both.
 */
function applyHighlight(): void {
  const active = resolveHighlight([
    searchHighlight(),
    suggestionHighlight(),
    playlistHighlight(),
  ]);
  scatter?.setHighlight(active?.pids ?? [], active !== null);
  $("highlight-status").textContent = active?.note ?? "";
}

// ---------- search ----------

const SEARCH_LIST_LIMIT = 20;

const searchInput = $<HTMLInputElement>("track-search");
let searchHits: SearchResults = { matches: [], shown: [] };
let searchTimer: number | undefined;

searchInput.addEventListener("input", () => {
  // A keystroke rescans the library and rewrites the map's highlight, so it
  // waits for a pause in typing rather than running per character.
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 120);
});

searchInput.addEventListener("keydown", (e) => {
  // The global handler ignores keys typed into inputs, so Escape only reaches
  // the search from here.
  if (e.key === "Escape") clearSearch();
});

function runSearch(): void {
  window.clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  searchHits =
    library && query
      ? searchTracks(library.tracks, query, SEARCH_LIST_LIMIT)
      : { matches: [], shown: [] };
  renderSearchResults(query);
  applyHighlight();
}

function clearSearch(): void {
  if (!searchInput.value) return;
  searchInput.value = "";
  runSearch();
}

function renderSearchResults(query: string): void {
  const el = $("search-results");
  el.hidden = query === "";
  if (!query) {
    el.innerHTML = "";
    return;
  }
  if (!library || searchHits.matches.length === 0) {
    el.innerHTML = `<div class="muted small">Nothing matches "${esc(query)}".</div>`;
    return;
  }
  const tracks = library.tracks;
  const more = searchHits.matches.length - searchHits.shown.length;
  el.innerHTML =
    searchHits.shown
      .map((i) => {
        const t = tracks[i];
        return `<button type="button" class="search-hit" data-pid="${esc(t.pid)}">
          <span class="hit-name">${esc(t.name)}</span>
          <span class="hit-artist">${esc(t.artist ?? "Unknown artist")}</span>
        </button>`;
      })
      .join("") +
    (more > 0
      ? `<div class="muted small more">${counted(more, "more match", "more matches")}, highlighted on the map but not listed.</div>`
      : "");

  el.querySelectorAll<HTMLButtonElement>(".search-hit").forEach((btn) => {
    btn.addEventListener("click", () => focusTrack(btn.dataset.pid!));
  });
}

/** Go to a track from the result list: camera onto it, popover pinned to it. */
function focusTrack(pid: string): void {
  if (!library || !coords) return;
  const i = pidToIndex.get(pid);
  if (i === undefined) return;
  scatter?.focusOn(coords[i * 2], coords[i * 2 + 1]);
  openTrackPopover(library.tracks[i]);
}

// ---------- tabs ----------

document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab!));
});

function switchTab(tab: string): void {
  document.querySelectorAll("#tabs button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.tab === tab);
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `view-${tab}`);
  });
  if (tab === "taste") renderTaste();
  if (tab === "map") requestAnimationFrame(repositionPopovers);
}

function renderTaste(): void {
  const body = $("taste-body");
  if (!library || !clusters) {
    body.innerHTML = '<p class="muted">Import a library first.</p>';
    return;
  }
  const report = tasteReport(library.tracks);
  const clusterSummaries = summarizeClusters(library.tracks, clusters);
  const maxG = report.genreDistribution[0]?.[1] ?? 1;
  body.innerHTML = `
    <h2>Taste</h2>
    <div class="taste-grid">
      <div class="card">
        <h3>Genres</h3>
        <table>${report.genreDistribution
          .map(
            ([g, c]) =>
              `<tr><td>${esc(g)}</td><td>${c}</td></tr><tr><td colspan="2"><div class="bar" style="width:${(c / maxG) * 100}%"></div></td></tr>`
          )
          .join("")}</table>
      </div>
      <div class="card">
        <h3>Artist concentration</h3>
        <p class="muted small">Top 10 artists = ${(report.top10ArtistShare * 100).toFixed(1)}% of library</p>
        <table>${report.artistConcentration
          .map(([a, c]) => `<tr><td>${esc(a)}</td><td>${c}</td></tr>`)
          .join("")}</table>
      </div>
      ${clusterSummaries
        .slice(0, 12)
        .map(
          (c) => `
        <div class="card">
          <h3>${esc(c.label)}</h3>
          <p class="muted small">${c.size} tracks</p>
          <table>${c.topArtists.map(([a, n]) => `<tr><td>${esc(a)}</td><td>${n}</td></tr>`).join("")}</table>
        </div>`
        )
        .join("")}
    </div>
  `;
}

// ---------- resume from a previous session ----------

void (async () => {
  const saved = await loadLibrary();
  if (saved) {
    $("import-status").textContent =
      `Restored previous session: ${saved.tracks.length.toLocaleString()} tracks`;
    await onLibraryLoaded(saved);
  }
  await restoreMusicFolder();
})();

// persist on tab close so the queue resumes (§3.3)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && library) void saveLibrary(library);
});

// tiny hook for automated smoke tests (harmless in production)
Object.assign(window, {
  __onkio: {
    importFile,
    importFiles,
    setImportMode: (mode: "add" | "replace") => {
      const el = document.querySelector<HTMLInputElement>(
        `input[name="import-mode"][value="${mode}"]`
      );
      if (el) el.checked = true;
    },
    setColorMode,
    getState: () => ({
      tracks: library?.tracks.length ?? 0,
      playlists: library?.playlists.length ?? 0,
      embedded: coords !== null,
      clusters: clusters ? new Set(clusters).size : 0,
      gaps: gaps.length,
      // Detail as well as count: the thresholds in views/gaps.ts are ratios,
      // and checking them from outside means seeing what each gap scored.
      gapDetail: gaps.map((g) => ({
        isolation: g.isolation,
        width: g.width,
        a: { cluster: g.a.cluster, size: g.a.size },
        b: { cluster: g.b.cluster, size: g.b.size },
      })),
      theme: currentTheme(),
      browsing,
      playing: loadedAudio ? { pid: loadedAudio.pid, origin: loadedAudio.origin } : null,
      view: scatter?.getViewState(),
      collections: (library?.collections ?? []).map((c) => ({
        id: c.id,
        label: c.label,
        format: c.format,
        tracks: c.trackCount,
      })),
      coverage: library ? collectionCoverage(library, new Set(localByPid.keys())) : [],
      localFolder: musicFolder?.name ?? null,
      localState: localState.kind,
      localFiles: localIndex?.paths.length ?? 0,
      localMatched: localByPid.size,
      localAmbiguous: localResolution?.ambiguous.size ?? 0,
      queued: queue?.remaining ?? 0,
      bpm: library?.tracks.filter((t) => !!t.bpm).length ?? 0,
      key: library?.tracks.filter((t) => !!t.key).length ?? 0,
    }),
  },
});
