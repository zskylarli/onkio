import type { Track } from "../types";
import { keyVector } from "../music/camelot";
import { labelKey } from "../enrich/label";
import { artistKey } from "./matrix";

/**
 * The fit that `buildFeatureMatrix` performed, kept so a track that was not in
 * the corpus can be encoded into the same space later.
 *
 * This is the reference half of Seurat's reference-projection workflow: the
 * vocabularies, IDF weights, standardization statistics and per-block scale
 * factors are all properties of the corpus, not of any one track, so a new
 * track can only be placed on the existing map by replaying them. Without them
 * the only way to position an outside track is to re-fit everything, which
 * moves every dot already on screen.
 */
export type FeatureEncoder = {
  /** Total width of a row, identical to the fitted matrix's `d`. */
  d: number;
  offsets: {
    playlist: number;
    genre: number;
    tag: number;
    label: number;
    artist: number;
    numeric: number;
    timbre: number;
  };
  widths: {
    playlist: number;
    genre: number;
    tag: number;
    label: number;
    artist: number;
    numeric: number;
    timbre: number;
  };
  /** Fitted vocabularies. A value absent from these contributes nothing. */
  vocab: {
    playlist: Map<string, number>;
    genre: Map<string, number>;
    tag: Map<string, number>;
    label: Map<string, number>;
    artist: Map<string, number>;
  };
  idf: {
    playlist: Float64Array;
    genre: Float64Array;
    tag: Float64Array;
    label: Float64Array;
    artist: Float64Array;
  };
  /** Standardization statistics, and which numeric columns were fitted at all. */
  numeric: {
    bpmMean: number;
    bpmStd: number;
    yearMean: number;
    yearStd: number;
    durationMean: number;
    durationStd: number;
    useBpm: boolean;
    useKey: boolean;
    useYear: boolean;
    useDuration: boolean;
  };
  /** Per-column statistics of the timbre block; null when it was not fitted. */
  timbre: { mean: Float64Array; std: Float64Array } | null;
  /**
   * The multiplicative factors the scaling pass actually applied, per block.
   * These are corpus-level (RMS over the fitted rows), so they cannot be
   * recomputed from one track.
   */
  scale: {
    playlist: number;
    genre: number;
    tag: number;
    label: number;
    artist: number;
    numeric: number;
    timbre: number;
  };
};

/**
 * Encode one track into the fitted feature space, reproducing the row
 * `buildFeatureMatrix` would have given it — with two deliberate exceptions,
 * both of which follow from the track being outside the library:
 *
 * 1. The playlist block is always left at zero. An outside track has not been
 *    filed by the user, and imputing playlist membership would place it by
 *    guessed filing rather than by what it is. External tracks are positioned
 *    strictly on metadata similarity.
 * 2. Artist propagation is not replayed, since it only ever writes into the
 *    playlist block.
 *
 * Out-of-vocabulary categorical values contribute zero rather than extending
 * the space, mirroring the way a reference projection zero-fills features the
 * reference never saw.
 */
export function encodeTrack(encoder: FeatureEncoder, track: Track): Float32Array {
  const { offsets, widths, vocab, idf, numeric, scale } = encoder;
  const row = new Float32Array(encoder.d);

  // playlist block: intentionally left zero (see above)

  if (track.genre) {
    const i = vocab.genre.get(track.genre);
    if (i !== undefined) row[offsets.genre + i] = idf.genre[i];
  }
  for (const tag of track.tags ?? []) {
    const i = vocab.tag.get(tag);
    if (i !== undefined) row[offsets.tag + i] = idf.tag[i];
  }
  if (widths.label > 0) {
    const key = labelKey(track.label);
    const i = key === undefined ? undefined : vocab.label.get(key);
    if (i !== undefined) row[offsets.label + i] = idf.label[i];
  }
  if (widths.artist > 0) {
    const key = artistKey(track);
    const i = key === undefined ? undefined : vocab.artist.get(key);
    if (i !== undefined) row[offsets.artist + i] = idf.artist[i];
  }

  const nu = offsets.numeric;
  if (numeric.useBpm && track.bpm) {
    row[nu] = (Math.log2(track.bpm) - numeric.bpmMean) / numeric.bpmStd;
    const frac = Math.log2(track.bpm) % 1;
    row[nu + 1] = Math.sin(2 * Math.PI * frac);
    row[nu + 2] = Math.cos(2 * Math.PI * frac);
  }
  if (numeric.useKey && track.key) {
    const kv = keyVector(track.key);
    if (kv) {
      row[nu + 3] = kv[0];
      row[nu + 4] = kv[1];
      row[nu + 5] = kv[2];
    }
  }
  if (numeric.useYear && track.year) {
    row[nu + 6] = (track.year - numeric.yearMean) / numeric.yearStd;
  }
  if (numeric.useDuration && track.durationMs > 0) {
    row[nu + 7] = (Math.log(track.durationMs) - numeric.durationMean) / numeric.durationStd;
  }

  // A vector from an older extractor has the wrong width and is ignored, as it
  // is during the fit. Absent timbre stays zero, which after standardization is
  // the fitted mean, so an unheard track sits at the centre of timbre space.
  if (encoder.timbre && track.timbre?.length === widths.timbre) {
    for (let c = 0; c < widths.timbre; c++) {
      row[offsets.timbre + c] =
        (track.timbre[c] - encoder.timbre.mean[c]) / encoder.timbre.std[c];
    }
  }

  // Same order and arithmetic as the fit's scaling pass, so an encoded library
  // track is bit-identical to its row outside the playlist block.
  scaleRange(row, offsets.genre, widths.genre, scale.genre);
  scaleRange(row, offsets.tag, widths.tag, scale.tag);
  scaleRange(row, offsets.label, widths.label, scale.label);
  scaleRange(row, offsets.artist, widths.artist, scale.artist);
  scaleRange(row, offsets.numeric, widths.numeric, scale.numeric);
  if (encoder.timbre && track.timbre?.length === widths.timbre) {
    scaleRange(row, offsets.timbre, widths.timbre, scale.timbre);
  }
  return row;
}

function scaleRange(row: Float32Array, from: number, width: number, factor: number): void {
  if (factor === 1) return;
  for (let c = from; c < from + width; c++) row[c] *= factor;
}
