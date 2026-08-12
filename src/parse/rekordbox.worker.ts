/// <reference lib="webworker" />
import { createRekordboxParser, type RekordboxStats } from "./rekordbox";
import type { Track } from "../types";

/** Parse worker for a rekordbox collection export, mirroring parse.worker.ts. */

export type RekordboxWorkerMsg =
  | { type: "progress"; tracks: number }
  | {
      type: "done";
      collection: {
        tracks: Track[];
        playlists: { name: string; pids: string[] }[];
        droppedPlaylists: string[];
        stats: RekordboxStats;
      };
      elapsedMs: number;
    }
  | { type: "error"; message: string };

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const started = performance.now();
  try {
    const parser = createRekordboxParser({
      onProgress: (tracks) => post({ type: "progress", tracks }),
    });

    const reader = e.data.file.stream().getReader();
    const decoder = new TextDecoder("utf-8");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.write(decoder.decode(value, { stream: true }));
    }
    parser.write(decoder.decode());
    const collection = parser.end();
    post({ type: "done", collection, elapsedMs: performance.now() - started });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

function post(msg: RekordboxWorkerMsg) {
  (self as unknown as Worker).postMessage(msg);
}
