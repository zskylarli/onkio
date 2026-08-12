/**
 * The File System Access API, reduced to the four things this app needs: ask
 * for a folder, walk it, check whether we may still read it, and open one file.
 *
 * Chromium only. Firefox and Safari ship no directory picker at all, and there
 * is no polyfill worth having — `<input webkitdirectory>` copies every byte of a
 * music library into memory and forgets it on reload. So this degrades to an
 * honest message and the preview path keeps working, rather than throwing.
 *
 * The surface is declared here rather than by widening `lib` in tsconfig:
 * TypeScript's DOM library describes the handles but not `showDirectoryPicker`,
 * not the permission methods, and not the async iteration used to walk a
 * directory.
 */

type PermissionQuery = { mode: "read" };

export type FolderPermission = "granted" | "denied" | "prompt";

export interface LocalFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}

export interface LocalDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  entries(): AsyncIterableIterator<[string, LocalFileHandle | LocalDirectoryHandle]>;
  queryPermission?(query: PermissionQuery): Promise<FolderPermission>;
  requestPermission?(query: PermissionQuery): Promise<FolderPermission>;
}

/** A folder the user granted, as persisted between sessions. */
export type MusicFolder = {
  /** Directory handles are structured-cloneable, so this survives in IndexedDB. */
  handle: LocalDirectoryHandle;
  name: string;
  connectedAt: string;
};

type PickerWindow = Window & {
  showDirectoryPicker?: (opts?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<LocalDirectoryHandle>;
};

/**
 * Extensions a browser can actually decode, plus the lossless formats a DJ
 * library is full of. Filtering here keeps the index to the files that could
 * ever be a track: a music folder also holds artwork, cue files and rekordbox's
 * own exports, and none of them can collide with a track name if never indexed.
 */
const AUDIO_EXTENSIONS = new Set([
  "aac",
  "aif",
  "aifc",
  "aiff",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "webm",
]);

/** Guards against a pathological tree; a music library is nowhere near either. */
const MAX_DEPTH = 16;
const MAX_FILES = 200_000;

/** Entries walked between yields to the event loop. */
const BATCH = 400;

export function supportsFolderAccess(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof (window as PickerWindow).showDirectoryPicker === "function"
  );
}

/** Null when the user dismissed the picker; anything else is a real failure. */
export async function pickMusicFolder(): Promise<LocalDirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("This browser cannot grant access to a folder.");
  try {
    // `id` makes Chromium reopen where the folder was last chosen.
    return await picker({ id: "onkio-music", mode: "read" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/**
 * Permission never survives a reload even though the handle does, so a restored
 * folder always starts here. A handle with no permission methods is reported as
 * needing a gesture: pretending it is granted would replace a button the user
 * can press with a traversal that fails for reasons they cannot act on.
 */
export async function folderPermission(
  handle: LocalDirectoryHandle
): Promise<FolderPermission> {
  if (typeof handle.queryPermission !== "function") return "prompt";
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch {
    return "prompt";
  }
}

/** Must be called from a user gesture; Chromium rejects it otherwise. */
export async function requestFolderPermission(
  handle: LocalDirectoryHandle
): Promise<FolderPermission> {
  if (typeof handle.requestPermission !== "function") return "granted";
  try {
    return await handle.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

export type FolderIndex = {
  /** paths relative to the chosen folder, POSIX separators */
  paths: string[];
  /** aligned with `paths`, so a match index is also a handle index */
  handles: LocalFileHandle[];
  /** true when MAX_FILES stopped the walk, so the readout can say so */
  truncated: boolean;
};

/**
 * Walk the folder for audio files.
 *
 * Traversal is iterative and yields to the event loop every few hundred
 * entries. Each `await` on a directory entry already yields, so the map stays
 * interactive without moving this to a worker — the per-entry work is a string
 * concatenation, and the walk is bounded by filesystem I/O rather than by CPU.
 * A worker would buy nothing here and would cost passing handles across a
 * thread boundary for every file that later has to be played.
 */
export async function indexFolder(
  root: LocalDirectoryHandle,
  onProgress?: (files: number) => void
): Promise<FolderIndex> {
  const index: FolderIndex = { paths: [], handles: [], truncated: false };
  const stack: { dir: LocalDirectoryHandle; prefix: string; depth: number }[] = [
    { dir: root, prefix: "", depth: 0 },
  ];
  let seen = 0;

  while (stack.length > 0) {
    const { dir, prefix, depth } = stack.pop()!;
    for await (const [name, handle] of dir.entries()) {
      // Hidden entries are resource forks, Spotlight indexes and .DS_Store.
      if (name.startsWith(".")) continue;
      if (++seen % BATCH === 0) {
        onProgress?.(index.paths.length);
        await yieldToEventLoop();
      }
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        if (depth + 1 <= MAX_DEPTH) stack.push({ dir: handle, prefix: path, depth: depth + 1 });
        continue;
      }
      if (!isAudioFile(name)) continue;
      if (index.paths.length >= MAX_FILES) {
        index.truncated = true;
        onProgress?.(index.paths.length);
        return index;
      }
      index.paths.push(path);
      index.handles.push(handle);
    }
  }
  onProgress?.(index.paths.length);
  return index;
}

function isAudioFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Open one indexed file. Null when it has been moved or deleted since the walk,
 * which is normal in a library that is still being edited and is not worth
 * interrupting playback for.
 */
export async function readLocalFile(handle: LocalFileHandle): Promise<File | null> {
  try {
    return await handle.getFile();
  } catch {
    return null;
  }
}
