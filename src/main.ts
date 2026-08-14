import type { CollectionFormat, CollectionMeta, Library, Track } from "./types";
import type { ParseWorkerMsg } from "./parse/parse.worker";
import type { RekordboxWorkerMsg } from "./parse/rekordbox.worker";
import type { RekordboxTxtWorkerMsg } from "./parse/rekordboxTxt.worker";
import { detectCollectionFormat } from "./parse/format";
import { decodeRekordboxTxt } from "./parse/rekordboxTxt";
import type { EmbedRequest, EmbedResponse } from "./embed/embed.worker";
import { buildFeatureMatrix } from "./features/matrix";
import { encodeTrack, type FeatureEncoder } from "./features/encoder";
import {
  placeVector,
  projectVector,
  transferLabels,
  PROJECTION_NEIGHBORS,
} from "./embed/project";
import {
  attachProjectedTrack,
  reprojectAttachedTrack,
  type Embedding,
} from "./embed/attach";
import { Scatter, type ColorMode, type Theme } from "./render/scatter";
import { EnrichmentQueue } from "./enrich/queue";
import { DspPool, type AudioSource } from "./dsp/pool";
import {
  ANALYSIS_IDLE_LABEL,
  ANALYSIS_STOP_LABEL,
  analysisLookupTargets,
  analysisNeededCount,
  analysisTargets,
  describeAnalysisNeeded,
} from "./dsp/analysisControl";
import { getSourceStats } from "./enrich/adapter";
import {
  saveSongBpmApiKey,
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
  moveItem,
  orderForSet,
  suggestNext,
  toM3U8,
  toTextTracklist,
} from "./views/setBuilder";
import { summarizeClusters, tasteReport } from "./views/taste";
import { demoCollectionUrl, demoImportFile } from "./util/demo";
import {
  ensureCollections,
  mergeLibraries,
  removeCollection,
  slugifyCollectionId,
  tagCollection,
  uniqueCollectionId,
} from "./collections/merge";
import {
  downsampleLibrary,
  needsDownsampleOffer,
  samplePresets,
} from "./collections/downsample";
import {
  collectionCoverage,
  describeLabelInfluence,
  describePlaylistInfluence,
  describeSoundInfluence,
  needsLookup,
  type CollectionCoverage,
} from "./collections/coverage";
import {
  collectionColor,
  bpmBin,
  bpmBinLabel,
  decadeOf,
  makeBpmScale,
  normalizeGenre,
  type BpmScale,
  DEFAULT_BPM_SCALE,
} from "./render/palette";
import {
  findGaps,
  suggestQueries,
  type Gap,
  type GapSide,
  type Neighborhood,
} from "./views/gaps";
import { resolveHighlight, type HighlightRequest } from "./views/highlight";
import {
  nextSearchMenuDismissed,
  searchTracks,
  type SearchResults,
} from "./views/search";
import {
  externalSearchNote,
  localTitleIndex,
  markLocalDuplicates,
  nextExternalSearch,
  OFF as EXTERNAL_SEARCH_OFF,
  type ExternalCandidate,
  type ExternalSearchState,
} from "./views/externalSearch";
import { deezerTrackFacts, searchDeezerTracks } from "./enrich/sources/deezer";
import {
  decideHoverPlayback,
  playbackTransition,
  type AudioStatus,
  type PlayOrigin,
} from "./views/hoverPlay";
import { camelotDisplay, toCamelot } from "./music/camelot";
import { dismissInfoPopups, initInfoTips, repositionInfoPopups } from "./views/infoTip";
import { resolvePreviewUrl } from "./enrich/preview";
import {
  buildSimilarityMatrix,
  NeighborIndex,
  type Neighbor,
} from "./views/neighbors";
import {
  TUTORIAL_STEPS,
  placeCloud,
  resolveTutorialEl,
  tutorialActionIds,
  tutorialRingIds,
  type TutorialCloud,
} from "./views/tutorial";

// ---------- state ----------

let library: Library | null = null;
let coords: Float32Array | null = null;
let clusters: Int32Array | null = null;
/** Playlist-free, pre-UMAP vectors used for similar-track recommendations. */
let similarityVectors: Float32Array | null = null;
let similarityD = 0;
/**
 * The retained half of the playlist-free fit: the feature encoder and the SVD
 * basis it feeds. Together with `similarityVectors` and `coords` these are
 * enough to place a track the library has never seen without re-embedding,
 * which would move every existing dot. Cleared and rebuilt with the same
 * `embeddingGeneration` as the vectors, so a stale model is never consulted.
 */
let similarityEncoder: FeatureEncoder | null = null;
let similarityBasis: Float64Array | null = null;
let similarityInputD = 0;
let embeddingGeneration = 0;
let neighborIndex: NeighborIndex | null = null;
/** Null means all loaded collections; otherwise a literal CollectionMeta.id. */
let neighborCollection: string | null = null;
let clusterLabels = new Map<number, string>();
let pidToIndex = new Map<string, number>();
let scatter: Scatter | null = null;
let queue: EnrichmentQueue | null = null;
let lookupRemaining = 0;
let lookupSettled: Promise<void> = Promise.resolve();
let dspPool: DspPool | null = null;
const setList: Track[] = [];
let suggestionMode = false;
let gaps: Gap[] = [];
let gapsVisible = false;

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

let tutorialOn = false;
let tutorialIndex = 0;
/**
 * Only a demo load that started on the first step may skip it. A library
 * already in the session must not, or the cloud would jump past "load the demo"
 * on restore.
 */
let tutorialAwaitEmbed = false;

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
previewAudio.addEventListener("ended", () => {
  if (!loadedAudio) return;
  const pid = loadedAudio.pid;
  loadedAudio = null;
  setPlayback(pid, null);
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
  // The set panel is the right-hand bracket to the left-hand panel's "[".
  if (e.key === "]") setPanelOpen(!setPanelIsOpen());
  // "=" is the unshifted key "+" lives on, so both spellings zoom in.
  if (e.key === "+" || e.key === "=") scatter?.zoomBy(1);
  if (e.key === "-" || e.key === "_") scatter?.zoomBy(-1);
  if (e.key === "Escape") {
    // Session-only: the toggle is not written to storage, so Escape is the
    // way out that does not also look like a key that did nothing.
    if (tutorialOn) setTutorial(false);
    clearSearch();
    closeTrackPopover();
    closeGapPopover();
    dismissInfoPopups();
    // Drawing is a mode, and a mode needs a way out that is not the button that
    // started it, since while it is on the map does not pan.
    if (lassoMode) setLassoMode(false);
  }
});

// ---------- info tooltips ----------

initInfoTips();

// The ⓘ popups sit outside the panel to avoid being clipped by it, so the panel
// scrolling moves their trigger out from under them.
$("sidebar").addEventListener("scroll", repositionPopovers, { passive: true });

// ---------- tutorial ----------

function tutorialOnTarget(id: string): boolean {
  const step = TUTORIAL_STEPS[tutorialIndex];
  return tutorialOn && !!step && tutorialActionIds(step).includes(id);
}

function tutorialAdvanceIfTarget(id: string): void {
  if (tutorialOnTarget(id)) tutorialDelta(1);
}

function setTutorial(on: boolean): void {
  tutorialOn = on;
  $("tutorial-toggle").setAttribute("aria-pressed", String(on));
  renderTutorial();
}

function tutorialDelta(d: number): void {
  if (!tutorialOn) return;
  const next = tutorialIndex + d;
  if (next < 0) return;
  // Finishing the last step with → puts the clouds away; the index stays so
  // turning the toggle back on resumes rather than restarting.
  if (next >= TUTORIAL_STEPS.length) {
    setTutorial(false);
    return;
  }
  tutorialIndex = next;
  renderTutorial();
}

function fillCloudCopy(el: HTMLElement, cloud: Pick<TutorialCloud, "body" | "cta">): void {
  const body = el.querySelector(".tutorial-extra-body, #tutorial-body");
  if (body) body.textContent = cloud.body;
  const cta = el.querySelector<HTMLElement>(".tutorial-cta");
  if (!cta) return;
  if (cloud.cta) {
    cta.hidden = false;
    cta.textContent = cloud.cta;
  } else {
    cta.hidden = true;
    cta.textContent = "";
  }
}

function renderTutorial(): void {
  document.querySelectorAll(".tutorial-target").forEach((el) => {
    el.classList.remove("tutorial-target");
  });
  const cloud = $("tutorial-cloud");
  const extras = $("tutorial-extras");
  extras.replaceChildren();
  if (!tutorialOn) {
    cloud.hidden = true;
    return;
  }
  const step = TUTORIAL_STEPS[tutorialIndex];
  $("tutorial-index").textContent = `${tutorialIndex + 1} / ${TUTORIAL_STEPS.length}`;
  fillCloudCopy(cloud, step);
  $("tutorial-exports").hidden = !step.exports;
  $<HTMLButtonElement>("tutorial-back").disabled = tutorialIndex === 0;
  if (step.panel === "sidebar") setSidebarCollapsed(false);
  if (step.panel === "set") setPanelOpen(true);
  const detailsIds =
    step.openDetails == null ? [] : Array.isArray(step.openDetails) ? step.openDetails : [step.openDetails];
  for (const id of detailsIds) {
    const details = document.getElementById(id);
    if (details instanceof HTMLDetailsElement) details.open = true;
  }
  for (const id of step.reveal ?? []) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
  // Color-by lives on the legend, which stays hidden until a map exists.
  if ((step.reveal ?? []).includes("legend") || step.target === "legend-controls") {
    $("legend").hidden = false;
    $("legend").classList.remove("collapsed");
  }
  switchTab("map");
  for (const extra of step.extras ?? []) {
    const el = document.createElement("div");
    el.className = "tutorial-cloud";
    el.innerHTML = `<p class="tutorial-extra-body"></p><p class="tutorial-cta"></p>`;
    fillCloudCopy(el, extra);
    extras.append(el);
  }
  for (const id of tutorialRingIds(step)) {
    document.getElementById(id)?.classList.add("tutorial-target");
  }
  cloud.hidden = false;
  requestAnimationFrame(placeTutorialClouds);
}

