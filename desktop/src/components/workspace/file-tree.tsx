import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  ProjectFileListing,
  WorkspaceAction
} from "@/lib/workspace-actions";

/* The project's files, read-only.
 *
 * What it can do: list a directory, expand it, and hand a chosen path to
 * whoever asked for one. What it CANNOT do: create, rename, delete, move or
 * edit anything. There is no such action to dispatch — `files.list` and
 * `files.read` are the whole surface, and Core refuses `.hivemind/` and `.git/`
 * before this component is ever consulted.
 *
 * It is lazy on purpose. A recursive read of a repository at open would be a
 * long synchronous stall on somebody's monorepo, and a tree nobody waits for is
 * a tree nobody uses. One `files.list` per directory, when it is opened.
 */

interface Directory {
  loading: boolean;
  error: string | null;
  listing: ProjectFileListing | null;
}

export function FileTree({
  selectedPath,
  onAction,
  onOpenFile
}: {
  selectedPath: string | null;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  onOpenFile: (file: string) => void;
}): React.JSX.Element {
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["."]));

  const load = useCallback(
    async (directoryPath: string): Promise<void> => {
      setDirectories((current) =>
        current[directoryPath]?.listing
          ? current
          : { ...current, [directoryPath]: { loading: true, error: null, listing: null } }
      );
      try {
        const listing = await onAction<ProjectFileListing>({
          type: "files.list",
          payload: directoryPath === "." ? {} : { path: directoryPath }
        });
        setDirectories((current) => ({
          ...current,
          [directoryPath]: { loading: false, error: null, listing }
        }));
      } catch (error) {
        setDirectories((current) => ({
          ...current,
          [directoryPath]: {
            loading: false,
            /* Core's own reason, not a rewrite of it. When it refuses a path it
               says which audited action serves that thing instead, and that
               sentence is more useful than "could not open". */
            error: error instanceof Error ? error.message : String(error),
            listing: null
          }
        }));
      }
    },
    [onAction]
  );

  useEffect(() => {
    void load(".");
  }, [load]);

  const toggle = (directoryPath: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
        if (directories[directoryPath]?.listing == null) void load(directoryPath);
      }
      return next;
    });
  };

  return (
    <ScrollArea className="min-h-0">
      <div className="grid gap-px px-1.5 py-1.5" role="tree">
        <Level
          depth={0}
          directories={directories}
          expanded={expanded}
          path="."
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onToggle={toggle}
        />
      </div>
    </ScrollArea>
  );
}

function Level({
  path: directoryPath,
  depth,
  directories,
  expanded,
  selectedPath,
  onToggle,
  onOpenFile
}: {
  path: string;
  depth: number;
  directories: Record<string, Directory>;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (file: string) => void;
}): React.JSX.Element | null {
  const directory = directories[directoryPath];
  if (directory === undefined) return null;

  if (directory.loading) {
    return (
      <p className="m-0 px-2 py-1 text-[12px] text-muted-foreground" style={indent(depth)}>
        Reading…
      </p>
    );
  }
  if (directory.error !== null) {
    return (
      <p className="m-0 px-2 py-1 text-[12px] leading-relaxed text-clay" style={indent(depth)}>
        {directory.error}
      </p>
    );
  }
  if (directory.listing === null) return null;
  if (directory.listing.entries.length === 0) {
    return (
      <p className="m-0 px-2 py-1 text-[12px] text-muted-foreground" style={indent(depth)}>
        Nothing in here.
      </p>
    );
  }

  return (
    <>
      {directory.listing.entries.map((entry) =>
        entry.kind === "directory" ? (
          <div key={entry.path}>
            <Row
              depth={depth}
              icon={
                expanded.has(entry.path) ? (
                  <FolderOpen aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                )
              }
              chevron={
                expanded.has(entry.path) ? (
                  <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                )
              }
              label={entry.name}
              selected={false}
              onClick={() => onToggle(entry.path)}
            />
            {expanded.has(entry.path) ? (
              <Level
                depth={depth + 1}
                directories={directories}
                expanded={expanded}
                path={entry.path}
                selectedPath={selectedPath}
                onOpenFile={onOpenFile}
                onToggle={onToggle}
              />
            ) : null}
          </div>
        ) : (
          <Row
            depth={depth}
            icon={<FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
            key={entry.path}
            label={entry.name}
            selected={entry.path === selectedPath}
            onClick={() => onOpenFile(entry.path)}
          />
        )
      )}
    </>
  );
}

function Row({
  depth,
  icon,
  chevron,
  label,
  selected,
  onClick
}: {
  depth: number;
  icon: React.ReactNode;
  chevron?: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[12px] leading-tight transition-colors hover:bg-panel ${
        selected ? "bg-panel font-medium text-ink" : "text-ink"
      }`}
      style={indent(depth)}
      type="button"
      onClick={onClick}
    >
      {chevron ?? <span aria-hidden="true" className="size-3 shrink-0" />}
      {icon}
      <span className="truncate font-mono">{label}</span>
    </button>
  );
}

function indent(depth: number): React.CSSProperties {
  return { paddingLeft: `${depth * 12 + 6}px` };
}
