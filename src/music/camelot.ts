/**
 * Key handling (§5.1, §7.1). Everything internal is Camelot ("8A" = A minor).
 * Parser is permissive: Camelot, Open Key, and classical names, with unicode
 * accidentals. Unparseable input returns null — callers log, never drop.
 */

export type CamelotKey = { num: number; minor: boolean };

const NOTE_PC: Record<string, number> = {
  c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, fb: 4, "e#": 5,
  f: 5, "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10,
  b: 11, cb: 11, "b#": 0,
};

/** Camelot number for a tonic pitch class (C=0). */
export function camelotFromPitchClass(pc: number, minor: boolean): string {
  const majorPc = minor ? (pc + 3) % 12 : pc;
  const fifthIndex = (majorPc * 7) % 12;
  const num = ((fifthIndex + 7) % 12) + 1;
  return `${num}${minor ? "A" : "B"}`;
}

export function parseCamelot(s: string): CamelotKey | null {
  const m = s.match(/^(\d{1,2})\s*([ABab])$/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (num < 1 || num > 12) return null;
  return { num, minor: m[2].toUpperCase() === "A" };
}

/**
 * Normalize any common key notation to Camelot. Returns null if unparseable.
 */
export function toCamelot(input: string | undefined | null): string | null {
  if (!input) return null;
  let s = input.trim().replace(/♯/g, "#").replace(/♭/g, "b");
  if (!s) return null;

  // Camelot: "8A", "08B"
  const cam = parseCamelot(s.replace(/^0+(\d)/, "$1"));
  if (cam) return `${cam.num}${cam.minor ? "A" : "B"}`;

  // Open Key: "1m" (minor) / "1d" (major); Camelot = OpenKey + 7 (mod 12)
  const ok = s.match(/^0?(\d{1,2})\s*([md])$/i);
  if (ok) {
    const n = parseInt(ok[1], 10);
    if (n >= 1 && n <= 12) {
      const num = ((n + 7 - 1) % 12) + 1;
      return `${num}${ok[2].toLowerCase() === "m" ? "A" : "B"}`;
    }
  }

  // Classical: "Am", "F# minor", "Ebmaj", "Db", "C# min"
  const cl = s.match(/^([A-Ga-g][#b]?)\s*(maj(?:or)?|min(?:or)?|m)?\.?$/);
  if (cl) {
    const pc = NOTE_PC[cl[1].toLowerCase()];
    if (pc !== undefined) {
      const mode = (cl[2] ?? "").toLowerCase();
      const minor = mode === "m" || mode.startsWith("min");
      return camelotFromPitchClass(pc, minor);
    }
  }
  return null;
}

/**
 * Cyclic encoding (§5.1): sin/cos of wheel position + major/minor bit.
 * 12A and 1A must come out adjacent.
 */
export function keyVector(camelot: string): [number, number, number] | null {
  const k = parseCamelot(camelot);
  if (!k) return null;
  const theta = (2 * Math.PI * (k.num - 1)) / 12;
  return [Math.sin(theta), Math.cos(theta), k.minor ? 1 : 0];
}

export type KeyCompatibility = "same" | "adjacent" | "relative" | "near" | "clash";

/**
 * Mixability between two Camelot keys (§7.1):
 * - same key → "same"
 * - same number, other letter (relative major/minor) → "relative" (safe)
 * - ±1 number, same letter → "adjacent" (safe)
 * - ±1 number, other letter → "near" (near-miss, warn softly)
 * - anything else → "clash"
 */
export function keyCompatibility(a: string, b: string): KeyCompatibility | null {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return null;
  const d = Math.min(
    (ka.num - kb.num + 12) % 12,
    (kb.num - ka.num + 12) % 12
  );
  const sameLetter = ka.minor === kb.minor;
  if (d === 0) return sameLetter ? "same" : "relative";
  if (d === 1) return sameLetter ? "adjacent" : "near";
  return "clash";
}

export function isCompatible(a: string, b: string): boolean {
  const c = keyCompatibility(a, b);
  return c === "same" || c === "adjacent" || c === "relative";
}

/** Pretty name for display, e.g. "8A (Am)". */
const CAMELOT_TO_NAME: Record<string, string> = {};
for (let pc = 0; pc < 12; pc++) {
  const names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  CAMELOT_TO_NAME[camelotFromPitchClass(pc, false)] = names[pc];
  CAMELOT_TO_NAME[camelotFromPitchClass(pc, true)] = names[pc] + "m";
}
export function camelotDisplay(camelot: string): string {
  const name = CAMELOT_TO_NAME[camelot];
  return name ? `${camelot} (${name})` : camelot;
}