function placeTutorialClouds(): void {
  if (!tutorialOn) return;
  const step = TUTORIAL_STEPS[tutorialIndex];
  const placeEl = resolveTutorialEl({
    target: step.place ?? step.target,
    fallback: step.fallback,
  });
  const occupied = [
    placeCloud($("tutorial-cloud"), placeEl, {
      prefer: step.prefer,
      pin: step.pin,
      align: step.align,
    }),
  ];
  const extraEls = [...$("tutorial-extras").children] as HTMLElement[];
  (step.extras ?? []).forEach((extra, i) => {
    const el = extraEls[i];
    if (!el) return;
    occupied.push(
      placeCloud(el, resolveTutorialEl({ target: extra.place ?? extra.target, fallback: extra.fallback }), {
        avoid: occupied,
        prefer: extra.prefer,
        pin: extra.pin,
        align: extra.align,
      })
    );
  });
  resolveTutorialEl(step)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

$("tutorial-toggle").addEventListener("click", () => setTutorial(!tutorialOn));
$("tutorial-back").addEventListener("click", () => tutorialDelta(-1));
$("tutorial-next").addEventListener("click", () => tutorialDelta(1));

// ---------- import ----------

const fileInput = $<HTMLInputElement>("file-input");
const fileDrop = $("file-drop");
const fileDropLabel = $("file-drop-label");
const FILE_DROP_EMPTY =
  fileDropLabel.textContent ?? "Drop collection XML or TXT files here or click to choose";
const importAdd = $<HTMLButtonElement>("import-add");
const importReplace = $<HTMLButtonElement>("import-replace");

/** Chosen but not yet loaded. The drop box shows the names; the two buttons load them. */
let stagedFiles: File[] = [];
let importBusy = false;

function renderStagedFiles(): void {
  const empty = stagedFiles.length === 0;
  $("import-mode").hidden = empty;
  importAdd.disabled = empty || importBusy;
  importReplace.disabled = empty || importBusy;
  fileDrop.classList.toggle("has-files", !empty);
  fileDropLabel.textContent = empty
    ? FILE_DROP_EMPTY
    : stagedFiles.map((file) => file.name).join("\n");
}

function stageFiles(files: File[]): void {
  if (importBusy || files.length === 0) return;
  stagedFiles = files;
  renderStagedFiles();
}

function clearStagedFiles(): void {
  stagedFiles = [];
  fileInput.value = "";
  renderStagedFiles();
}

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) stageFiles([...fileInput.files]);
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
  if (files?.length) stageFiles([...files]);
});

async function commitStaged(mode: "add" | "replace"): Promise<void> {
  if (importBusy || stagedFiles.length === 0) return;
  const files = stagedFiles;
  importBusy = true;
  renderStagedFiles();
  try {
    await importFiles(files, mode);
  } finally {
    importBusy = false;
    clearStagedFiles();
  }
}

importAdd.addEventListener("click", () => void commitStaged("add"));
importReplace.addEventListener("click", () => void commitStaged("replace"));

// ---------- demo collection ----------

const demoBtn = $<HTMLButtonElement>("demo-load");
const demoLabel = $("demo-load-label");
const DEMO_LABEL = demoLabel.textContent ?? "Load the demo collection";

demoBtn.addEventListener("click", () => void loadDemoCollection());

/**
 * The bundled export goes through `importFiles` like anything the user commits,
 * so collection metadata, coverage rows and undo all behave the same way.
 * Wrapping the fetched bytes in a `File` is the whole of the difference.
 */
async function loadDemoCollection(): Promise<void> {
  const status = $("import-status");
  setDemoBusy(true);
  status.textContent = "Fetching the demo collection…";
  if (tutorialOnTarget("demo-load")) tutorialAwaitEmbed = true;
  try {
    const res = await fetch(demoCollectionUrl(import.meta.env.BASE_URL));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
    clearStagedFiles();
    await importFiles([demoImportFile(await res.blob())], "replace");
  } catch (err) {
    // A missing file in a deployment looks exactly like a working button that
    // does nothing, which is the one outcome worth spelling out.
    status.textContent =
      `The demo collection could not be fetched (${err instanceof Error ? err.message : String(err)}). ` +
      "It ships with the site, so this usually means the deployment is missing the file.";
  } finally {
    setDemoBusy(false);
  }
}

/**
 * The fetch is the slow half and can be slow enough to look like nothing
 * happened, so the button says what it is doing rather than only greying out:
 * colour alone is nothing to a screen reader, and the name is what gets read.
 */
function setDemoBusy(busy: boolean): void {
  demoBtn.disabled = busy;
  demoBtn.setAttribute("aria-busy", String(busy));
  demoLabel.textContent = busy ? "Loading the demo collection…" : DEMO_LABEL;
}

/**
 * Several files committed together are imported one after another, not in
 * parallel: each one is a union against the library the previous one produced,
 * and two workers racing to append to the same library would lose tracks.
 *
 * Only the first file honours Add to map vs New map. A drop of three files
 * means "these three together", so files two and three always join the first
 * rather than each replacing it in turn.
 */
async function importFiles(files: File[], mode: "add" | "replace" = "add"): Promise<void> {
  for (const [i, file] of files.entries()) {
    await importFile(file, i === 0 ? mode : "add");
  }
}

/**
 * The user shouldn't have to name the format. XML roots distinguish Apple
 * from rekordbox, while the fixed rekordbox TXT export has its own header.
 */
async function detectFormat(file: File): Promise<CollectionFormat> {
  const head = decodeRekordboxTxt(await file.slice(0, 4096).arrayBuffer());
  return detectCollectionFormat(file.name, head);
}

async function importFile(file: File, mode: "add" | "replace"): Promise<void> {
  const format = await detectFormat(file);
  const parsed =
    format === "rekordbox"
      ? await parseRekordboxFile(file)
      : format === "rekordbox-txt"
        ? await parseRekordboxTxtFile(file)
        : await parseAppleFile(file);
  if (!parsed) return;

  let incoming = parsed.library;
  let detail = parsed.detail;
  let sampledFrom: number | undefined;
  const full = incoming.tracks.length;
  if (needsDownsampleOffer(full)) {
    const size = await offerDownsample(file.name, full);
    if (size !== null) {
      incoming = downsampleLibrary(incoming, size);
      sampledFrom = full;
      detail =
        `${incoming.tracks.length.toLocaleString()} tracks sampled at random from ` +
        `${full.toLocaleString()}, ${incoming.playlists.length} playlists`;
    }
  }
  await adoptImport(incoming, file.name, format, detail, mode, sampledFrom);
}

/**
 * Offer a sample, and resolve with the size chosen or null to keep everything.
 *
 * The offer has to block the import rather than arrive after it: sampling a
 * library that has already been embedded and analyzed would throw away the very
 * work the sample exists to avoid. importFiles awaits each file in turn, so a
 * multi-file drop asks once per oversized file.
 */
function offerDownsample(fileName: string, trackCount: number): Promise<number | null> {
  const prompt = $("downsample-prompt");
  const choices = $("downsample-choices");
  $("downsample-note").textContent =
    `${fileName} holds ${trackCount.toLocaleString()} tracks. Analysis runs at ` +
    "about two seconds a track, so a random sample reaches a map with sound, " +
    "labels and previews far sooner.";
  choices.innerHTML = "";
  prompt.hidden = false;

  return new Promise((resolve) => {
    const answer = (size: number | null): void => {
      prompt.hidden = true;
      choices.innerHTML = "";
      resolve(size);
    };
    for (const size of samplePresets(trackCount)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `Sample ${size.toLocaleString()} tracks`;
      btn.addEventListener("click", () => answer(size));
      choices.appendChild(btn);
    }
    const all = document.createElement("button");
    all.type = "button";
    all.className = "link-btn";
    all.textContent = `Keep all ${trackCount.toLocaleString()}`;
    all.addEventListener("click", () => answer(null));
    choices.appendChild(all);
  });
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

function parseRekordboxTxtFile(
  file: File
): Promise<{ library: Library; detail: string } | null> {
  const status = $("import-status");
  status.textContent = "Parsing rekordbox TXT collection…";
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./parse/rekordboxTxt.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<RekordboxTxtWorkerMsg>) => {
      const message = event.data;
      if (message.type === "error") {
        status.textContent = `Parse failed: ${message.message}`;
        worker.terminate();
        resolve(null);
        return;
      }
      worker.terminate();
      const { stats, ...library } = message.collection;
      const percent = (count: number) => Math.round((count / (stats.parsed || 1)) * 100);
      resolve({
        library,
        detail:
          `${stats.parsed.toLocaleString()} tracks — ` +
          `${percent(stats.withBpm)}% BPM, ${percent(stats.withKey)}% key` +
          (stats.skipped ? ` (${stats.skipped.toLocaleString()} invalid rows skipped)` : ""),
      });
    };
    worker.postMessage({ file });
  });
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
  format: CollectionFormat,
  detail: string,
  mode: "add" | "replace",
  sampledFrom?: number
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
    ...(sampledFrom === undefined ? {} : { sampledFrom }),
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
  if (lib.collections) {
    lib.collections = lib.collections.map((collection) =>
      collection.id === EXTERNAL_COLLECTION_ID
        ? { ...collection, label: EXTERNAL_COLLECTION_LABEL }
        : collection
    );
  }
  if (
    neighborCollection !== null &&
    !lib.collections?.some((collection) => collection.id === neighborCollection)
  ) {
    neighborCollection = null;
  }
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

  const pf = $<HTMLSelectElement>("highlight-kind");
  if (![...pf.options].some((o) => o.value === pf.value)) pf.value = "";
  fillHighlightItems();
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
    lookupRemaining = remaining;
    if (analysisRunning) renderAnalysisProgress();
    if (remaining === 0) {
      renderCoverage();
      renderLegend();
      if (library) void saveLibrary(library);
    }
  });
  await queue.init(lib.tracks);
  lookupRemaining = queue.remaining;
  renderAnalysisIdle();

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
      status.textContent = "No folder chosen";
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
  paintTransport(document.getElementById("play-audio") as HTMLButtonElement | null, popoverTrack?.pid ?? null);
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#set-list .play")) {
    paintTransport(btn, btn.dataset.pid ?? null);
  }
}

function clickTransportOn(pid: string): boolean {
  if (playback?.pid === pid && playback.state === "loading") return loadedAudio?.origin !== "hover";
  return loadedAudio?.pid === pid && loadedAudio.origin === "click" && !previewAudio.paused;
}

