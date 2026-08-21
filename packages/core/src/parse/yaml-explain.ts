/**
 * Turns a YAML parser message into an explanation of the actual mistake.
 *
 * The `yaml` library reports what its state machine hit — "Unexpected scalar at
 * node end", "Implicit keys need to be on a single line" — which names the
 * symptom several characters after the cause. The single most common cause in
 * this project is a quoted `description:` that contains the same quote
 * character, because every scaffolded file ships with `description: "TODO: …"`
 * already quoted and authors paste prose into it.
 *
 * The parser message is never replaced, only followed: it is the exact text a
 * search engine matches, and a wrong guess here must not hide it. Every
 * explanation below is derived from the source line itself rather than from the
 * message, so a library wording change cannot silently disable one.
 */

/** A complete sentence, or `undefined` when nothing specific can be said. */
export type YamlExplanation = string | undefined;

type Quote = '"' | "'";

/**
 * Matches `key: "` or `- key: '`, capturing where the opening quote sits.
 *
 * The key is captured lazily up to the first colon, so a value that itself
 * contains a colon cannot be mistaken for the key.
 */
const QUOTED_VALUE = /^(\s*(?:-\s+)?)([^\s#][^:]*?)(:[ \t]+)(["'])/;

/** Matches an unquoted value on a `key: value` line, for the colon case. */
const UNQUOTED_VALUE = /^\s*(?:-\s+)?([^\s#][^:]*?):[ \t]+([^"'\s#][^#]*)$/;

/**
 * Explains the failure at `line`, if it can.
 *
 * @param text the YAML that was parsed, without any surrounding delimiters
 * @param line 1-based line the parser reported, in `text`'s own numbering
 * @param lineOffset added to every line number quoted back to the author, so a
 *   frontmatter block reports positions in the enclosing Markdown file
 */
export const explainYamlFailure = (
  text: string,
  line: number | undefined,
  lineOffset = 0,
): YamlExplanation => {
  const lines = text.split('\n');

  // The reported line is tried first, then every other line: the parser stops
  // where the document stopped making sense, which is often the line after the
  // one that broke it.
  const order = [
    ...(line === undefined ? [] : [line - 1]),
    ...lines.map((_, index) => index).filter((index) => index !== (line ?? 0) - 1),
  ];

  for (const index of order) {
    const source = lines[index];
    if (source === undefined) {
      continue;
    }
    const explanation = explainLine(source, index + 1 + lineOffset);
    if (explanation !== undefined) {
      return explanation;
    }
  }

  return undefined;
};

const explainLine = (source: string, line: number): YamlExplanation =>
  explainTab(source, line) ?? explainQuotes(source, line) ?? explainColon(source, line);

/**
 * A tab is legal inside a value but never as indentation, and it is invisible
 * in the editor, so it is worth naming before anything else.
 */
const explainTab = (source: string, line: number): YamlExplanation => {
  const indentation = /^[ \t]*/.exec(source)?.[0] ?? '';
  const tab = indentation.indexOf('\t');
  return tab === -1
    ? undefined
    : `YAML does not allow tabs for indentation: replace the tab at line ${String(line)}, column ${String(tab + 1)} with spaces.`;
};

const explainQuotes = (source: string, line: number): YamlExplanation => {
  const match = QUOTED_VALUE.exec(source);
  if (match === null) {
    return undefined;
  }

  const [, indentation = '', key = '', separator = ''] = match;
  const quote = match[4] as Quote;
  const openIndex = indentation.length + key.length + separator.length;
  const closeIndex = findClosingQuote(source, openIndex, quote);
  const at = `line ${String(line)}, column`;

  if (closeIndex === undefined) {
    return `The value of '${key.trim()}' opens with ${describe(quote)} at ${at} ${String(openIndex + 1)} that is never closed: add the closing quote, or remove both.`;
  }

  // Anything after the closing quote other than a comment is text the author
  // meant as part of the value, which means the quote closed it too early.
  const rest = source.slice(closeIndex + 1).trim();
  if (rest.length === 0 || rest.startsWith('#')) {
    return undefined;
  }

  return quote === '"'
    ? `The value of '${key.trim()}' is wrapped in double quotes, and the double quote at ${at} ${String(closeIndex + 1)} ends it early. Escape every double quote inside the value as \\", or wrap the whole value in single quotes instead.`
    : `The value of '${key.trim()}' is wrapped in single quotes, and the single quote at ${at} ${String(closeIndex + 1)} ends it early. Double it as '' to keep it literal, or wrap the whole value in double quotes instead.`;
};

/**
 * Finds the quote that closes the scalar opened at `openIndex`.
 *
 * The two quoting styles escape differently, which is exactly what makes the
 * mistake easy to make: a double-quoted scalar takes `\"`, a single-quoted one
 * takes `''`, and neither accepts the other's form.
 */
const findClosingQuote = (source: string, openIndex: number, quote: Quote): number | undefined => {
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"' && character === '\\') {
      index += 1;
      continue;
    }
    if (character !== quote) {
      continue;
    }
    if (quote === "'" && source[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index;
  }
  return undefined;
};

/**
 * An unquoted value containing `: ` reads as a nested mapping, which is the
 * other way a pasted sentence stops parsing.
 */
const explainColon = (source: string, line: number): YamlExplanation => {
  const match = UNQUOTED_VALUE.exec(source);
  if (match === null) {
    return undefined;
  }

  const [, key = '', value = ''] = match;
  const colon = value.search(/:(?:\s|$)/);
  if (colon === -1) {
    return undefined;
  }

  return `The value of '${key.trim()}' is unquoted and contains a colon at line ${String(line)}, column ${String(source.length - value.length + colon + 1)}, which YAML reads as the start of a nested key. Wrap the whole value in double quotes.`;
};

const describe = (quote: Quote): string => (quote === '"' ? 'a double quote' : 'a single quote');
