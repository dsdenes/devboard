/**
 * Code measurement for the complexity dashboard: a deterministic scanner over
 * application source text. It is intentionally not a parser. The dashboard
 * measures its own tree without a runtime dependency, so the rules below are
 * the definition every recorded value follows:
 *
 * - comments, strings, and regular expressions are skipped as single tokens;
 * - a function is a `function` declaration, a method, or an arrow whose body is
 *   a brace block; its signature is the tokens before that block;
 * - cyclomatic complexity is 1 plus one each for `if`, `for`, `while`, `do`,
 *   `catch`, `case`, `&&`, `||`, `??`, and a ternary `?`, counted in the
 *   function's own body and never in a nested function's body;
 * - nesting is the deepest brace block inside the body;
 * - source length is the signature line through the closing brace;
 * - parameters are the top-level comma-separated entries of the signature's
 *   parameter list.
 */

export type TokenKind = "identifier" | "keyword" | "number" | "string" | "punct";

/** One scanned source token, with the 1-based line it starts on. */
export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
}

/** The measurements of one function, file-relative. */
export interface FunctionMeasure {
  name: string;
  /** The signature's 1-based line. */
  line: number;
  /** Signature line through closing brace, inclusive. */
  lines: number;
  cyclomatic: number;
  nesting: number;
  parameters: number;
}

/** What one file's tokens contribute to the project-wide duplication count. */
export interface FileMeasureSource {
  loc: number;
  functions: FunctionMeasure[];
  /** Normalized code line to the number of times it occurs in this file. */
  lines: Map<string, number>;
  halstead: HalsteadCounts;
}

const KEYWORDS: Record<string, true> = {
  "abstract": true,
  "as": true,
  "asserts": true,
  "async": true,
  "await": true,
  "break": true,
  "case": true,
  "catch": true,
  "class": true,
  "const": true,
  "continue": true,
  "debugger": true,
  "declare": true,
  "default": true,
  "delete": true,
  "do": true,
  "else": true,
  "enum": true,
  "export": true,
  "extends": true,
  "false": true,
  "finally": true,
  "for": true,
  "from": true,
  "function": true,
  "get": true,
  "if": true,
  "implements": true,
  "import": true,
  "in": true,
  "infer": true,
  "instanceof": true,
  "interface": true,
  "is": true,
  "keyof": true,
  "let": true,
  "namespace": true,
  "new": true,
  "null": true,
  "of": true,
  "override": true,
  "private": true,
  "protected": true,
  "public": true,
  "readonly": true,
  "return": true,
  "satisfies": true,
  "set": true,
  "static": true,
  "super": true,
  "switch": true,
  "this": true,
  "throw": true,
  "true": true,
  "try": true,
  "type": true,
  "typeof": true,
  "undefined": true,
  "unique": true,
  "var": true,
  "void": true,
  "while": true,
  "with": true,
  "yield": true,
};

const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  "&&=",
  "||=",
  "??=",
  ">>>",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  "**",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "!",
  "&",
  "|",
  "^",
  "~",
  "?",
  ";",
  ":",
  ",",
  ".",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "@",
  "#",
].sort((left, right) => right.length - left.length);

/** A token after which a `/` opens a regular expression, never a division. */
const REGEX_PRECEDING_PUNCT: Record<string, true> = {
  "(": true,
  ")": true,
  ",": true,
  "=": true,
  ":": true,
  "[": true,
  "!": true,
  "&": true,
  "|": true,
  "?": true,
  "{": true,
  "}": true,
  ";": true,
  "+": true,
  "-": true,
  "*": true,
  "%": true,
  "<": true,
  ">": true,
  "~": true,
  "^": true,
  "=>": true,
  "??": true,
  "&&": true,
  "||": true,
};

const REGEX_PRECEDING_KEYWORDS: Record<string, true> = {
  "return": true,
  "case": true,
  "typeof": true,
  "delete": true,
  "void": true,
  "in": true,
  "of": true,
  "instanceof": true,
  "new": true,
  "do": true,
  "else": true,
  "yield": true,
  "await": true,
  "throw": true,
};