function paintTransport(btn: HTMLButtonElement | null, pid: string | null): void {
  if (!btn || !pid) return;
  const on = clickTransportOn(pid);
  btn.textContent = on ? "■" : "▶";
  btn.title = on ? "Stop" : "Play";
  btn.setAttribute("aria-label", on ? "Stop" : "Play");
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

$("browse-toggle").addEventListener("click", () => {
  setBrowsing(!browsing);
});

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

function stopPlayback(): void {
  playRequest += 1;
  previewAudio.pause();
  const pid = loadedAudio?.pid ?? playback?.pid ?? null;
  loadedAudio = null;
  if (pid) setPlayback(pid, null);
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
  if (origin === "click") setPlayback(t.pid, "loading");
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
  const embeddingTracks = library.tracks;
  const embeddingPlaylists = library.playlists;
  const status = $("embed-status");
  status.textContent = "Building features…";

  const options = {
    semanticWeight: parseInt($<HTMLInputElement>("semantic-slider").value, 10) / 100,
    timbreWeight: parseInt($<HTMLInputElement>("timbre-slider").value, 10) / 100,
    labelWeight: parseInt($<HTMLInputElement>("label-slider").value, 10) / 100,
    playlistWeight: parseInt($<HTMLInputElement>("playlist-slider").value, 10) / 100,
  };
  const matrix = buildFeatureMatrix(embeddingTracks, embeddingPlaylists, options);
  // Playlist names are personal filing vocabulary. They structure the map, but
  // comparing them across two people's crates makes "unknown playlist" look
  // like musical dissimilarity, so recommendations get their own matrix.
  const similarityMatrix = buildSimilarityMatrix(
    embeddingTracks,
    embeddingPlaylists,
    options
  );

  embedWorker?.terminate();
  similarityVectors = null;
  similarityD = 0;
  similarityEncoder = null;
  similarityBasis = null;
  similarityInputD = 0;
  neighborIndex = null;
  const generation = ++embeddingGeneration;
  const worker = new Worker(new URL("./embed/embed.worker.ts", import.meta.url), {
    type: "module",
  });
  embedWorker = worker;
  worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
    if (worker !== embedWorker || generation !== embeddingGeneration) return;
    const msg = e.data;
    if (msg.type === "progress") {
      status.textContent = `Embedding… ${Math.round((msg.epoch / msg.totalEpochs) * 100)}%`;
    } else if (msg.type === "error") {
      status.textContent = `Embedding failed: ${msg.message}`;
    } else {
      coords = msg.coords;
      clusters = msg.clusters;
      similarityVectors = msg.similarity;
      similarityD = msg.similarityD;
      // The encoder stays on this side: it holds Maps, and the matrix it
      // describes was built here anyway, so nothing has to be serialized.
      similarityEncoder = similarityMatrix.encoder;
      similarityBasis = msg.similarityBasis;
      similarityInputD = msg.similarityInputD;
      // Everything in this run was fitted with everything else, so a track that
      // had been projected onto an older map is no longer an estimate. It stays
      // marked as external, which is about where it came from rather than how
      // it was placed.
      for (const t of embeddingTracks) if (t.projected) t.projected = false;
      neighborIndex = new NeighborIndex(
        embeddingTracks,
        similarityVectors,
        similarityD,
        generation
      );
      status.textContent = `Embedded in ${(msg.elapsedMs / 1000).toFixed(1)}s`;
      onEmbeddingReady();
    }
  };
  const req: EmbedRequest = {
    data: matrix.data,
    n: matrix.n,
    d: matrix.d,
    similarityData: similarityMatrix.data,
    similarityD: similarityMatrix.d,
    seed: 42,
  };
  worker.postMessage(req, [matrix.data.buffer, similarityMatrix.data.buffer]);
}

/** What a caller has to know about a track that is not in the library. All of
 * it optional: an outside track is described by whatever metadata came with
 * it, and anything missing simply contributes nothing to its position. */
export type ExternalTrackInput = Partial<
  Pick<
    Track,
    "name" | "artist" | "genre" | "tags" | "label" | "bpm" | "key" | "year" | "durationMs" | "timbre"
  >
>;

export type ProjectedTrack = {
  x: number;
  y: number;
  /** Nearest library tracks in the playlist-free space, nearest first. */
  neighbors: { pid: string; name: string; distance: number; weight: number }[];
  /** Cluster carried over from those neighbours by weighted majority. */
  clusterId: number | null;
  clusterLabel: string | null;
  /** Only inferred when the track states no genre of its own. */
  genre: string | null;
};

/** A projection, plus everything needed to attach it to the live embedding. */
type ExternalPlacement = {
  projection: ProjectedTrack;
  x: number;
  y: number;
  /** the track's own coordinates in the playlist-free similarity space */
  vector: Float32Array;
  /** the cluster its neighbours voted for, defaulted rather than left null */
  clusterId: number;
};

/**
 * Place a track the library has never seen onto the map that already exists,
 * without touching any state: encode it through the retained fit, project it
 * through the retained SVD basis, then take the UMAP-weighted mean of its
 * nearest neighbours' positions. Returns null until an embedding is ready.
 */
function placeExternalTrack(input: ExternalTrackInput): ExternalPlacement | null {
  if (!library || !similarityEncoder || !similarityVectors || !coords) return null;
  const track: Track = {
    pid: "",
    trackId: 0,
    name: input.name ?? "",
    durationMs: input.durationMs ?? 0,
    playlists: [],
    ...input,
  };
  const row = encodeTrack(similarityEncoder, track);
  const vector = projectVector(row, similarityBasis, similarityInputD, similarityD);
  const placement = placeVector(
    vector,
    similarityVectors,
    similarityD,
    coords,
    PROJECTION_NEIGHBORS
  );
  if (!placement) return null;
  const transferred = transferLabels(placement.neighbors, clusters, library.tracks);
  return {
    x: placement.x,
    y: placement.y,
    vector,
    // Every neighbour it was placed from is in some cluster, so the vote only
    // comes back empty on a map that has none at all.
    clusterId: transferred.clusterId ?? 0,
    projection: {
      x: placement.x,
      y: placement.y,
      neighbors: placement.neighbors.map(({ index, distance, weight }) => ({
        pid: library!.tracks[index].pid,
        name: library!.tracks[index].name,
        distance,
        weight,
      })),
      clusterId: transferred.clusterId,
      clusterLabel:
        transferred.clusterId === null
          ? null
          : clusterLabels.get(transferred.clusterId) ?? null,
      genre: track.genre ? null : transferred.genre,
    },
  };
}

function projectExternalTrack(input: ExternalTrackInput): ProjectedTrack | null {
  return placeExternalTrack(input)?.projection ?? null;
}

// ---------- tracks from outside the library ----------

/**
 * A track found in a catalogue and placed on the map by projection: a ghost
 * until it is added, part of the library afterwards, and ringed either way.
 *
 * The whole feature turns on one rule: adding one of these never re-embeds.
 * A UMAP layout is not stable under a changed corpus, so re-fitting to admit a
 * single track would move every dot the user is currently looking at — the
 * orientation they built by exploring is worth more than the marginal accuracy
 * of including one more row in the fit. So the arrays are grown in step
 * (src/embed/attach.ts) and `embeddingGeneration` is left alone, which is what
 * every consumer keyed to a layout run reads.
 */
const EXTERNAL_COLLECTION_ID = "external-discoveries";
const EXTERNAL_COLLECTION_LABEL = "Searches";

/** Catalogue results offered at once — a screenful, not a catalogue browser. */
const EXTERNAL_RESULT_LIMIT = 8;

/**
 * Why the dot is where it is. Estimated rather than measured, and said plainly:
 * a record from a genre the crate does not hold lands beside the nearest thing
 * it does hold, which is a statement about the library rather than the track.
 */
const ESTIMATED_NOTE =
  "Estimated position — placed next to the closest tracks you own, not measured from this one.";

type ExternalTrackRecord = {
  track: Track;
  /** what it was projected from, so a timbre arriving later can redo it */
  input: ExternalTrackInput;
  placement: ExternalPlacement;
  /** true once it has been attached to the library */
  added: boolean;
};

const externals = new Map<string, ExternalTrackRecord>();

/** Only ever set by a placement that failed; cleared by the next query. */
let externalNotice = "";

function externalPid(deezerId: number): string {
  return `ext:deezer:${deezerId}`;
}

/** Where a track is, whether it is in the layout or only projected onto it. */
function trackPosition(pid: string): [number, number] | null {
  const i = pidToIndex.get(pid);
  if (i !== undefined && coords) return [coords[i * 2], coords[i * 2 + 1]];
  const record = externals.get(pid);
  return record && !record.added ? [record.placement.x, record.placement.y] : null;
}

function trackByPid(pid: string): Track | null {
  const i = pidToIndex.get(pid);
  if (i !== undefined && library) return library.tracks[i];
  return externals.get(pid)?.track ?? null;
}

function syncGhosts(): void {
  scatter?.setGhosts(
    [...externals.values()]
      .filter((record) => !record.added)
      .map((record) => ({
        track: record.track,
        x: record.placement.x,
        y: record.placement.y,
      }))
  );
}

/** The current embedding as the attach module wants it, or null. */
function liveEmbedding(): Embedding | null {
  if (!library || !coords || !clusters || !similarityVectors || similarityD === 0) {
    return null;
  }
  return {
    tracks: library.tracks,
    coords,
    clusters,
    similarity: similarityVectors,
    similarityD,
  };
}

/**
 * Take a grown or amended embedding without re-fitting anything. Deliberately
 * silent about `embeddingGeneration`: it names the last *fit*, and nothing here
 * is one. The neighbour index is rebuilt rather than mutated because it caches
 * per query, and the camera is held because the user is looking at it.
 */
function adoptEmbedding(next: Embedding): void {
  if (!library) return;
  library = { ...library, tracks: next.tracks };
  coords = next.coords;
  clusters = next.clusters;
  similarityVectors = next.similarity;
  pidToIndex = new Map(next.tracks.map((t, i) => [t.pid, i]));
  neighborIndex = new NeighborIndex(
    next.tracks,
    next.similarity,
    similarityD,
    embeddingGeneration
  );
  gaps = findGaps(next.coords, next.clusters, next.tracks.length);
  scatter?.setData(
    { tracks: next.tracks, coords: next.coords, clusters: next.clusters },
    { keepView: true }
  );
  applyGapsVisibility();
}

/** The Searches row, created on the first add and counted after. */
function withExternalCollection(lib: Library): CollectionMeta[] {
  const cols = lib.collections ?? [];
  const at = cols.findIndex((c) => c.id === EXTERNAL_COLLECTION_ID);
  const meta: CollectionMeta = {
    id: EXTERNAL_COLLECTION_ID,
    label: EXTERNAL_COLLECTION_LABEL,
    format: "external",
    trackCount: lib.tracks.filter((t) => t.collection === EXTERNAL_COLLECTION_ID).length,
    addedAt: at >= 0 ? cols[at].addedAt : new Date().toISOString(),
  };
  return at >= 0 ? cols.map((c, i) => (i === at ? meta : c)) : [...cols, meta];
}

/**
 * Look a track up in a catalogue, place it, and hold it as a ghost. Reports
 * whether it landed, so the caller knows whether to close the result list.
 */
