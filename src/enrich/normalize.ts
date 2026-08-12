/**
 * String normalization for external lookups (§3.2). Aggressive on Latin
 * decoration, conservative on non-Latin scripts: NFKD only decomposes
 * characters that have decompositions, so CJK passes through untouched and
 * we only remove combining marks (diacritics).
 */

const SUFFIX_WORDS =
  /\b(remaster(?:ed)?(?:\s*\d{4})?|radio\s+edit|extended(?:\s+mix)?|original\s+mix|club\s+mix|dub\s+mix|(?:\w+\s+)?remix|(?:\w+\s+)?edit|(?:\w+\s+)?version|(?:\w+\s+)?mix|instrumental|acoustic|live|mono|stereo|deluxe|single|bonus\s+track|explicit|clean)\b/i;

function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Remove trailing bracketed groups whose content looks like edition noise. */
function stripBracketedSuffixes(s: string): string {
  let out = s;
  for (;;) {
    const m = out.match(/\s*[([{]([^()[\]{}]*)[)\]}]\s*$/);
    if (!m) break;
    // Only strip if it reads like edition metadata or a feat. credit;
    // "(Interlude)" on a real title is noise too, but a bracketed group with
    // no such keyword may be part of the actual name — keep it.
    if (SUFFIX_WORDS.test(m[1]) || /\bfe?a?t\.?\b|\bfeaturing\b/i.test(m[1])) {
      out = out.slice(0, out.length - m[0].length);
    } else break;
  }
  return out;
}

/** Remove a trailing "- Radio Edit" style dash suffix. */
function stripDashSuffix(s: string): string {
  const m = s.match(/\s+[-–—]\s+([^-–—]+)$/);
  if (m && SUFFIX_WORDS.test(m[1])) return s.slice(0, s.length - m[0].length);
  return s;
}

/** Remove "feat. X" clauses wherever they appear. */
function stripFeat(s: string): string {
  return s.replace(/[\s,]*\b(?:feat\.?|ft\.?|featuring)\b.*$/i, "");
}

export function normalizeTitle(title: string): string {
  let s = title;
  s = stripBracketedSuffixes(s);
  s = stripDashSuffix(s);
  s = stripFeat(s);
  s = stripDiacritics(s).toLowerCase();
  s = s.replace(/["'’`´]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s || stripDiacritics(title).toLowerCase().trim();
}

export function normalizeArtist(artist: string): string {
  let s = stripFeat(artist);
  // "A & B", "A x B", "A, B" → keep the primary artist for lookup
  const primary = s.split(/\s*(?:,|&|\bx\b|\bvs\.?\b|\band\b)\s*/i)[0];
  if (primary && primary.trim().length >= 1) s = primary;
  s = stripDiacritics(s).toLowerCase();
  s = s.replace(/["'’`´]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s || stripDiacritics(artist).toLowerCase().trim();
}

/**
 * Folding for matching against text a person just typed: case, accents and
 * quote marks only. The normalizers above also throw away mix suffixes and
 * secondary artists so that two spellings of one recording collide, which is
 * right for hitting a catalogue and wrong here, where "extended mix" and a
 * featured artist are things worth searching for.
 */
export function foldForSearch(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/["'’`´]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cache key for the lookup cache (§3.1). */
export function lookupKey(artist: string | undefined, title: string): string {
  return `${artist ? normalizeArtist(artist) : ""}|${normalizeTitle(title)}`;
}
