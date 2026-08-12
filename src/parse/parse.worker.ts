/// <reference lib="webworker" />
import { createLibraryParser } from "./library";
import type { Track } from "../types";

/**
 * Parse worker (§2): receives a File, streams it through the plist parser,
 * posts track batches as they land and the joined library at the end.
 */

export type ParseWorkerMsg =
  | { type: "batch"; tracks: Track[] }
  | { type: "progress"; tracks: number }
  | {
      type: "done";
      library: {
        tracks: Track[];
        playlists: { name: string; pids: string[] }[];
        droppedPlaylists: string[];
      };
      elapsedMs: number;
    }
  | { type: "error"; message: string };

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const started = performance.now();
  try {
    const parser = createLibraryParser({
      onTrackBatch: (batch) => {
        post({ type: "batch", tracks: batch });
      },
      onProgress: (p) => {
        post({ type: "progress", tracks: p.tracks });
      },
    });

    const reader = e.data.file.stream().getReader();
    const decoder = new TextDecoder("utf-8");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.write(decoder.decode(value, { stream: true }));
    }
    parser.write(decoder.decode());
    const library = parser.end();
    post({ type: "done", library, elapsedMs: performance.now() - started });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

function post(msg: ParseWorkerMsg) {
  (self as unknown as Worker).postMessage(msg);
}