async function placeExternalCandidate(candidate: ExternalCandidate): Promise<boolean> {
  const pid = externalPid(candidate.id);
  if (trackPosition(pid)) {
    showTrackOnMap(pid);
    return true;
  }
  // Tempo, year and label are on the per-track and per-album endpoints rather
  // than in a search result, and all three carry weight in the placement, so
  // they are worth two more calls through the same limiter.
  const facts = await deezerTrackFacts(
    candidate.id,
    candidate.albumId,
    candidate.artist
  ).catch(() => ({}) as Awaited<ReturnType<typeof deezerTrackFacts>>);

  const input: ExternalTrackInput = {
    name: candidate.title,
    artist: candidate.artist,
    durationMs: candidate.durationMs,
    // Deezer reports 0 for a tempo it does not know, and deezerTrackFacts has
    // already dropped those: a zero here would be a real claim about the record.
    bpm: facts.bpm,
    year: facts.year,
    label: facts.label,
  };
  const placement = placeExternalTrack(input);
  if (!placement) {
    externalNotice = "The map is still building, so there is nowhere to place it yet.";
    return false;
  }

  const track: Track = {
    pid,
    trackId: 0,
    name: candidate.title,
    artist: candidate.artist,
    album: candidate.album,
    durationMs: candidate.durationMs ?? 0,
    playlists: [],
    external: true,
    projected: true,
    deezerId: candidate.id,
    ...(candidate.previewUrl || facts.previewUrl
      ? { previewUrl: facts.previewUrl ?? candidate.previewUrl }
      : {}),
    ...(facts.bpm ? { bpm: facts.bpm, source: { bpm: "deezer" } } : {}),
    ...(facts.year ? { year: facts.year } : {}),
    ...(facts.label ? { label: facts.label } : {}),
  };
  // Deezer states no genre, so the one shown is carried over from the tracks it
  // landed among — marked as such, since a stated genre is evidence and a
  // transferred one is an inference.
  if (placement.projection.genre) {
    track.genre = placement.projection.genre;
    track.source = { ...track.source, genre: "projected" };
  }

  externals.set(pid, { track, input, placement, added: false });
  externalNotice = "";
  syncGhosts();
  scatter?.focusOn(placement.x, placement.y);
  openTrackPopover(track);
  // The preview is already in hand, and one decode is what turns an estimate
  // made from metadata into one that has heard the record.
  void analyzeExternalTrack(pid);
  return true;
}

/**
 * Add a ghost to the library, keeping the coordinate it was projected to.
 *
 * This is the invariant the whole feature rests on: no re-fit, no new
 * embedding generation, and every existing dot left exactly where it was.
 */
async function addExternalTrack(pid: string): Promise<void> {
  const record = externals.get(pid);
  const embedding = liveEmbedding();
  if (!record || record.added || !embedding || pidToIndex.has(pid) || !library) return;

  record.track.collection = EXTERNAL_COLLECTION_ID;
  const next = attachProjectedTrack(embedding, record.track, {
    x: record.placement.x,
    y: record.placement.y,
    clusterId: record.placement.clusterId,
    vector: record.placement.vector,
  });
  record.added = true;
  adoptEmbedding(next);
  library = { ...library, collections: withExternalCollection(library) };

  scatter?.setCollections(library.collections ?? []);
  syncGhosts();
  renderCollections();
  renderCoverage();
  renderLegend();
  applyHighlight();
  if (popoverTrack?.pid === pid) renderTrackPopover();
  await saveLibrary(library);
}

/**
 * Hear the track, then place it again. Audio yields a timbre vector, which is a
 * feature nothing knew about when the track was placed from its metadata — but
 * it is one more row's worth of evidence, not grounds for re-laying out the
 * library, so the ghost slides and the map holds still.
 */
async function analyzeExternalTrack(pid: string): Promise<void> {
  const record = externals.get(pid);
  if (!record || record.track.timbre) return;
  if (!record.track.previewUrl && record.track.deezerId === undefined) return;
  if (await analyzeTrack(record.track)) reprojectExternalTrack(record);
}

function reprojectExternalTrack(record: ExternalTrackRecord): void {
  // Only a genuinely new measurement is worth moving a dot for; an analysis
  // pass that re-reports the same timbre should leave it alone.
  if (record.input.timbre === record.track.timbre) return;
  const input: ExternalTrackInput = {
    ...record.input,
    timbre: record.track.timbre,
    bpm: record.track.bpm ?? record.input.bpm,
    key: record.track.key ?? record.input.key,
  };
  const placement = placeExternalTrack(input);
  if (!placement) return;
  record.input = input;
  record.placement = placement;

  const embedding = liveEmbedding();
  if (record.added && embedding) {
    const next = reprojectAttachedTrack(embedding, record.track.pid, {
      x: placement.x,
      y: placement.y,
      clusterId: placement.clusterId,
      vector: placement.vector,
    });
    if (next) adoptEmbedding(next);
  }
  // The selection marker and the popover are both anchored to a position that
  // just changed, and neither of them is redrawn by the move itself.
  syncGhosts();
  if (popoverTrack?.pid === record.track.pid) renderTrackPopover();
  applyHighlight();
}

/** An analysis pass touched a track; if it was a projected one, re-place it. */
function noteExternalAnalysis(track: Track): void {
  const record = externals.get(track.pid);
  if (record) reprojectExternalTrack(record);
}

/**
 * A fresh embedding includes every track that was in it, projected ones
 * included, so their positions are fitted now rather than estimated. The ring
 * stays — that says the track came from outside, which does not change — but
 * the anchors that explained an estimate no longer explain anything.
 */
function rebasePlacedTracks(): void {
  for (const [pid, record] of externals) {
    if (record.added) {
      externals.delete(pid);
      continue;
    }
    const placement = placeExternalTrack(record.input);
    if (placement) record.placement = placement;
    else externals.delete(pid);
  }
  syncGhosts();
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
      onLasso: handleLasso,
    });
    scatter.setTheme(currentTheme());
  }
  scatter.setClusterLabels(clusterLabels);
  scatter.setCollections(library.collections ?? []);
  scatter.setData({ tracks: library.tracks, coords, clusters });
  // A ghost's coordinate belongs to the layout it was projected onto, which
  // this one has just replaced.
  rebasePlacedTracks();
  applyGapsVisibility();
  applyHighlight();
  fillHighlightItems();
  renderLegend();
  renderCoverage();
  updatePriority();
  if (tutorialAwaitEmbed) {
    tutorialAwaitEmbed = false;
    tutorialDelta(1);
  }
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
    if (!analysisRunning) {
      renderAnalysisIdle();
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

const gsbInput = $<HTMLInputElement>("gsb-key");
gsbInput.value = getSongBpmApiKey() ?? "";

/**
 * The key is optional, and saving it has no visible consequence: it promotes
 * GetSongBPM to the first lookup tier, which only shows itself during a run.
 * Without a word from the field, typing a key and typing nothing look the same.
 * The note clears itself after a moment — a confirmation that stays is read as
 * a label, and would go on claiming a save long after the fact.
 */
const GSB_NOTICE_MS = 2400;
let gsbNotice: number | undefined;
let gsbSavedKey = getSongBpmApiKey() ?? "";

function noteGsbKey(text: string): void {
  const el = $("gsb-key-status");
  el.textContent = text;
  if (gsbNotice !== undefined) clearTimeout(gsbNotice);
  gsbNotice = window.setTimeout(() => {
    el.textContent = "";
    gsbNotice = undefined;
  }, GSB_NOTICE_MS);
}

/**
 * `explicit` is Enter, which is a request for an answer and always gets one.
 * The blur-driven `change` event stays quiet when the value is what was already
 * saved, so committing the field after pressing Enter does not say it twice.
 */
function saveGsbKey(explicit: boolean): void {
  const next = gsbInput.value.trim();
  if (!explicit && next === gsbSavedKey) return;
  const outcome = saveSongBpmApiKey(next);
  gsbSavedKey = next;
  noteGsbKey(outcome === "saved" ? "Key saved" : "Key cleared");
}

gsbInput.addEventListener("change", () => saveGsbKey(false));
gsbInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveGsbKey(true);
});

const gsbProxyInput = $<HTMLInputElement>("gsb-proxy");
gsbProxyInput.value = getSongBpmProxy() ?? "";
gsbProxyInput.addEventListener("change", () => setSongBpmProxy(gsbProxyInput.value));

// ---------- combined sound + DSP analysis (§4 stage 2) ----------

/**
 * Analysis is on-demand and scoped to the viewport. One decoded audio excerpt
 * yields timbre, BPM, and key, so sound preview analysis and missing-metadata
 * analysis share one queue and one lifecycle.
 */
let analysisRunning = false;
let analysisRun = 0;
let analysisAbort: AbortController | null = null;
let audioDone = 0;
let audioTotal = 0;
let soundResolved = 0;
let soundTotal = 0;
let metadataResolved = 0;
let metadataTotal = 0;

function renderAnalysisProgress(): void {
  const parts: string[] = [];
  if (lookupRemaining > 0) {
    parts.push(`${lookupRemaining.toLocaleString()} online lookups remaining`);
  } else {
    parts.push("online lookups complete");
  }
  if (audioTotal > 0) {
    parts.push(`${audioDone.toLocaleString()} / ${audioTotal.toLocaleString()} audio`);
  }
  $("dsp-status").textContent = parts.join(" · ");
}

function renderAnalysisIdle(): void {
  if (!library) return;
  $("dsp-status").textContent = describeAnalysisNeeded(
    analysisNeededCount(library.tracks, scatter?.visiblePids() ?? [])
  );
}

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
async function analyzeTrack(t: Track, signal?: AbortSignal): Promise<boolean> {
  const source = await analysisSource(t);
  if (!source) return false;
  if (signal?.aborted) {
    if (source.kind === "file") URL.revokeObjectURL(source.url);
    return false;
  }
  dspPool ??= new DspPool();
  try {
    const r = await dspPool.analyze(t, source, signal);
    return !!r && !signal?.aborted && DspPool.apply(t, r);
  } finally {
    if (source.kind === "file") URL.revokeObjectURL(source.url);
  }
}

