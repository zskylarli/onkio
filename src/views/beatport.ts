/**
 * Beatport catalogue search. The site's main search is a query string; artist
 * plus title is what a person would type into that field.
 */
export function beatportSearchUrl(artist: string | undefined, name: string): string {
  const q = [artist, name].filter((part) => part?.trim()).join(" ").trim();
  return `https://www.beatport.com/search?q=${encodeURIComponent(q)}`;
}
