// UTF-8 encoding of U+FEFF, stripped at the byte level so this module contains
// no invisible characters of its own.
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);

export type DecodeResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/**
 * Decodes a source file to the canonical text form used throughout the
 * pipeline: no byte order mark, `\n` line endings.
 *
 * Normalizing on the way in is what lets generated output be byte-identical
 * regardless of how the author's editor saved the source.
 *
 * A UTF-16 file is rejected rather than decoded as UTF-8, which would produce
 * mojibake and copy it verbatim into every provider's configuration.
 */
export const decodeSourceFile = (content: Buffer): DecodeResult => {
  if (content.subarray(0, 2).equals(UTF16_LE_BOM) || content.subarray(0, 2).equals(UTF16_BE_BOM)) {
    return { ok: false, reason: 'the file is UTF-16 encoded; AI Config reads UTF-8' };
  }

  return { ok: true, text: decodeSourceText(content) };
};

/** Decodes UTF-8 content, stripping a byte order mark and normalizing newlines. */
export const decodeSourceText = (content: Buffer): string => {
  const body = content.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
    ? content.subarray(UTF8_BOM.length)
    : content;
  return body.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
};

/**
 * Normalizes a generated document: `\n` endings, no trailing blank lines, and
 * exactly one final newline.
 */
export const normalizeGeneratedText = (text: string): string => {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
  return normalized.length === 0 ? '' : `${normalized}\n`;
};