$("dsp-start").addEventListener("click", async () => {
  if (!library) return;
  const button = $("dsp-start");
  const status = $("dsp-status");
  if (analysisRunning) {
    analysisRunning = false;
    analysisRun++;
    analysisAbort?.abort();
    analysisAbort = null;
    queue?.stop();
    button.textContent = ANALYSIS_IDLE_LABEL;
    status.textContent = "stopped";
    return;
  }

  // The CTA was the click, including when nothing needs analysis. Waiting for
  // the run to finish would leave the cloud on a button that has already acted.
  if (tutorialOnTarget("dsp-start")) tutorialDelta(1);

  const targets = analysisTargets(library.tracks, scatter?.visiblePids() ?? []);
  const lookupTargets = analysisLookupTargets(library.tracks);
  const lookupTotal = lookupTargets.length;

  if (targets.length === 0 && lookupTotal === 0) {
    status.textContent = "nothing needs analysis";
    return;
  }

  const run = ++analysisRun;
  const controller = new AbortController();
  analysisAbort = controller;
  analysisRunning = true;
  button.textContent = ANALYSIS_STOP_LABEL;
  audioDone = 0;
  audioTotal = targets.length;
  soundResolved = 0;
  metadataResolved = 0;
  lookupRemaining = lookupTotal;
  soundTotal = targets.filter((target) => target.needsSound).length;
  metadataTotal = targets.filter((target) => target.needsMetadata).length;
  renderAnalysisProgress();

  // A stopped queue may still be waiting for its one in-flight network request
  // to settle. Serialize restarts so the same queue is never started twice.
  const previousLookups = lookupSettled;
  const lookupWork = previousLookups
    .catch(() => undefined)
    .then(async () => {
      if (!analysisRunning || run !== analysisRun || !queue) return;
      queue.refill(lookupTargets);
      lookupRemaining = queue.remaining;
      await queue.start();
    });
  lookupSettled = lookupWork.catch(() => undefined);

  const audioWork = (async () => {
    for (const target of targets) {
      if (!analysisRunning || run !== analysisRun) break;
      const changed = await analyzeTrack(target.track, controller.signal);
      if (run !== analysisRun) return;
      if (changed) {
        scatter?.update();
        noteExternalAnalysis(target.track);
        if (popoverTrack?.pid === target.track.pid) renderTrackPopover();
      }
      if (target.needsSound && target.track.timbre) soundResolved++;
      if (target.needsMetadata && target.track.bpm && target.track.key) metadataResolved++;
      audioDone++;
      renderAnalysisProgress();
      if (audioDone % 20 === 0) {
        void saveLibrary(library);
        renderCoverage();
        renderLegend();
      }
    }
  })();

  await Promise.all([lookupWork, audioWork]);
  if (run !== analysisRun) return;

  void saveLibrary(library);
  renderCoverage();
  renderLegend();
  status.textContent =
    `done — ${(lookupTotal - lookupRemaining).toLocaleString()} online lookups` +
    ` · ${audioDone.toLocaleString()} audio analyzed` +
    (soundTotal ? ` · sound ${soundResolved} / ${soundTotal}` : "") +
    (metadataTotal ? ` · BPM/key ${metadataResolved} / ${metadataTotal}` : "");
  analysisRunning = false;
  analysisAbort = null;
  button.textContent = ANALYSIS_IDLE_LABEL;
});

/** Analyze a single track immediately — used when you pin or queue one. */
async function analyzeOne(t: Track): Promise<void> {
  if (t.bpm && t.key) return;
  if (await analyzeTrack(t)) {
    scatter?.update();
    renderCoverage();
    noteExternalAnalysis(t);
    if (popoverTrack?.pid === t.pid) renderTrackPopover();
    if (library) void saveLibrary(library);
  }
}

// ---------- collections + comparison ----------

function collectionSwatch(i: number): string {
  const c = collectionColor(i);
  return `<span class="coll-dot" style="background: rgb(${c.join(",")})"></span>`;
}

function collectionFormatLabel(format: CollectionFormat): string {
  if (format === "rekordbox-txt") return "rekordbox TXT";
  return format;
}

function renderCollections(): void {
  const list = $("collection-list");
  const cols = library?.collections ?? [];
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
        <span class="muted small">${collectionFormatLabel(c.format)} · ${
          c.sampledFrom
            ? `${c.trackCount.toLocaleString()} of ${c.sampledFrom.toLocaleString()} sampled`
            : c.trackCount.toLocaleString()
        }</span>
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
      coverageRow("Label", r.labelCount, r.total) +
      coverageRow("Sound", r.sound, r.total) +
      coverageRow("Preview", r.preview, r.total) +
      // Only meaningful once a folder is connected; otherwise it is a row of
      // zeroes reporting on something that was never switched on.
      (musicFolder ? coverageRow("Files", r.local, r.total) : "")
    );
  });
  $("coverage").innerHTML = parts.join("");
  $("enrich-scope").textContent = "";
  syncSoundInfluence(rows);
  syncLabelInfluence(rows);
  syncPlaylistInfluence(rows);

  const stats = getSourceStats();
  $("source-stats").innerHTML = Object.entries(stats)
    .map(
      // `skipped` distinguishes a tier that had nothing left to answer from one
      // that has stopped answering; under per-field routing both read as 0 calls.
      ([name, s]) =>
        `<div>${name}: ${s.calls} calls · ${s.hits} hit · ${s.misses} miss · ` +
        `${s.errors} err · ${s.skipped} skipped</div>`
    )
    .join("");
  if (!analysisRunning) renderAnalysisIdle();
}

function syncSoundInfluence(rows: CollectionCoverage[]): void {
  const { enabled, note } = describeSoundInfluence(rows);
  $<HTMLInputElement>("timbre-slider").disabled = !enabled;
  $("timbre-note").textContent = note;
}

function syncLabelInfluence(rows: CollectionCoverage[]): void {
  const { enabled, note } = describeLabelInfluence(rows);
  $<HTMLInputElement>("label-slider").disabled = !enabled;
  $("label-note").textContent = note;
}

function syncPlaylistInfluence(rows: CollectionCoverage[]): void {
  const total = rows.reduce((n, r) => n + r.total, 0);
  const filed = library?.tracks.filter((t) => t.playlists.length > 0).length ?? 0;
  const { enabled, note } = describePlaylistInfluence(
    library?.playlists.length ?? 0,
    filed,
    total
  );
  $<HTMLInputElement>("playlist-slider").disabled = !enabled;
  $("playlist-note").textContent = note;
}

$("retry-misses").addEventListener("click", async () => {
  const removed = await clearCachedMisses();
  $("source-stats").innerHTML = `<div>cleared ${removed.toLocaleString()} cached misses — analyze songs again</div>`;
  if (library && queue) {
    queue.refill(library.tracks.filter(needsLookup));
    lookupRemaining = queue.remaining;
    renderAnalysisIdle();
  }
});

// ---------- hover tooltip ----------

const tooltip = $("tooltip");

function currentNeighbors(track: Track): Neighbor[] {
  if (!neighborIndex) return [];
  // A ghost is not a row in the index until it is added, but it already has a
  // vector in the same space, so the ordinary five-neighbour query still works.
  const record = externals.get(track.pid);
  if (record && !pidToIndex.has(track.pid)) {
    return neighborIndex.nearestToVector(
      record.placement.vector,
      neighborCollection,
      5
    );
  }
  return neighborIndex.nearest(track.pid, neighborCollection, 5);
}

function neighborCollectionLabel(): string {
  if (!neighborCollection || !library) return "all collections";
  return (
    library.collections?.find((collection) => collection.id === neighborCollection)
      ?.label ?? "all collections"
  );
}

