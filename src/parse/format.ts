import type { CollectionFormat } from "../types";

export function detectCollectionFormat(fileName: string, head: string): CollectionFormat {
  const clean = head.replace(/^\uFEFF/, "");
  if (
    fileName.toLocaleLowerCase().endsWith(".txt") ||
    clean.startsWith("#\tArtwork\tTrack Title\tArtist\tAlbum\tGenre\tBPM\tRating\tTime\tKey\tDate Added")
  ) {
    return "rekordbox-txt";
  }
  return clean.includes("DJ_PLAYLISTS") ? "rekordbox" : "apple";
}
