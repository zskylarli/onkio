import type { FeatureLookup, Library } from "../types";
import type { MusicFolder } from "../local/folder";
import type { Field } from "../enrich/fields";

/**
 * IndexedDB layer (§3.1). Lookup cache is keyed on normalized artist|title so
 * it survives re-exports and is shared across libraries. Negative results are
 * cached too. Records carry a version; bump CACHE_VERSION when an extractor
 * changes and stale records become misses.
 */

/**
 * v3 also invalidates hits made before album labels were collected. Without
 * this, an explicit label pass would stop at an old BPM/preview cache hit.
 * v2 invalidated every record written while the Deezer adapter was sending
 * field-syntax queries that always returned zero results: those runs recorded
 * "no BPM exists for this track" when the truth was "we never asked properly".
 */
export const CACHE_VERSION = 3;

/**
 * Hits are permanent — a track's BPM does not change. Misses expire, because
 * most of them are really rate limits, timeouts and outages wearing a miss
 * costume, and a permanently cached transient failure is unrecoverable
 * without clearing site data.
 */
export const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = "music-constellation";
const DB_VERSION = 1;

export type CachedLookup = {
  v: number;
  ts: number;
  hit: boolean;
  data?: FeatureLookup;
  /**
   * Fields some source was actually asked about. Routing is per field, so a
   * record can be a hit for BPM while nothing has ever asked for a preview, and
   * without this the partial answer would stand in for a complete one forever.
   * Absent on records written before per-field routing, which came from passes
   * that always ran every enabled source (see enrich/adapter).
   */
  covered?: Field[];
};

export type Override = { bpm?: number; key?: string };

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("lookups"))
        db.createObjectStore("lookups");
      if (!db.objectStoreNames.contains("overrides"))
        db.createObjectStore("overrides");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open();
  const tx = db.transaction(store, "readonly");
  return reqAsPromise(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  await reqAsPromise(tx.objectStore(store).put(value, key));
}

async function del(store: string, key: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  await reqAsPromise(tx.objectStore(store).delete(key));
}

// ---- lookup cache ----

export async function getCachedLookup(
  key: string
): Promise<CachedLookup | undefined> {
  const rec = await get<CachedLookup>("lookups", key);
  if (!rec) return undefined;
  if (rec.v !== CACHE_VERSION) return undefined; // clean invalidation
  if (!rec.hit && Date.now() - rec.ts > MISS_TTL_MS) return undefined;
  return rec;
}

/** Drop every cached miss so the next pass retries them. */
export async function clearCachedMisses(): Promise<number> {
  const db = await open();
  const tx = db.transaction("lookups", "readwrite");
  const store = tx.objectStore("lookups");
  const [keys, values] = await Promise.all([
    reqAsPromise(store.getAllKeys()),
    reqAsPromise(store.getAll()),
  ]);
  let removed = 0;
  keys.forEach((k, i) => {
    const rec = values[i] as CachedLookup | undefined;
    if (rec && !rec.hit) {
      store.delete(k);
      removed++;
    }
  });
  return removed;
}

export async function putCachedLookup(
  key: string,
  hit: boolean,
  data?: FeatureLookup,
  covered?: Field[]
): Promise<void> {
  const rec: CachedLookup = { v: CACHE_VERSION, ts: Date.now(), hit, data, covered };
  await put("lookups", key, rec);
}

// ---- manual overrides (§4 stage 3), keyed on Persistent ID ----

export async function getOverride(pid: string): Promise<Override | undefined> {
  return get<Override>("overrides", pid);
}

export async function getAllOverrides(): Promise<Map<string, Override>> {
  const db = await open();
  const tx = db.transaction("overrides", "readonly");
  const store = tx.objectStore("overrides");
  const [keys, values] = await Promise.all([
    reqAsPromise(store.getAllKeys()),
    reqAsPromise(store.getAll()),
  ]);
  const out = new Map<string, Override>();
  keys.forEach((k, i) => out.set(String(k), values[i] as Override));
  return out;
}

export async function putOverride(pid: string, o: Override): Promise<void> {
  const existing = (await getOverride(pid)) ?? {};
  await put("overrides", pid, { ...existing, ...o });
}

export async function deleteOverride(pid: string): Promise<void> {
  await del("overrides", pid);
}

// ---- misc persisted state ----

export async function saveLibrary(lib: Library): Promise<void> {
  await put("meta", "library", lib);
}

export async function loadLibrary(): Promise<Library | undefined> {
  return get<Library>("meta", "library");
}

export async function saveQueueState(pids: string[]): Promise<void> {
  await put("meta", "queue", pids);
}

export async function loadQueueState(): Promise<string[] | undefined> {
  return get<string[]>("meta", "queue");
}

/**
 * The chosen music folder, as a directory handle. Handles are structured-
 * cloneable, so the folder itself is remembered and the user picks it once
 * rather than once per session. What does *not* survive is permission to read
 * it: on the next load the handle is valid but has to be re-authorized from a
 * user gesture (src/local/folder.ts).
 */
export async function saveMusicFolder(folder: MusicFolder): Promise<void> {
  await put("meta", "musicFolder", folder);
}

export async function loadMusicFolder(): Promise<MusicFolder | undefined> {
  return get<MusicFolder>("meta", "musicFolder");
}

export async function clearMusicFolder(): Promise<void> {
  await del("meta", "musicFolder");
}

export async function saveMeta(key: string, value: unknown): Promise<void> {
  await put("meta", key, value);
}

export async function loadMeta<T>(key: string): Promise<T | undefined> {
  return get<T>("meta", key);
}
