/// <reference lib="webworker" />
import {
  decodeRekordboxTxt,
  parseRekordboxTxt,
  type RekordboxTxtCollection,
} from "./rekordboxTxt";

export type RekordboxTxtWorkerMsg =
  | {
      type: "done";
      collection: RekordboxTxtCollection;
      elapsedMs: number;
    }
  | { type: "error"; message: string };

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  const started = performance.now();
  try {
    const collection = parseRekordboxTxt(
      decodeRekordboxTxt(await event.data.file.arrayBuffer())
    );
    post({ type: "done", collection, elapsedMs: performance.now() - started });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

function post(message: RekordboxTxtWorkerMsg): void {
  (self as unknown as Worker).postMessage(message);
}
