import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useEffect,
  type AriaRole,
  type ReactNode
} from "react";

import { cn } from "@/lib/utils";

interface VirtualListProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  estimateSize?: number;
  overscan?: number;
  className?: string;
  ariaLabel: string;
  role?: AriaRole;
  live?: "off" | "polite";
  relevant?: "additions" | "additions text";
  testId?: string;
  followEnd?: boolean;
}

interface RowLayout {
  key: string;
  index: number;
  start: number;
  size: number;
}

/**
 * A small dynamic-height virtual list for the two append-only archive surfaces.
 *
 * Rows are measured after paint and estimates are replaced in one shared
 * layout. Only the visible range plus a fixed overscan is mounted, so project
 * lifetime never controls DOM membership. This is presentation only: callers
 * still receive their records from the audited dispatcher.
 */
export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  estimateSize = 84,
  overscan = 4,
  className,
  ariaLabel,
  role = "region",
  live = "off",
  relevant,
  testId,
  followEnd = false
}: VirtualListProps<T>): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sizesRef = useRef(new Map<string, number>());
  const rowObserversRef = useRef(new Map<string, ResizeObserver>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 1 });

  const layout = useMemo(() => {
    let start = 0;
    const rows = items.map((item, index): RowLayout => {
      const key = itemKey(item);
      const size = sizesRef.current.get(key) ?? estimateSize;
      const row = { key, index, start, size };
      start += size;
      return row;
    });
    return { rows, total: start };
  }, [estimateSize, itemKey, items, measureVersion]);

  const visible = useMemo(() => {
    if (layout.rows.length === 0) return [];
    const from = Math.max(0, viewport.top - estimateSize * overscan);
    const to = viewport.top + viewport.height + estimateSize * overscan;
    return layout.rows.filter((row) => row.start + row.size >= from && row.start <= to);
  }, [estimateSize, layout.rows, overscan, viewport]);

  const sampleViewport = useCallback(() => {
    const element = viewportRef.current;
    if (element === null) return;
    setViewport({ top: element.scrollTop, height: Math.max(1, element.clientHeight) });
  }, []);

  useLayoutEffect(() => {
    sampleViewport();
    const element = viewportRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sampleViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sampleViewport]);

  useLayoutEffect(() => {
    if (!followEnd || viewportRef.current === null) return;
    viewportRef.current.scrollTop = layout.total;
    sampleViewport();
  }, [followEnd, layout.total, sampleViewport]);

  const measure = useCallback((key: string, element: HTMLDivElement | null) => {
    rowObserversRef.current.get(key)?.disconnect();
    rowObserversRef.current.delete(key);
    if (element === null) return;
    const update = (): void => {
      const size = Math.ceil(element.getBoundingClientRect().height);
      if (size <= 0 || sizesRef.current.get(key) === size) return;
      sizesRef.current.set(key, size);
      setMeasureVersion((value) => value + 1);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    rowObserversRef.current.set(key, observer);
  }, []);

  useEffect(() => () => {
    for (const observer of rowObserversRef.current.values()) observer.disconnect();
    rowObserversRef.current.clear();
  }, []);

  return (
    <div
      aria-label={ariaLabel}
      aria-live={live}
      aria-relevant={relevant}
      className={cn(
        "relative min-h-0 overflow-auto focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-navy focus-visible:outline-offset-[-2px]",
        className
      )}
      data-testid={testId}
      ref={viewportRef}
      role={role}
      tabIndex={0}
      onScroll={sampleViewport}
    >
      <div className="relative w-full" style={{ height: `${String(layout.total)}px` }}>
        {visible.map((row) => (
          <div
            className="absolute inset-x-0 top-0"
            data-virtual-index={row.index}
            key={row.key}
            ref={(element) => measure(row.key, element)}
            style={{ transform: `translateY(${String(row.start)}px)` }}
          >
            {renderItem(items[row.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}
