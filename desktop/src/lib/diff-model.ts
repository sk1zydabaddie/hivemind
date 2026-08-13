/* A unified diff, parsed into something a person can read line by line.
 *
 * "See every line" has been a control since the ship bar existed, and until now
 * it opened a dialog containing the raw patch as one block of monospace text.
 * That is the patch, not the lines: a person reading it has to do the parsing
 * themselves, and the thing they came to check -- what actually changed in which
 * file -- is the thing the rendering makes hardest.
 *
 * Everything here is presentation of a string Core produced. It parses; it
 * decides nothing. A diff view that could stage, approve or apply anything
 * would be a path around the adoption gate, so this module has no concept of
 * any of those and the components over it dispatch no actions.
 */

export type DiffLineKind = "added" | "removed" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the file before the change, where one exists. */
  before: number | null;
  /** Line number in the file after the change, where one exists. */
  after: number | null;
  text: string;
}

export interface DiffHunk {
  /** The `@@ … @@` header, kept verbatim for anyone who wants it. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** The path as a person would say it: the post-change name where there is one. */
  path: string;
  /** Set when a rename moved it, so the row can say so. */
  previousPath: string | null;
  change: "added" | "removed" | "modified" | "renamed";
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** True when the patch names the file but carries no text (binary, mode-only). */
  textless: boolean;
}

export interface ParsedDiff {
  files: DiffFile[];
  added: number;
  removed: number;
  /** Headings this parser was handed but did not recognise, reported not hidden. */
  unparsed: string[];
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/u;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

/**
 * Parse a unified diff, tolerantly.
 *
 * Tolerantly because the input is whatever the provider's patch looked like,
 * and a parser that throws on an unfamiliar header would replace a readable
 * diff with an error. Anything unrecognised is collected in `unparsed` and
 * shown to the person rather than dropped -- the same rule the containment
 * guard follows: decline to render, never pretend it was not there.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const files: DiffFile[] = [];
  const unparsed: string[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let before = 0;
  let after = 0;

  const closeFile = (): void => {
    if (file === null) return;
    file.textless = file.hunks.length === 0;
    files.push(file);
    file = null;
    hunk = null;
  };

  for (const raw of patch.split(/\r?\n/u)) {
    const line = raw.replace(/\r$/u, "");

    const header = FILE_HEADER.exec(line);
    if (header !== null) {
      closeFile();
      file = {
        path: header[2]!,
        previousPath: header[1] === header[2] ? null : header[1]!,
        change: header[1] === header[2] ? "modified" : "renamed",
        added: 0,
        removed: 0,
        hunks: [],
        textless: false
      };
      continue;
    }

    /* Hivemind's own change viewer heads each task's section with a plain
       markdown rule rather than a git header. Recognised so a multi-task
       change set does not read as one enormous file. */
    if (file === null && line.startsWith("# ")) {
      unparsed.push(line);
      continue;
    }

    if (file === null) {
      if (line.trim() !== "") unparsed.push(line);
      continue;
    }

    if (line.startsWith("new file mode")) {
      file.change = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.change = "removed";
      continue;
    }
    /* `---`/`+++` restate the paths the git header already gave, and `index`
       is a pair of object names. None of it is a line that changed. */
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }

    const hunkHeader = HUNK_HEADER.exec(line);
    if (hunkHeader !== null) {
      before = Number.parseInt(hunkHeader[1]!, 10);
      after = Number.parseInt(hunkHeader[3]!, 10);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (hunk === null) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "added", before: null, after, text: line.slice(1) });
      after += 1;
      file.added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      hunk.lines.push({ kind: "removed", before, after: null, text: line.slice(1) });
      before += 1;
      file.removed += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      /* "\ No newline at end of file" belongs to the line above it. */
      hunk.lines.push({ kind: "meta", before: null, after: null, text: line.slice(2) });
      continue;
    }
    /* A context line, or the empty line git writes as a bare "". */
    hunk.lines.push({ kind: "context", before, after, text: line.startsWith(" ") ? line.slice(1) : line });
    before += 1;
    after += 1;
  }

  closeFile();

  return {
    files,
    added: files.reduce((total, entry) => total + entry.added, 0),
    removed: files.reduce((total, entry) => total + entry.removed, 0),
    unparsed
  };
}

/**
 * A stable key for one line of one file, so an annotation can name the line it
 * is about without the client inventing an identifier scheme.
 *
 * Keyed on the post-change line number where there is one, because that is the
 * number the person can see in their editor. A removed line has no post-change
 * number and is keyed on its pre-change one.
 */
export function diffLineKey(file: DiffFile, line: DiffLine): string {
  return `${file.path}:${line.after === null ? `-${line.before ?? 0}` : `+${line.after}`}`;
}

/** The line's number as a person reads it, for the gutter. */
export function diffLineNumber(line: DiffLine): string {
  if (line.kind === "meta") return "";
  return String(line.after ?? line.before ?? "");
}

/** Files a task has spoken for that the patch does not mention. */
export function filesWithoutChanges(leased: string[], parsed: ParsedDiff): string[] {
  const changed = new Set(parsed.files.map((entry) => entry.path));
  return leased.filter((path) => !changed.has(path));
}