function hoverNeighborPreview(track: Track): string {
  if (!neighborIndex) return "";
  const neighbors = currentNeighbors(track);
  if (neighbors.length === 0) {
    return `<div class="neighbor-preview muted">No similar tracks in ${esc(neighborCollectionLabel())}.</div>`;
  }
  const shown = neighbors.slice(0, 2);
  const more = neighbors.length - shown.length;
  return `
    <div class="neighbor-preview">
      <div class="neighbor-preview-title">Similar in ${esc(neighborCollectionLabel())}</div>
      ${shown
        .map(
          ({ track: neighbor }) =>
            `<div><span>${esc(neighbor.name)}</span><span class="muted"> — ${esc(neighbor.artist ?? "Unknown artist")}</span></div>`
        )
        .join("")}
      ${more > 0 ? `<div class="muted">+${more} more — click to view</div>` : ""}
    </div>`;
}

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
      ${track.label ? `<span class="badge">${esc(track.label)}</span>` : ""}
      ${track.year ? `<span class="badge">${track.year}</span>` : ""}
      ${browsing ? `<span class="badge audio-badge">${isPlayable(track) ? (localByPid.has(track.pid) ? "file" : "preview") : "no audio"}</span>` : ""}
    </div>
    ${hoverNeighborPreview(track)}
  `;
}

function handleClick(track: Track | null): void {
  setAutoplayNote(false);
  if (track) {
    openTrackPopover(track);
    tutorialAdvanceIfTarget("scatter-canvas");
  } else {
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
  // The search and toolbar occupy the map's top row. A tall similar-track list
  // otherwise clamps to y=8 and sits underneath them even though it scrolls.
  const topClearance = 54;
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
  el.style.top = `${Math.max(topClearance, Math.min(top, vh - ph - 8))}px`;
}

function repositionPopovers(): void {
  if (popoverTrack) {
    const at = trackPosition(popoverTrack.pid);
    if (at) anchorPopover($("track-popover"), at[0], at[1]);
  }
  if (popoverGap) anchorPopover($("gap-popover"), popoverGap.x, popoverGap.y);
  repositionInfoPopups();
  if (tutorialOn) placeTutorialClouds();
}

window.addEventListener("resize", repositionPopovers);

// ---------- track popover (detail + manual overrides, §4 stage 3) ----------

let popoverTrack: Track | null = null;

function openTrackPopover(track: Track): void {
  popoverTrack = track;
  scatter?.setSelectedTrack(track.pid);
  tooltip.hidden = true;
  closeGapPopover();
  renderTrackPopover();
  applyHighlight();
}

function closeTrackPopover(): void {
  popoverTrack = null;
  scatter?.setSelectedTrack(null);
  $("track-popover").hidden = true;
  applyHighlight();
}

/**
 * The close button on a ghost that was never added means the user is done
 * looking at it: take the dot off the map rather than leaving a mark they
 * chose not to keep.
 */
function dismissTrackPopover(): void {
  const pid = popoverTrack?.pid;
  const record = pid ? externals.get(pid) : undefined;
  const drop = Boolean(record && !record.added);
  closeTrackPopover();
  if (!drop || !pid) return;
  externals.delete(pid);
  syncGhosts();
  applyHighlight();
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderNeighborSection(track: Track): string {
  const collections = library?.collections ?? [];
  const selector =
    collections.length > 1
      ? `<select id="neighbor-collection" aria-label="Recommend from collection">
          <option value=""${neighborCollection === null ? " selected" : ""}>All collections</option>
          ${collections
            .map(
              (collection) =>
                `<option value="${esc(collection.id)}"${neighborCollection === collection.id ? " selected" : ""}>${esc(collection.label)}</option>`
            )
            .join("")}
        </select>`
      : "";

  if (!neighborIndex) {
    return `<hr />
      <section class="similar-tracks">
        <div class="similar-head"><strong>Similar tracks</strong>${selector}</div>
        <div class="small muted">Available when the map finishes embedding.</div>
      </section>`;
  }

  const neighbors = currentNeighbors(track);
  const showCollection = neighborCollection === null && collections.length > 1;
  return `<hr />
    <section class="similar-tracks">
      <div class="similar-head"><strong>Similar tracks</strong>${selector}</div>
      ${
        neighbors.length > 0
          ? `<div class="neighbor-list">${neighbors
              .map(
                ({ track: neighbor }) =>
                  `<button type="button" class="neighbor-hit" data-neighbor-pid="${esc(neighbor.pid)}">
                    <span class="neighbor-name">${esc(neighbor.name)}</span>
                    <span class="neighbor-meta">${esc(neighbor.artist ?? "Unknown artist")}${
                      showCollection
                        ? ` · ${esc(
                            collections.find(
                              (collection) => collection.id === neighbor.collection
                            )?.label ?? "Imported library"
                          )}`
                        : ""
                    }</span>
                  </button>`
              )
              .join("")}</div>`
          : `<div class="small muted">No other tracks are available in ${esc(neighborCollectionLabel())}.</div>`
      }
    </section>`;
}

function renderTrackPopover(): void {
  const t = popoverTrack;
  if (!t) return;
  const el = $("track-popover");
  el.hidden = false;
  el.dataset.trackPid = t.pid;
  const record = externals.get(t.pid);
  const inLibrary = pidToIndex.has(t.pid);

  const hasFile = localByPid.has(t.pid);
  const sharedName = localResolution?.ambiguous.get(t.pid)?.length ?? 0;
  // Always offered, because whether audio exists is not known until it is asked
  // for. A rekordbox export arrives with BPM and key filled, so the enrichment
  // queue never visits it and no track ever gains a stored previewUrl, yet
  // resolvePreviewUrl finds audio for these on demand perfectly well. The
  // button used to be rendered only when a URL had already been stored, which
  // on that library meant never.
  const audio = hasFile
    ? { label: "Play file", hint: "Play the file in your music folder" }
    : t.previewUrl
      ? { label: "Play preview", hint: "Play the 30-second preview" }
      : {
          label: "Find audio",
          hint: "No preview has been looked up for this track yet. This goes and looks, which can take a few seconds.",
        };

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
      ${t.external ? `<span class="badge external">outside your library</span>` : ""}
      ${
        t.genre
          ? `<span class="badge">${esc(t.genre)}${
              t.source?.genre === "projected" ? " (from its neighbours)" : ""
            }</span>`
          : ""
      }
      ${t.label ? `<span class="badge">Label: ${esc(t.label)}</span>` : ""}
      ${t.year ? `<span class="badge">${t.year}</span>` : ""}
      ${t.durationMs ? `<span class="badge">${fmtDuration(t.durationMs)}</span>` : ""}
      ${t.bpmSuspect ? `<span class="badge warn">maybe half-time</span>` : ""}
      ${hasFile ? `<span class="badge">local file</span>` : ""}
      ${sharedName > 1 ? `<span class="badge warn" title="Left unmatched rather than guessed">${sharedName} files share this name</span>` : ""}
    </div>
    ${t.projected ? `<div class="small muted ghost-note">${esc(ESTIMATED_NOTE)}</div>` : ""}
    <hr />
    ${
      inLibrary
        ? `<div class="row"><span>BPM</span><input id="ov-bpm" type="number" step="0.1" value="${t.bpm ? Math.round(t.bpm * 10) / 10 : ""}" /></div>
           <div class="row"><span>Key</span><input id="ov-key" type="text" placeholder="8A / Am" value="${t.key ?? ""}" /></div>`
        : `<div class="small">
             <span class="badge">${t.bpm ? `${Math.round(t.bpm)} BPM` : "BPM unknown"}</span>
             <span class="badge">${t.key ? camelotDisplay(t.key) : "key unknown"}</span>
           </div>`
    }
    <div class="small">${derived("bpm")}${derived("key")}</div>
    <div class="actions track-actions">
      <div class="actions-side">
        ${inLibrary ? `<button id="ov-save" class="primary">Save edits</button>` : ""}
        ${
          record && !record.added
            ? `<button id="add-external" class="primary">Add to Searches</button>`
            : ""
        }
      </div>
      <div class="play-pair">
        <button type="button" id="play-audio" title="${esc(audio.hint)}" aria-label="Play">▶</button>
      </div>
      <div class="actions-side right">
        <button id="add-to-set">Add to set</button>
      </div>
    </div>
    ${
      record?.added
        ? `<div class="small muted">Kept in ${esc(EXTERNAL_COLLECTION_LABEL)}.</div>`
        : ""
    }
    <div id="playback-note" class="small muted"></div>
    ${renderNeighborSection(t)}
  `;

  el.querySelector<HTMLButtonElement>(".close")!.addEventListener("click", dismissTrackPopover);
  el
    .querySelector<HTMLSelectElement>("#neighbor-collection")
    ?.addEventListener("change", (event) => {
      neighborCollection = (event.currentTarget as HTMLSelectElement).value || null;
      renderTrackPopover();
    });
  el.querySelectorAll<HTMLButtonElement>(".neighbor-hit").forEach((button) => {
    button.addEventListener("click", () => focusTrack(button.dataset.neighborPid!));
  });

  el.querySelector("#add-external")?.addEventListener("click", () => {
    void addExternalTrack(t.pid);
  });

  // Manual overrides are keyed on pid and applied at import, so they are only
  // offered for a track the library actually holds.
  el.querySelector("#ov-save")?.addEventListener("click", async () => {
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

  $("add-to-set").addEventListener("click", () => appendToSet(t));

  $("play-audio").addEventListener("click", () => {
    if (clickTransportOn(t.pid)) stopPlayback();
    else void playTrack(t, "click");
  });

  renderPlayback();

  const at = trackPosition(t.pid);
  if (at) anchorPopover(el, at[0], at[1]);
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

const LEGEND_KEY = "onkio.legend";

/**
 * The legend puts itself away rather than being switched off from the toolbar.
 * It collapses to its own title bar instead of vanishing, because the control
 * that brings it back lives on it: hiding it outright would leave no way in.
 */
function setLegendCollapsed(collapsed: boolean): void {
  $("legend").classList.toggle("collapsed", collapsed);
  localStorage.setItem(LEGEND_KEY, collapsed ? "collapsed" : "expanded");
  const btn = $("legend-collapse");
  btn.textContent = collapsed ? "▸" : "▾";
  btn.title = collapsed ? "Show the legend" : "Minimize the legend";
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-expanded", String(!collapsed));
}

setLegendCollapsed(localStorage.getItem(LEGEND_KEY) === "collapsed");

$("legend-collapse").addEventListener("click", () => {
  setLegendCollapsed(!$("legend").classList.contains("collapsed"));
});

function renderLegend(): void {
  const el = $("legend");
  const entries = scatter?.legendEntries() ?? [];
  if (entries.length === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const mode = $<HTMLSelectElement>("color-mode").value;
  const titles: Record<string, string> = {
    cluster: "Clusters",
    collection: "Collections",
    genre: "Genres",
    bpm: "BPM",
    key: "Key (Camelot)",
    year: "Decade",
  };
  $("legend-title").textContent = titles[mode] ?? "Legend";

  const shown = entries.slice(0, 16);
  const omitted = entries.slice(shown.length);
  const hiddenCount = omitted.length;
  const hiddenTracks = omitted.reduce((sum, entry) => sum + entry.count, 0);
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
    (hiddenCount > 0
      ? `<div class="legend-row muted small">+${hiddenCount} more${mode === "genre" ? ` genres · ${hiddenTracks.toLocaleString()} tracks` : ""}</div>`
      : "");
}

// ---------- set builder (§7.1) ----------

const SET_PANEL_KEY = "onkio.setPanel";

/**
 * The set builder is a panel rather than a tab because building a set is done
 * against the map: as a tab it hid the thing every entry comes from, so adding a
 * track meant leaving the map, and a lasso would have had nowhere to land.
 */
function setPanelOpen(open: boolean): void {
  $("app").classList.toggle("set-open", open);
  $("set-panel").hidden = !open;
  setToggleState("set-toggle", open);
  $("set-toggle").setAttribute("aria-expanded", String(open));
  localStorage.setItem(SET_PANEL_KEY, open ? "shown" : "hidden");
  // The map's column just changed width; the canvas follows, and so must
  // anything anchored to a point in it. The sparkline is sized from its box.
  requestAnimationFrame(() => {
    repositionPopovers();
    drawSparkline();
  });
}

function setPanelIsOpen(): boolean {
  return $("app").classList.contains("set-open");
}

setPanelOpen(localStorage.getItem(SET_PANEL_KEY) === "shown");

$("set-toggle").addEventListener("click", () => {
  const open = !setPanelIsOpen();
  setPanelOpen(open);
  if (open) tutorialAdvanceIfTarget("set-toggle");
});
$("set-close").addEventListener("click", () => setPanelOpen(false));

$("suggest-toggle").addEventListener("change", (e) => {
  suggestionMode = (e.target as HTMLInputElement).checked;
  applyHighlight();
});
$("set-clear").addEventListener("click", () => {
  setList.length = 0;
  renderSet();
});

/** Append one deliberate choice, and show the panel it landed in. */
function appendToSet(t: Track): void {
  setList.push(t);
  renderSet();
  setPanelOpen(true);
  // A track in a set needs BPM and key to be mixable at all, so earn them now.
  void analyzeOne(t);
}

// ---------- lasso ----------

/**
 * How many fresh tracks a single lasso may kick analysis off for. A region can
 * hold hundreds, and each one that is missing BPM or key costs a lookup and an
 * audio fetch; a gesture meant to fill a set should not become a download queue.
 */
const LASSO_ANALYZE_LIMIT = 12;

let lassoMode = false;
let lassoFeedbackTimer: number | undefined;

function setLassoMode(on: boolean): void {
  lassoMode = on;
  setToggleState("lasso-toggle", on);
  scatter?.setLassoMode(on);
  // How to draw is on the button, as a tooltip. What a gesture found is not: it
  // is news, and it is only news for as long as the gesture is recent.
  setLassoFeedback(null);
}

/**
 * The live count while a loop is being drawn, and the outcome once it lands.
 * "Nothing inside that loop" in particular is the only thing separating a
 * gesture that caught nothing from a control that did nothing, so it is spoken
 * as well as shown.
 */
function setLassoFeedback(text: string | null, holdMs = 0): void {
  window.clearTimeout(lassoFeedbackTimer);
  const el = $("lasso-feedback");
  el.textContent = text ?? "";
  el.hidden = text === null;
  if (text !== null && holdMs > 0) {
    lassoFeedbackTimer = window.setTimeout(() => setLassoFeedback(null), holdMs);
  }
}

$("lasso-toggle").addEventListener("click", () => setLassoMode(!lassoMode));

/**
 * A drawn region, turned into set entries. Tracks already in the set are left
 * alone rather than added twice: a lasso is a gesture at a neighbourhood, and
 * two overlapping sweeps are how it is normally used.
 */
function handleLasso(indices: number[], done: boolean): void {
  if (!library) return;
  if (!done) {
    setLassoFeedback(indices.length > 0 ? counted(indices.length, "track") : null);
    return;
  }
  if (indices.length === 0) {
    setLassoFeedback("Nothing inside that loop", 2400);
    return;
  }
  const present = new Set(setList.map((t) => t.pid));
  const fresh = indices.map((i) => library!.tracks[i]).filter((t) => !present.has(t.pid));
  const already = indices.length - fresh.length;
  if (fresh.length === 0) {
    setLassoFeedback(`${counted(already, "track")} already in the set`, 2600);
    return;
  }
  setList.push(...orderForSet(fresh));
  renderSet();
  setPanelOpen(true);
  for (const t of fresh.filter((t) => !t.bpm || !t.key).slice(0, LASSO_ANALYZE_LIMIT)) {
    void analyzeOne(t);
  }
  setLassoFeedback(
    `Added ${counted(fresh.length, "track")}${already > 0 ? `, ${already} already there` : ""}`,
    2600
  );
}
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

/** The row being dragged, by its index at the time the drag started. */
let dragFrom: number | null = null;

/** Reorder in place: `setList` is shared, and callers hold the reference. */
function reorderSet(from: number, to: number): void {
  const next = moveItem(setList, from, to);
  setList.splice(0, setList.length, ...next);
}

function clearDropMarks(): void {
  for (const el of document.querySelectorAll("#set-list li")) {
    el.classList.remove("drop-before", "drop-after", "dragging");
  }
}

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
    li.draggable = true;
    // Reachable and movable without a pointer: a drag-only reorder cannot be
    // done by keyboard at all, and Alt+arrows are what list editors bind.
    li.tabIndex = 0;
    li.title = "Drag to move, or hold Alt and press ↑ or ↓";
    li.innerHTML = `
      <span class="handle" aria-hidden="true">⠿</span>
      <div class="grow">
        <div class="title">${esc(t.artist ?? "?")} — ${esc(t.name)}</div>
        <div class="meta muted">${t.key ? camelotDisplay(t.key) : "?"} · ${t.bpm ? Math.round(t.bpm) + " BPM" : "?"}${t.source?.bpm ? " · " + esc(t.source.bpm) : ""}</div>
        ${warnText ? `<div class="warnings">⚠ ${warnText}</div>` : ""}
      </div>
      <button class="play" type="button" data-pid="${esc(t.pid)}" title="Play" aria-label="Play">▶</button>
      <button class="remove" title="Remove from the set" aria-label="Remove from the set">✕</button>
    `;
    li.querySelector(".play")!.addEventListener("click", (e) => {
      e.stopPropagation();
      if (clickTransportOn(t.pid)) stopPlayback();
      else void playTrack(t, "click");
    });
    li.querySelector(".remove")!.addEventListener("click", () => {
      setList.splice(i, 1);
      renderSet();
    });

    li.addEventListener("dragstart", (e) => {
      dragFrom = i;
      li.classList.add("dragging");
      // Firefox starts no drag at all without payload, and the move effect is
      // what stops the cursor claiming a copy is being made.
      e.dataTransfer?.setData("text/plain", t.pid);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e) => {
      if (dragFrom === null) return;
      e.preventDefault(); // the default is to refuse the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const box = li.getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      li.classList.toggle("drop-before", !below && dragFrom !== i);
      li.classList.toggle("drop-after", below && dragFrom !== i);
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-before", "drop-after");
    });
    li.addEventListener("drop", (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      const box = li.getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      // The row is lifted out before it is put back, so a destination below the
      // origin has already shifted up by one by the time it is inserted.
      let to = i + (below ? 1 : 0);
      if (dragFrom < to) to -= 1;
      const from = dragFrom;
      dragFrom = null;
      clearDropMarks();
      if (from === to) return;
      reorderSet(from, to);
      renderSet();
      focusSetRow(to);
    });
    li.addEventListener("dragend", () => {
      dragFrom = null;
      clearDropMarks();
    });

    li.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const to = i + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= setList.length) return;
      reorderSet(i, to);
      renderSet();
      focusSetRow(to);
    });

    list.appendChild(li);
  });

  const empty = setList.length === 0;
  $("set-empty").hidden = !empty;
  // A zero beside the name is noise; the count earns its place once there is one.
  $("set-count").textContent = empty ? "" : String(setList.length);
  for (const id of ["export-m3u8", "export-text", "set-clear"]) {
    $<HTMLButtonElement>(id).disabled = empty;
  }
  drawSparkline();
  applyHighlight();
  renderPlayback();
}

