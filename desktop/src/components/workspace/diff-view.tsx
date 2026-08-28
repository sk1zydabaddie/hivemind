import { MessageSquarePlus, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  diffLineKey,
  diffLineNumber,
  filesWithoutChanges,
  parseUnifiedDiff,
  type DiffFile,
  type DiffLine
} from "@/lib/diff-model";

/* Every line of a change, and the notes a person leaves on it.
 *
 * Two things this deliberately cannot do, because both would be a path around a
 * gate rather than a view of one:
 *
 *  - **It cannot edit, stage or apply anything.** There is no writable surface
 *    here at all. The lines are text the daemon produced.
 *  - **A note cannot authorize.** An annotation is GUIDANCE. It travels through
 *    `task.redirect`, arrives at the agent's next safe boundary, and is subject
 *    to every gate that was already there -- the same scope check still rejects
 *    an out-of-scope change made in response to it. Chat steers, buttons
 *    authorize; a comment on a line is chat.
 *
 * That second rule is what makes this worth stealing rather than copying. The
 * version this is modelled on sends free text to an agent that approves its own
 * edits. Ours sends it to one that still has to get past the scope gate.
 */

export interface DiffAnnotation {
  key: string;
  path: string;
  /** The line as the person saw it, quoted back so the note has its subject. */
  line: string;
  note: string;
}