const DECISION_KEYWORDS: Record<string, true> = {
  if: true,
  for: true,
  while: true,
  do: true,
  catch: true,
  case: true,
};

const DECISION_PUNCT: Record<string, true> = {
  "&&": true,
  "||": true,
  "??": true,
  "?": true,
};

/** The tokens an arrow signature never reaches back past. */
const ARROW_SIGNATURE_STOPS: Record<string, true> = {
  "=>": true,
  "=": true,
  ";": true,
  "}": true,
  "(": true,
  ",": true,
  "[": true,
};

/** The tokens after which a `{` cannot open a function body. */
const SIGNATURE_STOPS: Record<string, true> = {
  "{": true,
  "}": true,
  ";": true,
  "=>": true,
  "=": true,
  "(": true,
  "[": true,
  ",": true,
};

/** How far back a signature may reach before the brace is not a function. */
const SIGNATURE_WINDOW = 240;

/** A normalized line shorter than this many tokens is never duplication. */
const DUPLICATION_MIN_TOKENS = 4;

/** Halstead operator and operand totals and their distinct counts. */
export interface HalsteadCounts {
  operators: number;
  distinctOperators: number;
  operands: number;
  distinctOperands: number;
}

interface Signature {
  name: string;
  startLine: number;
  parameters: number;
}

interface FunctionSpan extends Signature {
  bodyStart: number;
  /** The closing brace's token index; -1 while the span is unclosed. */
  bodyEnd: number;
  /** Decision points counted in this function's own body, never a nested one. */
  decisions: number;
  nesting: number;
  /** Brace depth of the innermost block currently open inside this body. */
  depth: number;
}

function isIdentifierPart(value: string): boolean {
  return /[A-Za-z0-9_$]/.test(value);
}

function tokenAllowedAfterRegex(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.kind === "punct") return Object.hasOwn(REGEX_PRECEDING_PUNCT, previous.text);
  if (previous.kind === "keyword") return Object.hasOwn(REGEX_PRECEDING_KEYWORDS, previous.text);
  return false;
}

