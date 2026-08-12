import { normalizeArtist } from "./normalize";

const DENYLIST = [
  /^(?:www\.)?bpmsupreme\.com$/i,
  /^bpm supreme$/i,
  /^dj ?city$/i,
  /^beatport$/i,
  /^distrokid$/i,
  /^the orchard$/i,
  /^believe(?: digital)?$/i,
  /^awal$/i,
  /^tunecore$/i,
  /^ingrooves$/i,
  /^symphonic(?: distribution)?$/i,
  /^independent label$/i,
  /^not on label$/i,
  /^\[?no label\]?$/i,
];

function cleanComponent(value: string): string | undefined {
  const cleaned = value
    .replace(/^[\s()[\]]+|[\s()[\]]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !cleaned ||
    /^(?:ltd\.?|limited|llc|inc\.?)$/i.test(cleaned) ||
    DENYLIST.some((pattern) => pattern.test(cleaned))
  )
    return undefined;
  return cleaned;
}

function artistOwns(component: string, artist?: string): boolean {
  if (!artist) return false;
  const label = normalizeArtist(component)
    .replace(/\b(?:records?|recordings?|music|productions?|ltd|limited|llc|inc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const act = normalizeArtist(artist);
  return !!label && !!act && (label === act || label.includes(act) || act.includes(label));
}

/**
 * Extract a display label from dirty catalogue metadata. Compound values are
 * read right-to-left because corporate parents and artist-owned imprints tend
 * to precede the actual imprint.
 */
export function canonicalLabel(raw: string | undefined, artist?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  const components = raw
    .replace(/[()]/g, ",")
    .split(/[,/]+/)
    .map(cleanComponent)
    .filter((value): value is string => value !== undefined)
    .filter((value) => !artistOwns(value, artist));
  if (components.length === 0) return undefined;
  return components[components.length - 1]
    .replace(/(?:,\s*)?(?:ltd\.?|limited|llc|inc\.?)$/i, "")
    .trim() || undefined;
}

/**
 * Vocabulary identity only. Display keeps useful words such as "Records";
 * the matrix folds those suffixes so spelling variants share one column.
 */
export function labelKey(label: string | undefined): string | undefined {
  const key = label
    ?.normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:records?|recordings?|music|ltd|limited|llc|inc)\b\.?$/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || undefined;
}

/** Parse iTunes album copyright only when it is already present in a response. */
export function labelFromItunesCopyright(
  copyright: string | undefined,
  artist?: string
): string | undefined {
  const owner = copyright
    ?.replace(/^[℗©]\s*(?:\d{4}\s*)?/, "")
    .split(/\s+under exclusive licen[cs]e to\s+/i)[0]
    .trim();
  return canonicalLabel(owner, artist);
}