export function DiffView({
  patch,
  leasedFiles = [],
  annotations,
  onAnnotate
}: {
  patch: string;
  /** Files the task holds. Any it did not touch are named rather than omitted. */
  leasedFiles?: string[];
  /** Omitted entirely on a read-only diff, such as the shipped change set. */
  annotations?: DiffAnnotation[];
  onAnnotate?: (annotations: DiffAnnotation[]) => void;
}): React.JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const untouched = useMemo(
    () => filesWithoutChanges(leasedFiles, parsed),
    [leasedFiles, parsed]
  );
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const annotatable = onAnnotate !== undefined && annotations !== undefined;
  const noteFor = new Map((annotations ?? []).map((entry) => [entry.key, entry]));

  if (parsed.files.length === 0) {
    return (
      <div className="px-4 py-6">
        <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
          {parsed.unparsed.length === 0
            ? "This change has no lines to show."
            : "This change is not in a form Hivemind can lay out line by line. The record of it is below, exactly as it was written."}
        </p>
        {parsed.unparsed.length === 0 ? null : (
          <pre className="mt-3 mb-0 overflow-x-auto rounded-md border border-rule bg-canvas p-3 font-mono text-[12px] leading-relaxed text-ink">
            {parsed.unparsed.join("\n")}
          </pre>
        )}
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0">
      <div className="grid gap-4 px-4 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <span className="font-mono text-ink">{parsed.files.length}</span>
          <span>{parsed.files.length === 1 ? "file" : "files"}</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
          <span className="font-mono text-navy">+{parsed.added}</span>
          <span className="font-mono text-clay">−{parsed.removed}</span>
        </div>

        {parsed.files.map((file) => (
          <FilePanel
            annotatable={annotatable}
            file={file}
            key={file.path}
            noteFor={noteFor}
            openKey={open}
            onOpen={(key) => {
              setOpen(key);
              setDraft(key === null ? "" : (noteFor.get(key)?.note ?? ""));
            }}
            draft={draft}
            onDraft={setDraft}
            onSave={(entry) => {
              const rest = (annotations ?? []).filter((item) => item.key !== entry.key);
              onAnnotate?.(entry.note.trim() === "" ? rest : [...rest, entry]);
              setOpen(null);
              setDraft("");
            }}
          />
        ))}

        {untouched.length === 0 ? null : (
          <section className="rounded-md border border-rule bg-canvas px-3 py-2.5">
            <h4 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Held but not changed
            </h4>
            <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted-foreground">
              This task was given {untouched.length === 1 ? "this file" : "these files"} and
              did not change {untouched.length === 1 ? "it" : "them"}.
            </p>
            <ul className="mt-1.5 mb-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
              {untouched.map((path) => (
                <li className="font-mono text-[12px] break-all text-muted-foreground" key={path}>
                  {path}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

const CHANGE_LABEL: Record<DiffFile["change"], string> = {
  added: "new file",
  removed: "deleted",
  modified: "changed",
  renamed: "renamed"
};

function FilePanel({
  file,
  annotatable,
  noteFor,
  openKey,
  draft,
  onOpen,
  onDraft,
  onSave
}: {
  file: DiffFile;
  annotatable: boolean;
  noteFor: Map<string, DiffAnnotation>;
  openKey: string | null;
  draft: string;
  onOpen: (key: string | null) => void;
  onDraft: (value: string) => void;
  onSave: (entry: DiffAnnotation) => void;
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-md border border-rule">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule bg-canvas px-3 py-2">
        <span className="font-mono text-[12px] break-all text-ink">{file.path}</span>
        <span className="text-[11px] text-muted-foreground">{CHANGE_LABEL[file.change]}</span>
        {file.previousPath === null ? null : (
          <span className="font-mono text-[11px] text-muted-foreground">
            was {file.previousPath}
          </span>
        )}
        <span className="ml-auto flex items-baseline gap-2 font-mono text-[11px]">
          <span className="text-navy">+{file.added}</span>
          <span className="text-clay">−{file.removed}</span>
        </span>
      </header>

      {file.textless ? (
        <p className="m-0 px-3 py-3 text-[12px] text-muted-foreground">
          The patch names this file but carries none of its lines.
        </p>
      ) : (
        file.hunks.map((hunk) => (
          <div key={hunk.header}>
            <div className="border-b border-rule bg-surface px-3 py-1 font-mono text-[11px] text-muted-foreground">
              {hunk.header}
            </div>
            {hunk.lines.map((line, index) => {
              const key = diffLineKey(file, line);
              const note = noteFor.get(key);
              return (
                <div key={`${key}-${index}`}>
                  <Row
                    annotatable={annotatable && line.kind !== "meta"}
                    annotated={note !== undefined}
                    line={line}
                    onOpen={() => onOpen(openKey === key ? null : key)}
                  />
                  {note === undefined ? null : (
                    <NoteRow note={note} onClear={() => onSave({ ...note, note: "" })} />
                  )}
                  {openKey === key ? (
                    <NoteEditor
                      draft={draft}
                      onCancel={() => onOpen(null)}
                      onChange={onDraft}
                      onSave={() =>
                        onSave({ key, path: file.path, line: line.text, note: draft })
                      }
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}

const ROW_SKIN: Record<DiffLine["kind"], string> = {
  added: "bg-navy-wash",
  removed: "bg-clay-wash",
  context: "bg-panel",
  meta: "bg-surface"
};

const ROW_TEXT: Record<DiffLine["kind"], string> = {
  added: "text-ink",
  removed: "text-ink",
  context: "text-muted-foreground",
  meta: "text-muted-foreground italic"
};

const SIGN: Record<DiffLine["kind"], string> = {
  added: "+",
  removed: "−",
  context: " ",
  meta: " "
};

function Row({
  line,
  annotatable,
  annotated,
  onOpen
}: {
  line: DiffLine;
  annotatable: boolean;
  annotated: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <div className={`group grid grid-cols-[52px_16px_minmax(0,1fr)_28px] ${ROW_SKIN[line.kind]}`}>
      <span className="select-none border-r border-rule px-2 py-px text-right font-mono text-[11px] leading-[18px] text-muted-foreground">
        {diffLineNumber(line)}
      </span>
      <span
        aria-hidden="true"
        className={`select-none py-px text-center font-mono text-[12px] leading-[18px] ${
          line.kind === "added" ? "text-navy" : line.kind === "removed" ? "text-clay" : "text-rule"
        }`}
      >
        {SIGN[line.kind]}
      </span>
      <code
        className={`overflow-x-auto py-px pr-2 font-mono text-[12px] leading-[18px] whitespace-pre ${ROW_TEXT[line.kind]}`}
      >
        {line.text === "" ? " " : line.text}
      </code>
      {annotatable ? (
        <Button
          aria-label={`Add a note to line ${diffLineNumber(line)}`}
          className={`${
            annotated ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={onOpen}
        >
          <MessageSquarePlus aria-hidden="true" />
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}

function NoteRow({
  note,
  onClear
}: {
  note: DiffAnnotation;
  onClear: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 border-y border-navy/20 bg-navy-wash px-3 py-2">
      <span className="min-w-0 flex-1 text-[12px] leading-relaxed break-words text-ink">
        {note.note}
      </span>
      <Button aria-label="Remove this note" size="icon-sm" type="button" variant="ghost" onClick={onClear}>
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function NoteEditor({
  draft,
  onChange,
  onSave,
  onCancel
}: {
  draft: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2 border-y border-rule bg-surface px-3 py-2.5">
      <textarea
        autoFocus
        className="min-h-[64px] w-full resize-y rounded-sm border border-rule bg-panel px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none focus-visible:border-navy focus-visible:ring-[3px] focus-visible:ring-navy/25"
        placeholder="What should change about this line?"
        value={draft}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" type="button" onClick={onSave}>
          Keep this note
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {/* Said at the point of writing, not in a footnote. A person leaving a
            note on a diff is exactly the person who might assume it approves
            something. */}
        <span className="text-[11px] text-muted-foreground">
          Notes are guidance. They do not approve or ship anything.
        </span>
      </div>
    </div>
  );
}

/** The notes as one message, for the agent that has to act on them. */
export function annotationsAsCorrection(annotations: DiffAnnotation[]): string {
  return [
    "Notes on the change you submitted:",
    ...annotations.map((entry) => `- ${entry.path} — "${entry.line.trim()}": ${entry.note.trim()}`),
    "",
    "Revise only within the files this task was given."
  ].join("\n");
}
