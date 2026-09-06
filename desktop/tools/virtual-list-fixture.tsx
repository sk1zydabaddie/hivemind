/** Controlled geometry for the real virtual list. Browser verification only;
 * not imported by the desktop entrypoint and never a live-project replay. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/ui/button";
import { VirtualList } from "../src/components/ui/virtual-list";
import "../src/styles.css";

function VirtualListFixture(): React.JSX.Element {
  const sequence = useRef(200);
  const [rows, setRows] = useState(() => Array.from({ length: 200 }, (_, index) => ({ key: `row-${index}`, height: 80 })));
  const [pinned, setPinned] = useState(true);
  const [latest, setLatest] = useState(0);
  const [follow, setFollow] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [height, setHeight] = useState(300);
  useEffect(() => {
    // The probe changes actual React inputs and measures actual DOM geometry;
    // it cannot replace the list's scrolling, refs or ResizeObservers.
    Object.assign(window, { virtualListFixture: {
      resizeRow: (key: string, height: number) => setRows((current) => current.map((row) => row.key === key ? { ...row, height } : row)),
      append: () => setRows((current) => [...current, ...Array.from({ length: 5 }, () => ({ key: `row-${sequence.current++}`, height: 80 }))]),
      prepend: () => setRows((current) => [...Array.from({ length: 5 }, () => ({ key: `row-${sequence.current++}`, height: 80 })), ...current]),
      resizeViewport: setHeight,
      setFollow,
      reset: () => setGeneration((value) => value + 1)
    } });
    return () => { Reflect.deleteProperty(window, "virtualListFixture"); };
  }, []);
  return (
    <main className="flex h-screen flex-col gap-3 bg-panel p-4 text-ink">
      <h1>Virtual list geometry fixture — not a live project</h1>
      <div className="relative min-h-0" style={{ height }} data-testid="virtual-fixture" data-count={rows.length}>
        <VirtualList key={generation} items={rows} itemKey={(row) => row.key}
          ariaLabel="Fixture rows" testId="virtual-fixture-list" className="h-full"
          estimateSize={80} followEnd={follow} onPinnedChange={setPinned} scrollToEndRequest={latest}
          renderItem={(row) => <div className="border-b border-rule p-3" style={{ minHeight: row.height }}>{row.key}: measured content</div>} />
        {!pinned && follow ? <Button aria-label="Latest fixture rows" className="absolute right-3 bottom-3" size="sm" variant="secondary" onClick={() => setLatest((value) => value + 1)}>Latest</Button> : null}
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("The virtual-list fixture root is missing.");
createRoot(root).render(<VirtualListFixture />);