/** Keep the moved row under the keyboard, since rendering replaced the element. */
function focusSetRow(i: number): void {
  const row = $("set-list").children[i];
  if (row instanceof HTMLElement) row.focus();
}

function drawSparkline(): void {
  const canvas = $<HTMLCanvasElement>("sparkline");
  // Sized from its box rather than from a fixed attribute, because the panel is
  // narrower than the tab it replaced and a stale width stretches the drawing.
  const width = Math.max(1, Math.round(canvas.clientWidth || canvas.width));
  if (canvas.width !== width) canvas.width = width;
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
  ctx.font = '10px "DM Mono", monospace';
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

$<HTMLInputElement>("label-slider").addEventListener("change", () => {
  runEmbedding();
});

$<HTMLInputElement>("playlist-slider").addEventListener("change", () => {
  runEmbedding();
});

$<HTMLSelectElement>("highlight-kind").addEventListener("change", () => {
  fillHighlightItems();
  applyHighlight();
});
$<HTMLSelectElement>("highlight-item").addEventListener("change", applyHighlight);

let highlightBpmScale: BpmScale = DEFAULT_BPM_SCALE;

function fillHighlightItems(): void {
  const kind = $<HTMLSelectElement>("highlight-kind").value;
  const item = $<HTMLSelectElement>("highlight-item");
  const prev = item.value;
  item.replaceChildren();
  if (!kind || !library) {
    item.disabled = true;
    item.append(new Option("—", ""));
    return;
  }
  item.disabled = false;
  item.append(new Option("— none —", ""));
  for (const option of highlightItemOptions(kind)) {
    item.append(new Option(option.label, option.value));
  }
  if ([...item.options].some((o) => o.value === prev)) item.value = prev;
}

function highlightItemOptions(kind: string): { value: string; label: string }[] {
  if (!library) return [];
  switch (kind) {
    case "playlist":
      return library.playlists.map((p) => ({
        value: p.name,
        label: `${p.name} (${p.pids.length})`,
      }));
    case "cluster": {
      if (!clusters) return [];
      const counts = new Map<number, number>();
      for (let i = 0; i < clusters.length; i++) {
        counts.set(clusters[i], (counts.get(clusters[i]) ?? 0) + 1);
      }
      return [...counts.keys()]
        .sort((a, b) => a - b)
        .map((c) => ({
          value: String(c),
          label: `${clusterLabels.get(c) ?? `Cluster ${c + 1}`} (${counts.get(c)})`,
        }));
    }
    case "collection":
      return (library.collections ?? []).map((c) => ({
        value: c.id,
        label: `${c.label} (${c.trackCount})`,
      }));
    case "genre": {
      const counts = new Map<string, { label: string; n: number }>();
      for (const t of library.tracks) {
        const g = normalizeGenre(t.genre);
        if (!g) continue;
        const cur = counts.get(g.key) ?? { label: g.label, n: 0 };
        cur.n += 1;
        counts.set(g.key, cur);
      }
      return [...counts]
        .sort((a, b) => b[1].n - a[1].n || a[1].label.localeCompare(b[1].label))
        .map(([key, v]) => ({ value: key, label: `${v.label} (${v.n})` }));
    }
    case "bpm": {
      highlightBpmScale = makeBpmScale(
        library.tracks.map((t) => t.bpm).filter((b): b is number => b != null && b > 0)
      );
      const counts = new Array<number>(highlightBpmScale.count).fill(0);
      for (const t of library.tracks) {
        if (t.bpm) counts[bpmBin(t.bpm, highlightBpmScale)] += 1;
      }
      return counts.flatMap((n, i) =>
        n > 0
          ? [{ value: String(i), label: `${bpmBinLabel(i, highlightBpmScale)} (${n})` }]
          : []
      );
    }
    case "year": {
      const counts = new Map<number, number>();
      for (const t of library.tracks) {
        if (!t.year) continue;
        const d = decadeOf(t.year);
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      return [...counts.keys()]
        .sort((a, b) => a - b)
        .map((d) => ({ value: String(d), label: `${d}s (${counts.get(d)})` }));
    }
    default:
      return [];
  }
}

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
  const kind = $<HTMLSelectElement>("highlight-kind").value;
  const value = $<HTMLSelectElement>("highlight-item").value;
  if (!library || !kind || !value) return null;
  const tracks = library.tracks;
  let pids: string[] = [];
  let label = "";
  switch (kind) {
    case "playlist": {
      const pl = library.playlists.find((p) => p.name === value);
      if (!pl) return null;
      pids = pl.pids;
      label = `${counted(pids.length, "track")} in "${value}"`;
      break;
    }
    case "cluster": {
      if (!clusters) return null;
      const c = Number(value);
      pids = tracks.filter((_, i) => clusters![i] === c).map((t) => t.pid);
      label = `${counted(pids.length, "track")} in ${clusterLabels.get(c) ?? `cluster ${c + 1}`}`;
      break;
    }
    case "collection":
      pids = tracks.filter((t) => t.collection === value).map((t) => t.pid);
      label = `${counted(pids.length, "track")} in that collection`;
      break;
    case "genre":
      pids = tracks.filter((t) => normalizeGenre(t.genre)?.key === value).map((t) => t.pid);
      label = `${counted(pids.length, "track")} in that genre`;
      break;
    case "bpm": {
      const bin = Number(value);
      pids = tracks
        .filter((t) => t.bpm != null && bpmBin(t.bpm, highlightBpmScale) === bin)
        .map((t) => t.pid);
      label = `${counted(pids.length, "track")} in that BPM range`;
      break;
    }
    case "year": {
      const d = Number(value);
      pids = tracks
        .filter((t) => t.year != null && decadeOf(t.year) === d)
        .map((t) => t.pid);
      label = `${counted(pids.length, "track")} from the ${d}s`;
      break;
    }
    default:
      return null;
  }
  if (pids.length === 0) return null;
  return {
    source: "playlist",
    label,
    name: "the highlight filter",
    pids,
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
    anchorHighlight(),
    suggestionHighlight(),
    playlistHighlight(),
  ]);
  scatter?.setHighlight(active?.pids ?? [], active !== null);
  $("highlight-status").textContent = active?.note ?? "";
}

/** The library tracks that pulled a projected one onto the map. */
function anchorHighlight(): HighlightRequest | null {
  if (!popoverTrack) return null;
  const record = externals.get(popoverTrack.pid);
  if (!record || record.added) return null;
  const pids = currentNeighbors(popoverTrack).map((neighbor) => neighbor.track.pid);
  if (pids.length === 0) return null;
  return {
    source: "anchors",
    label: `${counted(pids.length, "similar track")}`,
    name: "the placed track",
    pids,
  };
}

