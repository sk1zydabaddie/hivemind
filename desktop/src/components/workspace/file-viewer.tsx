import { useEffect, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { ProjectFileContent, WorkspaceAction } from "@/lib/workspace-actions";

/* One file as it stands on disk, read-only.
 *
 * The diff answers "what did this task change". This answers "what does the
 * file say now", which is the question a person actually has when a rail says
 * *editing 2 files* and they want to see one.
 *
 * It cannot edit. There is no writable action behind it and no editable element
 * in it — the text is rendered, not hosted in an input. A file view that could
 * save would be a write path with no event behind it, which is the same mistake
 * as the terminal.
 */

export function FileViewer({
  path: filePath,
  onAction
}: {
  path: string;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  const [content, setContent] = useState<ProjectFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    void onAction<ProjectFileContent>({ type: "files.read", payload: { path: filePath } })
      .then((value) => {
        if (cancelled) return;
        setContent(value);
        setLoading(false);
      })
      .catch((problem: unknown) => {
        if (cancelled) return;
        /* Core's own reason. It is the one that knows whether this was a
           binary, a directory, or something it will not serve at all. */
        setError(problem instanceof Error ? problem.message : String(problem));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, onAction]);

  if (loading) {
    return <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">Reading {filePath}…</p>;
  }
  if (error !== null) {
    return (
      <p className="m-0 px-5 py-4 text-[13px] leading-relaxed text-clay" role="status">
        {error}
      </p>
    );
  }
  if (content === null) return <span />;

  const lines = content.text.split("\n");
  /* A trailing newline is a line terminator, not an empty last line. Rendering
     the phantom would put a wrong final number against every file that ends
     the way almost every file ends. */
  if (lines.at(-1) === "") lines.pop();

  return (
    <ScrollArea className="min-h-0">
      <div className="grid gap-2 px-4 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <span className="font-mono text-ink">{filePath}</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
          <span>
            {lines.length} {lines.length === 1 ? "line" : "lines"}
          </span>
        </div>
        {content.truncated ? (
          <p className="m-0 border border-amber/40 bg-amber/5 px-3 py-2 text-[12px] leading-relaxed text-amber">
            This file is longer than Hivemind will read in one go. What is below is the
            beginning of it, not all of it.
          </p>
        ) : null}
        <div className="overflow-x-auto border border-rule bg-panel">
          <table className="w-full border-collapse font-mono text-[12px] leading-relaxed">
            <tbody>
              {lines.map((line, index) => (
                // eslint-disable-next-line react/no-array-index-key -- a line's
                // identity IS its position; there is no other key.
                <tr key={index}>
                  <td className="w-[1%] border-r border-rule px-2 text-right align-top whitespace-nowrap text-muted-foreground select-none">
                    {index + 1}
                  </td>
                  <td className="px-3 align-top whitespace-pre text-ink">{line === "" ? " " : line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </ScrollArea>
  );
}