/**
 * Splits source text into tokens. Strings, template literals, regular
 * expressions, and comments never contribute their contents: one literal is
 * one token, so braces and operators inside them never move a measurement.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let index = 0;
  let line = 1;
  while (index < length) {
    const char = source[index] ?? "";
    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\f" || char === "\v") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === "<" && source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      const stop = end === -1 ? length : end + 3;
      for (let cursor = index; cursor < stop; cursor += 1) {
        if (source[cursor] === "\n") line += 1;
      }
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const startLine = line;
      const quote = char;
      const start = index;
      index += 1;
      while (index < length) {
        const current = source[index] ?? "";
        if (current === "\\") {
          if (source[index + 1] === "\n") line += 1;
          index += 2;
          continue;
        }
        if (current === "\n") {
          line += 1;
          index += 1;
          // A single- and double-quoted string never spans a line; ending it
          // here keeps one stray quote from swallowing the rest of the file.
          if (quote !== "`") break;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ kind: "string", text: source.slice(start, index), line: startLine });
      continue;
    }
    if (char === "/" && tokenAllowedAfterRegex(tokens[tokens.length - 1])) {
      const startLine = line;
      const start = index;
      index += 1;
      let inClass = false;
      while (index < length) {
        const current = source[index] ?? "";
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "\n") break;
        if (current === "[") {
          inClass = true;
        } else if (current === "]") {
          inClass = false;
        } else if (current === "/" && !inClass) {
          index += 1;
          break;
        }
        index += 1;
      }
      while (index < length && /[A-Za-z]/.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "string", text: source.slice(start, index), line: startLine });
      continue;
    }
    const following = source[index + 1] ?? "";
    if ((char >= "0" && char <= "9") || (char === "." && following >= "0" && following <= "9")) {
      const start = index;
      const startLine = line;
      index += 1;
      while (index < length) {
        const current = source[index] ?? "";
        if (isIdentifierPart(current) || current === ".") {
          index += 1;
          continue;
        }
        const previous = source[index - 1] ?? "";
        if ((current === "+" || current === "-") && (previous === "e" || previous === "E")) {
          index += 1;
          continue;
        }
        break;
      }
      tokens.push({ kind: "number", text: source.slice(start, index), line: startLine });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      const startLine = line;
      while (index < length && isIdentifierPart(source[index] ?? "")) index += 1;
      const text = source.slice(start, index);
      tokens.push({ kind: Object.hasOwn(KEYWORDS, text) ? "keyword" : "identifier", text, line: startLine });
      continue;
    }
    let matched = "";
    for (const punctuator of PUNCTUATORS) {
      if (source.startsWith(punctuator, index)) {
        matched = punctuator;
        break;
      }
    }
    if (matched.length === 0) {
      // An unknown character is skipped rather than guessed at.
      index += 1;
      continue;
    }
    tokens.push({ kind: "punct", text: matched, line });
    index += matched.length;
  }
  return tokens;
}

/** The index of the `open` token matching the `close` token at `index`, or -1. */
function matchingOpen(tokens: readonly Token[], index: number, open: string, close: string): number {
  let depth = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const text = tokens[cursor]?.text;
    if (text === close) depth += 1;
    else if (text === open) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

/** The index of the `close` token matching the `open` token at `index`, or -1. */
function matchingClose(tokens: readonly Token[], index: number, open: string, close: string): number {
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const text = tokens[cursor]?.text;
    if (text === open) depth += 1;
    else if (text === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

/** Counts the top-level comma-separated entries between `open` and `close`. */
function parameterCount(tokens: readonly Token[], open: number, close: number): number {
  let entries = 0;
  let depth = 0;
  let significant = false;
  for (let cursor = open + 1; cursor < close; cursor += 1) {
    const token = tokens[cursor];
    if (token === undefined) break;
    if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
    else if (token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
    else if (token.text === "," && depth === 0) {
      entries += 1;
      continue;
    }
    significant = true;
  }
  if (!significant) return 0;
  return entries + 1;
}

/**
 * The identifier a signature belongs to, when it is a definition and not a
 * call, a control statement, or a CSS selector.
 */
function definitionName(
  tokens: readonly Token[],
  openIndex: number,
): { name: string; line: number } | undefined {
  let nameIndex = openIndex - 1;
  // A generic method writes `name<T>(...)`: the name sits before the angle pair.
  if (tokens[nameIndex]?.text === ">") {
    const angle = matchingOpen(tokens, nameIndex, "<", ">");
    if (angle < 0) return undefined;
    nameIndex = angle - 1;
  }
  const name = tokens[nameIndex];
  if (name === undefined) return undefined;
  if (name.text !== "function" && name.kind !== "identifier") return undefined;
  const before = tokens[nameIndex - 1];
  if (before !== undefined && (before.text === "." || before.text === ":" || before.text === "@")) {
    return undefined;
  }
  if (before !== undefined && before.text === "?.") return undefined;
  return { name: name.text === "function" ? "function" : name.text, line: name.line };
}

/** A name for an arrow function: its assigned identifier, else `arrow`. */
function arrowName(tokens: readonly Token[], signatureStart: number): string {
  const before = tokens[signatureStart - 1];
  if (before?.text === "=") {
    const assigned = tokens[signatureStart - 2];
    if (assigned !== undefined && assigned.kind === "identifier") return assigned.text;
  }
  const previous = tokens[signatureStart - 1];
  if (previous?.text === ":") {
    const key = tokens[signatureStart - 2];
    if (key !== undefined && key.kind === "identifier") return key.text;
  }
  return "arrow";
}

/** The signature a `{` at `braceIndex` opens, or `undefined` when it is a block. */
function signatureFor(tokens: readonly Token[], braceIndex: number): Signature | undefined {
  const previous = tokens[braceIndex - 1];
  if (previous === undefined) return undefined;
  if (previous.text === "=>") {
    // The arrow's parameter list sits behind an optional return type, e.g.
    // `(value: number): number => {`; a type's own angle pair is skipped whole.
    let cursor = braceIndex - 2;
    let candidateIndex: number | undefined;
    for (let steps = 0; steps < SIGNATURE_WINDOW; steps += 1) {
      const token = tokens[cursor];
      if (token === undefined) return undefined;
      if (token.text === ")") {
        const open = matchingOpen(tokens, cursor, "(", ")");
        if (open < 0) return undefined;
        const startLine = tokens[open]?.line ?? token.line;
        return {
          name: arrowName(tokens, open),
          startLine,
          parameters: parameterCount(tokens, open, cursor),
        };
      }
      if (token.text === ">") {
        const angle = matchingOpen(tokens, cursor, "<", ">");
        if (angle < 0) return undefined;
        cursor = angle - 1;
        continue;
      }
      if (token.kind === "identifier") candidateIndex = cursor;
      if (Object.hasOwn(ARROW_SIGNATURE_STOPS, token.text)) break;
      cursor -= 1;
    }
    if (candidateIndex === undefined) return undefined;
    const candidate = tokens[candidateIndex];
    if (candidate === undefined) return undefined;
    return {
      name: arrowName(tokens, candidateIndex),
      startLine: candidate.line,
      parameters: 1,
    };
  }

  // A method or a declaration: its parameter list closes just before the body,
  // optionally behind a return type such as `): Promise<void>`.
  let cursor = braceIndex - 1;
  for (let steps = 0; steps < SIGNATURE_WINDOW; steps += 1) {
    const token = tokens[cursor];
    if (token === undefined) return undefined;
    if (token.text === ")") {
      const open = matchingOpen(tokens, cursor, "(", ")");
      if (open < 0) return undefined;
      const definition = definitionName(tokens, open);
      if (definition !== undefined) {
        return {
          name: definition.name,
          startLine: definition.line,
          parameters: parameterCount(tokens, open, cursor),
        };
      }
      // A parameter list inside a return type is not this brace's signature:
      // skip the whole group and keep looking behind it.
      cursor = open - 1;
      continue;
    }
    if (Object.hasOwn(SIGNATURE_STOPS, token.text)) return undefined;
    cursor -= 1;
  }
  return undefined;
}

/** Whether the token at `index` is a decision point for cyclomatic complexity. */
function isDecision(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (token.kind === "keyword") return Object.hasOwn(DECISION_KEYWORDS, token.text);
  if (token.kind !== "punct") return false;
  if (token.text === "?") {
    // `foo?: T` and `(a?: T)` mark an optional member, never a branch.
    return tokens[index + 1]?.text !== ":";
  }
  return Object.hasOwn(DECISION_PUNCT, token.text);
}

/**
 * Every function span in one forward pass. A brace stack keeps the innermost
 * open function current, so each decision point lands on the function that
 * owns it and each nesting level lands on the enclosing body.
 */
function functionSpans(tokens: readonly Token[]): FunctionSpan[] {
  const spans: FunctionSpan[] = [];
  const braces: Array<FunctionSpan | undefined> = [];
  const open: FunctionSpan[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.text === "{") {
      const enclosing = open[open.length - 1];
      if (enclosing !== undefined) {
        enclosing.depth += 1;
        enclosing.nesting = Math.max(enclosing.nesting, enclosing.depth);
      }
      const signature = signatureFor(tokens, index);
      if (signature === undefined) {
        braces.push(undefined);
        continue;
      }
      const span: FunctionSpan = {
        ...signature,
        bodyStart: index,
        bodyEnd: -1,
        decisions: 0,
        nesting: 0,
        depth: 0,
      };
      spans.push(span);
      open.push(span);
      braces.push(span);
      continue;
    }
    if (token.text === "}") {
      const frame = braces.pop();
      if (frame !== undefined) {
        frame.bodyEnd = index;
        if (open[open.length - 1] === frame) open.pop();
      }
      const enclosing = open[open.length - 1];
      if (enclosing !== undefined) enclosing.depth = Math.max(0, enclosing.depth - 1);
      continue;
    }
    if (open.length > 0 && isDecision(tokens, index)) {
      const innermost = open[open.length - 1];
      if (innermost !== undefined) innermost.decisions += 1;
    }
  }
  return spans.filter((span) => span.bodyEnd >= 0);
}

/** Measured spans in the file's reading order. */
function functionMeasures(tokens: readonly Token[]): FunctionMeasure[] {
  const ordered = [...functionSpans(tokens)].sort(
    (left, right) => left.startLine - right.startLine || left.bodyStart - right.bodyStart,
  );
  return ordered.map((span) => {
    const endLine = tokens[span.bodyEnd]?.line ?? span.startLine;
    return {
      name: span.name,
      line: span.startLine,
      lines: Math.max(1, endLine - span.startLine + 1),
      cyclomatic: 1 + span.decisions,
      nesting: span.nesting,
      parameters: span.parameters,
    };
  });
}

/** One normalized code line: its tokens joined by single spaces. */
function codeLines(tokens: readonly Token[]): Map<string, number> {
  const byLine = new Map<number, string[]>();
  for (const token of tokens) {
    const entry = byLine.get(token.line);
    if (entry === undefined) byLine.set(token.line, [token.text]);
    else entry.push(token.text);
  }
  const lines = new Map<string, number>();
  for (const parts of byLine.values()) {
    const text = parts.join(" ");
    lines.set(text, (lines.get(text) ?? 0) + 1);
  }
  return lines;
}

/** The lines long enough to count as duplicated code, not punctuation noise. */
function significantLines(lines: Map<string, number>): Map<string, number> {
  const significant = new Map<string, number>();
  for (const [text, count] of lines) {
    if (text.split(" ").length >= DUPLICATION_MIN_TOKENS) significant.set(text, count);
  }
  return significant;
}

/** Halstead operator and operand totals over one file's tokens. */
function halstead(tokens: readonly Token[]): HalsteadCounts {
  const operators = new Set<string>();
  const operands = new Set<string>();
  let operatorTotal = 0;
  let operandTotal = 0;
  for (const token of tokens) {
    if (token.kind === "punct" || token.kind === "keyword") {
      operators.add(token.text);
      operatorTotal += 1;
      continue;
    }
    operands.add(token.text);
    operandTotal += 1;
  }
  return {
    operators: operatorTotal,
    distinctOperators: operators.size,
    operands: operandTotal,
    distinctOperands: operands.size,
  };
}

/**
 * Every measurement one file's text carries. Two calls on the same text yield
 * the same values: the scanner has no clock, no randomness, and no I/O.
 */
export function measureSource(source: string): FileMeasureSource {
  const tokens = tokenize(source);
  const lines = codeLines(tokens);
  let loc = 0;
  for (const count of lines.values()) loc += count;
  return {
    loc,
    functions: functionMeasures(tokens),
    lines: significantLines(lines),
    halstead: halstead(tokens),
  };
}

/** Rounds to `digits` decimal places without a floating-point surprise. */
export function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * The maintainability index of one file, clamped to 0-100. The classic 1991
 * formula is Halstead volume, mean cyclomatic complexity, and lines of code;
 * a file without code still measures 100, the cleanest possible result.
 */
export function maintainabilityIndex(
  volume: number,
  meanCyclomatic: number,
  loc: number,
): number {
  const code = Math.max(1, loc);
  const mi =
    171 - 5.2 * Math.log(Math.max(1, volume)) - 0.23 * meanCyclomatic - 16.2 * Math.log(code);
  return round(Math.min(100, Math.max(0, (mi * 100) / 171)), 2);
}

/** Halstead volume over the operator and operand counts. */
export function halsteadVolume(counts: HalsteadCounts): number {
  const distinct = counts.distinctOperators + counts.distinctOperands;
  const total = counts.operators + counts.operands;
  if (distinct <= 1 || total === 0) return 0;
  return total * Math.log2(distinct);
}