// ---------- search ----------

const SEARCH_LIST_LIMIT = 20;

const searchInput = $<HTMLInputElement>("track-search");
const searchResults = $("search-results");
let searchHits: SearchResults = { matches: [], shown: [] };
let searchTimer: number | undefined;
/** A chosen result closes the menu without throwing away the standing search. */
let searchResultsDismissed = false;
/** Catalogue search is opt-in and survives a re-render of the same query. */
let externalSearch: ExternalSearchState = EXTERNAL_SEARCH_OFF;

searchInput.addEventListener("input", () => {
  // A keystroke rescans the library and rewrites the map's highlight, so it
  // waits for a pause in typing rather than running per character.
  window.clearTimeout(searchTimer);
  searchResultsDismissed = nextSearchMenuDismissed(searchResultsDismissed, "query-changed");
  scatter?.setExternalHover(null);
  // Do not leave candidates for the previous query actionable during debounce.
  searchResults.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
  searchTimer = window.setTimeout(runSearch, 120);
});

searchInput.addEventListener("focus", () => {
  if (!searchInput.value.trim()) return;
  searchResultsDismissed = nextSearchMenuDismissed(searchResultsDismissed, "search-focused");
  renderSearchResults(searchInput.value.trim());
});

searchInput.addEventListener("keydown", (e) => {
  // The global handler ignores keys typed into inputs, so Escape only reaches
  // the search from here.
  if (e.key === "Escape") clearSearch();
});

function searchHit(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof Element ? target.closest<HTMLButtonElement>(".search-hit") : null;
}

// Delegated once: rendering replaces candidate buttons on every query.
searchResults.addEventListener("pointerover", (event) => {
  scatter?.setExternalHover(searchHit(event.target)?.dataset.pid ?? null);
});
searchResults.addEventListener("pointerleave", () => {
  // Closing the list after a click fires leave; do not wipe the pulse we just set.
  if (!searchResults.hidden) scatter?.setExternalHover(null);
});
searchResults.addEventListener("focusin", (event) => {
  scatter?.setExternalHover(searchHit(event.target)?.dataset.pid ?? null);
});
searchResults.addEventListener("focusout", (event) => {
  if (searchResults.hidden) return;
  if (!searchHit(event.relatedTarget)) scatter?.setExternalHover(null);
});
searchResults.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-external-search]")) {
    void runExternalSearch();
    return;
  }
  const hit = searchHit(event.target);
  if (!hit) return;
  const external = hit.dataset.externalIndex;
  if (external !== undefined) {
    void chooseExternal(Number(external));
    return;
  }
  const pid = hit.dataset.pid;
  if (!pid) return;
  showTrackOnMap(pid);
  dismissSearchResults();
});

function runSearch(): void {
  window.clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  searchHits =
    library && query
      ? searchTracks(library.tracks, query, SEARCH_LIST_LIMIT)
      : { matches: [], shown: [] };
  externalSearch = query
    ? nextExternalSearch(externalSearch, {
        kind: "local",
        query,
        matches: searchHits.matches.length,
      })
    : nextExternalSearch(externalSearch, { kind: "cleared" });
  renderSearchResults(query);
  applyHighlight();
}

function clearSearch(): void {
  searchResultsDismissed = nextSearchMenuDismissed(searchResultsDismissed, "cleared");
  scatter?.setExternalHover(null);
  if (!searchInput.value) {
    externalSearch = nextExternalSearch(externalSearch, { kind: "cleared" });
    renderSearchResults("");
    return;
  }
  searchInput.value = "";
  runSearch();
}

/**
 * Ask Deezer for the current query. Opt-in by design: it runs from the button
 * in the result list, never from typing, so no keystroke reaches the network.
 */
async function runExternalSearch(): Promise<void> {
  const query = searchInput.value.trim();
  if (!query) return;
  externalSearch = nextExternalSearch(externalSearch, { kind: "requested", query });
  renderSearchResults(query);
  try {
    const hits = await searchDeezerTracks(query, EXTERNAL_RESULT_LIMIT);
    const candidates = markLocalDuplicates(
      hits.map((hit) => ({
        id: hit.id,
        title: hit.title,
        artist: hit.artist,
        album: hit.album,
        albumId: hit.albumId,
        durationMs: hit.durationMs,
        previewUrl: hit.previewUrl,
      })),
      localTitleIndex(library?.tracks ?? [])
    );
    externalSearch = nextExternalSearch(externalSearch, {
      kind: "found",
      query,
      candidates,
    });
  } catch (err) {
    externalSearch = nextExternalSearch(externalSearch, {
      kind: "failed",
      query,
      reason: err instanceof Error ? err.message : "the request failed",
    });
  }
  renderSearchResults(searchInput.value.trim());
}

/**
 * A result that turned out to be something the user already owns opens their
 * own copy: a second dot for the same track would be a lie about the library.
 */
async function chooseExternal(index: number): Promise<void> {
  if (externalSearch.kind !== "results") return;
  const candidate = externalSearch.candidates[index];
  if (!candidate) return;
  if (candidate.localPid) {
    showTrackOnMap(candidate.localPid);
    dismissSearchResults();
    return;
  }
  dismissSearchResults();
  if (!(await placeExternalCandidate(candidate))) {
    renderSearchResults(searchInput.value.trim());
  }
}

function dismissSearchResults(): void {
  searchResultsDismissed = nextSearchMenuDismissed(searchResultsDismissed, "result-selected");
  searchResults.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
}

function renderSearchResults(query: string): void {
  const el = searchResults;
  el.hidden = query === "" || searchResultsDismissed;
  searchInput.setAttribute("aria-expanded", String(!el.hidden));
  if (!query) {
    el.innerHTML = "";
    return;
  }

  const parts: string[] = [];
  if (externalNotice) {
    parts.push(`<div class="muted small">${esc(externalNotice)}</div>`);
  }

  if (library && searchHits.matches.length > 0) {
    const tracks = library.tracks;
    const more = searchHits.matches.length - searchHits.shown.length;
    parts.push(
      ...searchHits.shown.map((i) => {
        const t = tracks[i];
        return `<button type="button" class="search-hit" data-pid="${esc(t.pid)}">
          <span class="hit-name">${esc(t.name)}</span>
          <span class="hit-artist">${esc(t.artist ?? "Unknown artist")}</span>
        </button>`;
      })
    );
    if (more > 0) {
      parts.push(
        `<div class="muted small more">${counted(more, "more match", "more matches")}, highlighted on the map but not listed.</div>`
      );
    }
  } else if (!library || searchHits.matches.length === 0) {
    parts.push(`<div class="muted small">Nothing matches "${esc(query)}".</div>`);
  }

  if (library) {
    const note = externalSearchNote(externalSearch);
    if (note) parts.push(`<div class="muted small">${esc(note)}</div>`);
    if (externalSearch.kind === "offer" || externalSearch.kind === "failed") {
      parts.push(
        `<button type="button" class="search-hit" id="search-deezer" data-external-search="1">
          <span class="hit-name">Search Deezer</span>
          <span class="hit-artist">Look outside your library</span>
        </button>`
      );
    }
    if (externalSearch.kind === "results") {
      parts.push(
        ...externalSearch.candidates.map((candidate, index) => {
          const already = candidate.localPid
            ? " · already in your library"
            : "";
          return `<button type="button" class="search-hit" data-external-index="${index}"${
            candidate.localPid ? ` data-pid="${esc(candidate.localPid)}"` : ""
          }>
            <span class="hit-name">${esc(candidate.title)}</span>
            <span class="hit-artist">${esc(candidate.artist ?? "Unknown artist")}${
              candidate.album ? ` — ${esc(candidate.album)}` : ""
            }${already}</span>
          </button>`;
        })
      );
    }
  }

  el.innerHTML = parts.join("");
  el.querySelectorAll<HTMLButtonElement>(".search-hit").forEach((btn) => {
    btn.setAttribute(
      "aria-label",
      `${btn.querySelector(".hit-name")?.textContent ?? ""}, ${btn.querySelector(".hit-artist")?.textContent ?? ""}`
    );
  });
  if (tutorialOn && tutorialOnTarget("search-deezer")) {
    document.getElementById("search-deezer")?.classList.add("tutorial-target");
    requestAnimationFrame(placeTutorialClouds);
  }
}

/** Pin the popover and pulse the dot without moving the camera. */
function showTrackOnMap(pid: string): void {
  const track = trackByPid(pid);
  if (!track) return;
  openTrackPopover(track);
  scatter?.setExternalHover(pid);
}

/** Go to a track from the result list: camera onto it, popover pinned to it. */
function focusTrack(pid: string): void {
  const at = trackPosition(pid);
  const track = trackByPid(pid);
  if (!at || !track) return;
  scatter?.focusOn(at[0], at[1]);
  openTrackPopover(track);
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

// The set starts empty, and the count, the empty note and the disabled exports
// are all derived: one render establishes them rather than the markup guessing.
renderSet();

// persist on tab close so the queue resumes (§3.3)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && library) void saveLibrary(library);
});

// tiny hook for automated smoke tests (harmless in production)
Object.assign(window, {
  __onkio: {
    importFile,
    importFiles,
    setColorMode,
    focusTrack,
    projectTrack: projectExternalTrack,
    getNeighbors: (
      pid: string,
      targetCollection: string | null = neighborCollection,
      limit = 5
    ) =>
      (neighborIndex?.nearest(pid, targetCollection, limit) ?? []).map(
        ({ track, distanceSq }) => ({
          pid: track.pid,
          collection: track.collection ?? null,
          distanceSq,
        })
      ),
    getState: () => ({
      tracks: library?.tracks.length ?? 0,
      playlists: library?.playlists.length ?? 0,
      embedded: coords !== null,
      neighborsReady: neighborIndex !== null,
      projectionReady: similarityEncoder !== null && similarityVectors !== null,
      neighborCollection,
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
      hoveredPid,
      emphasizedPid: scatter?.getHoveredTrackPid() ?? null,
      selectedPid: popoverTrack?.pid ?? null,
      lasso: lassoMode,
      setPanel: setPanelIsOpen(),
      set: setList.map((t) => t.pid),
      playing: loadedAudio ? { pid: loadedAudio.pid, origin: loadedAudio.origin } : null,
      view: scatter?.getViewState(),
      // Where the dots are on screen, so a gesture can be aimed at empty map.
      dataBox: scatter?.screenBounds() ?? null,
      collections: (library?.collections ?? []).map((c) => ({
        id: c.id,
        label: c.label,
        format: c.format,
        tracks: c.trackCount,
      })),
      staged: stagedFiles.map((file) => file.name),
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
