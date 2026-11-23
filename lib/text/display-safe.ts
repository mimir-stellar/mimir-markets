/**
 * Presentation-boundary sanitizer for untrusted, single-line display text
 * (citation titles, domains, excerpts, peer-supplied labels).
 *
 * It removes characters that can change how surrounding text is displayed or
 * interpreted, and leaves ordinary Unicode alone:
 *
 * - **Bidirectional controls** (U+202A–U+202E embeddings/overrides,
 *   U+2066–U+2069 isolates, U+200E/U+200F marks, U+061C Arabic letter mark).
 *   These can visually reorder a title ("Trojan Source") so a reader sees a
 *   different domain or claim than the one stored.
 * - **Terminal control sequences**: ANSI/VT escape sequences (CSI `ESC [ … X`,
 *   OSC `ESC ] … BEL|ST`, and two-character `ESC X` forms) and the 8-bit C1
 *   CSI (U+009B). Copied into a terminal or log viewer they can recolour,
 *   hide or rewrite text.
 * - **Other C0/C1 control characters** (U+0000–U+001F, U+007F–U+009F).
 *   Tab, newline and carriage return become a single space instead of being
 *   dropped, so words on either side stay separated.
 *
 * Letters and marks in any script (Arabic, Hebrew, CJK, accented Latin, …),
 * emoji (including ZWJ sequences, U+200D) and the ZWNJ U+200C, which several
 * scripts need for correct shaping, are preserved. Runs of whitespace are
 * collapsed and the result is trimmed.
 *
 * This is a display transform only: it never changes stored values, hashes,
 * or URLs used for navigation.
 */

/* Regex escapes are kept as `\uXXXX` on purpose: raw control characters are
 * invisible in an editor and in grep, which would make these rules unreviewable. */

/**
 * ESC-introduced sequences: CSI (`ESC [`), OSC (`ESC ]` up to BEL or ST), and
 * two-character escapes with any final byte 0x30-0x7E (e.g. `ESC c` reset,
 * `ESC 7` save cursor). CSI and OSC are tried first, so `[` and `]` reach them.
 */
const ESCAPE_SEQUENCE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]?|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u0030-\u007e])/g;

/** 8-bit C1 Control Sequence Introducer form of CSI. */
const C1_CSI_SEQUENCE = /\u009b[0-?]*[ -/]*[@-~]?/g;

/** Bidirectional formatting characters. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Line-breaking whitespace controls that should separate words. */
const WHITESPACE_CONTROLS = /[\t\n\r\u000b\u000c\u0085\u2028\u2029]/g;

/** Remaining C0 and C1 control characters (and DEL). */
const OTHER_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Return `input` with directional and terminal control characters removed and
 * whitespace collapsed. `null`/`undefined` become `""`.
 */
export function sanitizeDisplayText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(ESCAPE_SEQUENCE, "")
    .replace(C1_CSI_SEQUENCE, "")
    .replace(WHITESPACE_CONTROLS, " ")
    .replace(OTHER_CONTROLS, "")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
}

