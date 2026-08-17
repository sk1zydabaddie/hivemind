/**
 * ⚠ EXPERIMENTAL — THIS PANEL IS TEMPORARY AND WILL BE DELETED.
 *
 * It exists to settle two questions by looking rather than by arguing: what
 * corner radius, and what typeface. When they are settled, the chosen values
 * become the two lines they already write —
 *
 *     --radius: <n>px;
 *     --font-sans: "<family>", ...;
 *
 * — and this file is removed. Deleting it is deliberately ONE deletion plus one
 * import in `settings-dialog.tsx`; `theme-playground.test.ts` asserts that,
 * because a "temporary" thing that has grown roots into six files is a permanent
 * thing nobody decided to keep.
 *
 * ## Why it writes the real tokens
 *
 * A preview pane with its own styles answers a different question than the one
 * being asked. This sets `--radius`, `--font-sans` and `--font-mono` on
 * `document.documentElement`, which is the same cascade the app is built on, so
 * every button, panel, input, dialog and badge changes because the app changed —
 * not because a mock was drawn to look like it had. What you see is what shipping
 * would look like, and if something breaks under a new value, it breaks here too.
 *
 * ## What it does NOT do
 *
 * It holds no authoritative state and touches nothing Core owns. The choice
 * lives in `localStorage`, which is right for a UI preference on a temporary
 * panel and wrong for anything else: no gate, no capability, no project state is
 * readable or writable from here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

/** The one key this panel owns. Removed with the panel. */
const STORE = "hivemind.experimental.theme";

/** The shipped values, restated so "Reset" is exact rather than approximate. */
const SHIPPED = { radius: 5, sans: "", mono: "" } as const;

/**
 * How the families are sourced, which the panel states out loud.
 *
 * **Bundled** means shipped inside the app: Geist and Geist Mono, already
 * dependencies, already loaded. **System** means installed on this machine and
 * used by reference — nothing is downloaded and nothing is added to the bundle.
 *
 * That split is the whole reason there are twenty-plus options without the
 * install growing: bundling twenty families would add megabytes to every build
 * to answer a question once.
 *
 * The catch, and it is the reason `available` exists below: a system family is
 * only there if it is *there*. A picker listing families this machine does not
 * have would silently fall back to Segoe UI and show the same rendering under
 * six different names — a control that appears to work and does nothing. So the
 * list is filtered by measurement at runtime, and anything missing is reported
 * rather than offered. Eleven of the candidates below are absent on this
 * machine and correctly disappear.
 */
type Family = {
  readonly label: string;
  readonly stack: string;
  readonly origin: "bundled" | "system";
  readonly kind: "geometric" | "grotesque" | "humanist" | "serif" | "mono";
};

const FAMILIES: readonly Family[] = [
  { label: "Geist", stack: '"Geist Variable"', origin: "bundled", kind: "grotesque" },
  { label: "Geist Mono", stack: '"Geist Mono Variable"', origin: "bundled", kind: "mono" },

  { label: "Segoe UI", stack: '"Segoe UI"', origin: "system", kind: "humanist" },
  { label: "Segoe UI Variable", stack: '"Segoe UI Variable Text"', origin: "system", kind: "humanist" },
  { label: "Aptos", stack: "Aptos", origin: "system", kind: "grotesque" },
  { label: "Calibri", stack: "Calibri", origin: "system", kind: "humanist" },
  { label: "Candara", stack: "Candara", origin: "system", kind: "humanist" },
  { label: "Corbel", stack: "Corbel", origin: "system", kind: "humanist" },
  { label: "Verdana", stack: "Verdana", origin: "system", kind: "grotesque" },
  { label: "Tahoma", stack: "Tahoma", origin: "system", kind: "grotesque" },
  { label: "Trebuchet MS", stack: '"Trebuchet MS"', origin: "system", kind: "humanist" },
  { label: "Century Gothic", stack: '"Century Gothic"', origin: "system", kind: "geometric" },
  { label: "Gill Sans MT", stack: '"Gill Sans MT"', origin: "system", kind: "humanist" },
  { label: "Bahnschrift", stack: "Bahnschrift", origin: "system", kind: "geometric" },
  { label: "Ebrima", stack: "Ebrima", origin: "system", kind: "humanist" },
  { label: "Lucida Sans", stack: '"Lucida Sans Unicode"', origin: "system", kind: "humanist" },
  { label: "Franklin Gothic", stack: '"Franklin Gothic Book"', origin: "system", kind: "grotesque" },
  { label: "Arial", stack: "Arial", origin: "system", kind: "grotesque" },
  { label: "Arial Nova", stack: '"Arial Nova"', origin: "system", kind: "grotesque" },
  { label: "Microsoft Sans Serif", stack: '"Microsoft Sans Serif"', origin: "system", kind: "grotesque" },

  { label: "Georgia", stack: "Georgia", origin: "system", kind: "serif" },
  { label: "Cambria", stack: "Cambria", origin: "system", kind: "serif" },
  { label: "Constantia", stack: "Constantia", origin: "system", kind: "serif" },
  { label: "Sitka", stack: '"Sitka Text"', origin: "system", kind: "serif" },
  { label: "Palatino", stack: '"Palatino Linotype"', origin: "system", kind: "serif" },
  { label: "Book Antiqua", stack: '"Book Antiqua"', origin: "system", kind: "serif" },
  { label: "Times New Roman", stack: '"Times New Roman"', origin: "system", kind: "serif" },
  { label: "Garamond", stack: "Garamond", origin: "system", kind: "serif" },
  { label: "Bookman Old Style", stack: '"Bookman Old Style"', origin: "system", kind: "serif" },
  { label: "Rockwell", stack: "Rockwell", origin: "system", kind: "serif" },

  { label: "Cascadia Code", stack: '"Cascadia Code"', origin: "system", kind: "mono" },
  { label: "Cascadia Mono", stack: '"Cascadia Mono"', origin: "system", kind: "mono" },
  { label: "Consolas", stack: "Consolas", origin: "system", kind: "mono" },
  { label: "Courier New", stack: '"Courier New"', origin: "system", kind: "mono" },
  { label: "Lucida Console", stack: '"Lucida Console"', origin: "system", kind: "mono" }
];

/** The first family name out of a stack, for measuring. */
const firstName = (stack: string): string => (stack.split(",")[0] ?? "").replaceAll('"', "").trim();

/**
 * Is this family really installed?
 *
 * `document.fonts.check()` answers for `@font-face` families and reports true
 * for locally installed ones whether or not they exist, so availability is
 * MEASURED: render a wide string in the candidate against a deliberately
 * mismatched fallback and compare widths. An absent family measures identical to
 * its fallback, to the pixel.
 */
const available = (family: string, ctx: CanvasRenderingContext2D): boolean => {
  const probe = "mmmmmMMMMMwwwiiil1|0OQ@#gjpqy";
  const width = (stack: string): number => {
    ctx.font = `48px ${stack}`;
    return ctx.measureText(probe).width;
  };
  return (["monospace", "serif", "sans-serif"] as const).some(
    (fallback) => Math.abs(width(`"${family}", ${fallback}`) - width(fallback)) > 0.5
  );
};

/**
 * The x-height of a family at a known size, which is what makes two faces at the
 * same pixel size look like different sizes.
 *
 * Measured from the glyph box rather than from the line box. The first version of
 * this read `getBoundingClientRect().height` on a span, which returns the LINE
 * height and was identical (150) for every family — a measurement that could
 * only return one answer.
 */
const xHeightRatio = (family: string, ctx: CanvasRenderingContext2D): number => {
  ctx.font = `100px "${family}", sans-serif`;
  const metrics = ctx.measureText("x");
  const ascent = metrics.actualBoundingBoxAscent;
  return Number.isFinite(ascent) && ascent > 0 ? ascent / 100 : 0;
};

type Fit = { readonly label: string; readonly detail: string };

/**
 * Does anything actually break at the current settings?
 *
 * Changing family or radius changes metrics, and this app is full of
 * fixed-height controls (`h-8` buttons, `h-9` inputs, one-line truncating
 * labels) that cannot grow to accommodate a taller face. Rather than hope, this
 * measures the live DOM and names what clips.
 *
 * It reports rather than repairs, on purpose. A panel that quietly grew every
 * control to fit would be answering "does this typeface work here?" with
 * "yes, once I changed the layout" — which is not the question.
 */
const findClipping = (): readonly Fit[] => {
  const offenders: Fit[] = [];
  const seen = new Set<string>();
  for (const element of document.querySelectorAll<HTMLElement>(
    'button, input, [data-slot="badge"], [role="tab"], h1, h2, h3, h4, label, td, th'
  )) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const box = element.getBoundingClientRect();
    if (box.height === 0 || box.width === 0) continue;

    /* Vertical clipping: content taller than the box, on something that cannot
       grow. 1px of tolerance for subpixel rounding. */
    const tooTall = element.scrollHeight > element.clientHeight + 1 && style.overflowY !== "auto";
    /* Horizontal: a truncating label is DESIGNED to ellipsise, so only an
       element that overflows without any means of hiding it is a fault. */
    const tooWide =
      element.scrollWidth > element.clientWidth + 1 &&
      style.overflowX === "visible" &&
      style.textOverflow !== "ellipsis";
    if (!tooTall && !tooWide) continue;

    const name =
      element.getAttribute("data-slot") ??
      element.getAttribute("role") ??
      element.tagName.toLowerCase();
    const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 34);
    const key = `${name}:${text}:${String(tooTall)}${String(tooWide)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offenders.push({
      label: `${name}${text === "" ? "" : ` “${text}”`}`,
      detail: tooTall
        ? `text is ${String(element.scrollHeight - element.clientHeight)}px taller than the box`
        : `text is ${String(element.scrollWidth - element.clientWidth)}px wider than the box`
    });
    if (offenders.length >= 12) break;
  }
  return offenders;
};

type Settings = { radius: number; sans: string; mono: string; normalise: boolean };

const read = (): Settings => {
  const fallback: Settings = { ...SHIPPED, normalise: true };
  try {
    const raw = localStorage.getItem(STORE);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      radius: typeof parsed.radius === "number" ? parsed.radius : fallback.radius,
      sans: typeof parsed.sans === "string" ? parsed.sans : fallback.sans,
      mono: typeof parsed.mono === "string" ? parsed.mono : fallback.mono,
      normalise: parsed.normalise !== false
    };
  } catch {
    /* A corrupt key is not worth a crash on a panel that is being deleted. */
    return fallback;
  }
};

/**
 * Applied at module load as well as from the panel.
 *
 * Otherwise the app would open on the shipped tokens and only adopt the chosen
 * ones when somebody opened settings — which would make every screenshot and
 * every judgement about the choice wrong until the panel had been visited.
 */
export function applyExperimentalTheme(): void {
  if (typeof document === "undefined") return;
  const { radius, sans, mono, normalise } = read();
  const root = document.documentElement;
  root.style.setProperty("--radius", `${String(radius)}px`);
  if (sans === "") root.style.removeProperty("--font-sans");
  else root.style.setProperty("--font-sans", `${sans}, ui-sans-serif, system-ui, sans-serif`);
  if (mono === "") root.style.removeProperty("--font-mono");
  else root.style.setProperty("--font-mono", `${mono}, ui-monospace, monospace`);

  /* Normalising apparent size. `font-size-adjust: <number>` sets the x-height
     as a fraction of the font size, so two families at 13px read as the same
     size instead of one looking a step larger. The target is GEIST'S OWN ratio,
     measured rather than guessed, so turning this on changes nothing while Geist
     is selected and only ever corrects a substitute toward it.
     The two-value `ex-height <n>` form is not supported by this engine — checked
     — so the plain number is used. */
  if (!normalise || sans === "") {
    root.style.removeProperty("font-size-adjust");
    return;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const target = xHeightRatio("Geist Variable", ctx);
  if (target > 0) root.style.setProperty("font-size-adjust", target.toFixed(3));
}

export function ThemePlayground(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(read);
  const [clipping, setClipping] = useState<readonly Fit[]>([]);

  /* Measured once: which of the candidates this machine actually has, and what
     each one's x-height is. */
  const { families, absent } = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx === null) return { families: FAMILIES, absent: [] as string[] };
    const present: Family[] = [];
    const missing: string[] = [];
    for (const family of FAMILIES) {
      if (available(firstName(family.stack), ctx)) present.push(family);
      else missing.push(family.label);
    }
    return { families: present, absent: missing };
  }, []);

  const ratios = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    const out = new Map<string, number>();
    if (ctx === null) return out;
    for (const family of families) out.set(family.label, xHeightRatio(firstName(family.stack), ctx));
    return out;
  }, [families]);

  /* Write the tokens, then measure what the new metrics did to the layout. The
     re-measure is deferred two frames: one for the style to apply, one for the
     browser to reflow at the new metrics. Measuring in the same tick reads the
     OLD layout and reports a clean bill for a broken screen. */
  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify(settings));
    applyExperimentalTheme();
    let raf = 0;
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        setClipping(findClipping());
      });
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>): void => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const sansFamilies = families.filter((family) => family.kind !== "mono");
  const monoFamilies = families.filter((family) => family.kind === "mono");
  const bundled = families.filter((family) => family.origin === "bundled").length;

  return (
    <section className="grid gap-4 rounded-md border border-amber/40 bg-amber-wash p-4">
      {/* Marked plainly, and in the loudest thing available short of the
          attention edge -- which stays reserved for work that needs a person. */}
      <header className="grid gap-1">
        <div className="flex items-baseline gap-2">
          <strong className="text-[12px] font-semibold tracking-label text-ink uppercase">
            Experimental
          </strong>
          <span className="text-[11px] text-muted-foreground">
            temporary panel · will be deleted once a radius and a typeface are chosen
          </span>
        </div>
        <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
          These write the app&apos;s real tokens, so what you see is what shipping looks
          like — not a preview with its own styles. Settling on values means copying
          two lines into <code className="font-mono text-[11px]">styles.css</code> and
          deleting this panel.
        </p>
      </header>

      {/* ── Radius ─────────────────────────────────────────────────────── */}
      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <label
            className="text-[11px] font-medium tracking-label text-muted-foreground uppercase"
            htmlFor="theme-radius"
          >
            Corner radius
          </label>
          <span className="font-mono text-[12px] tabular-nums text-ink">
            {settings.radius}px
            {settings.radius === 0 ? " · square" : null}
            {settings.radius >= 18 ? " · pill" : null}
          </span>
        </div>
        <input
          className="h-5 w-full cursor-pointer accent-navy"
          id="theme-radius"
          max={20}
          min={0}
          onChange={(event) => {
            update({ radius: Number(event.target.value) });
          }}
          step={1}
          type="range"
          value={settings.radius}
        />
        {/* One global scale, not per element: the slider writes `--radius` and
            the other six steps are calc() multiples of it, so buttons, panels,
            cards, inputs, dialogs and badges all move together. At 20px a
            32px-tall control is fully pill; at 0 everything is square. */}
        <p className="m-0 text-[11px] text-muted-foreground">
          One global scale. The other six steps are multiples of this, so every
          rounded thing moves together. Shipped value is {SHIPPED.radius}px.
        </p>
      </div>

      {/* ── Typeface ───────────────────────────────────────────────────── */}
      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
            Typeface
          </span>
          <span className="text-[11px] text-muted-foreground">
            {families.length} available · {bundled} bundled · {families.length - bundled} from
            this machine
          </span>
        </div>

        <div className="grid gap-1.5">
          <label className="text-[11px] text-muted-foreground" htmlFor="theme-sans">
            Interface
          </label>
          <select
            className="h-8 w-full rounded-md border border-rule bg-panel px-2 text-[13px] text-ink"
            id="theme-sans"
            onChange={(event) => {
              update({ sans: event.target.value });
            }}
            value={settings.sans}
          >
            <option value="">Geist — shipped default</option>
            {(["geometric", "grotesque", "humanist", "serif"] as const).map((kind) => {
              const group = sansFamilies.filter((family) => family.kind === kind);
              if (group.length === 0) return null;
              return (
                <optgroup key={kind} label={kind}>
                  {group.map((family) => (
                    <option key={family.label} value={family.stack}>
                      {family.label} · {family.origin}
                      {(ratios.get(family.label) ?? 0) > 0
                        ? ` · x-height ${(ratios.get(family.label) ?? 0).toFixed(2)}`
                        : ""}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>

        <div className="grid gap-1.5">
          <label className="text-[11px] text-muted-foreground" htmlFor="theme-mono">
            Figures and code
          </label>
          <select
            className="h-8 w-full rounded-md border border-rule bg-panel px-2 font-mono text-[13px] text-ink"
            id="theme-mono"
            onChange={(event) => {
              update({ mono: event.target.value });
            }}
            value={settings.mono}
          >
            <option value="">Geist Mono — shipped default</option>
            {monoFamilies.map((family) => (
              <option key={family.label} value={family.stack}>
                {family.label} · {family.origin}
              </option>
            ))}
          </select>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
          <input
            checked={settings.normalise}
            className="cursor-pointer accent-navy"
            onChange={(event) => {
              update({ normalise: event.target.checked });
            }}
            type="checkbox"
          />
          Normalise apparent size, so a substitute at 13px reads the same size as Geist
        </label>

        {absent.length > 0 ? (
          <p className="m-0 text-[11px] text-muted-foreground/80">
            Not installed here, so not offered: {absent.join(", ")}. Listing them would
            show the fallback under someone else&apos;s name.
          </p>
        ) : null}
      </div>

      {/* ── Does it still fit? ─────────────────────────────────────────── */}
      <div className="grid gap-1.5 border-t border-amber/30 pt-3">
        <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
          Fit check
        </span>
        {clipping.length === 0 ? (
          <p className="m-0 text-[11px] text-muted-foreground">
            Nothing on this screen is clipped at these settings. Measured live from the
            layout, not assumed — but it only sees what is currently rendered, so check
            the Work tab and a dialog too.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {clipping.map((fit) => (
              <li className="text-[11px] text-clay" key={`${fit.label}${fit.detail}`}>
                <strong className="font-medium">{fit.label}</strong> — {fit.detail}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Specimen ───────────────────────────────────────────────────── */}
      <div className="grid gap-2 border-t border-amber/30 pt-3">
        <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
          Specimen
        </span>
        <p className="m-0 text-[13px] leading-relaxed text-ink">
          Three agents are working. 0/4 tasks done, 6 files open, running 1m 40s.
        </p>
        <p className="m-0 font-mono text-[12px] text-muted-foreground">
          src/slugify.js · 622.6K + 0 held / 2.5M · bd64af8e7b
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" type="button">
            Approve and start
          </Button>
          <Button size="sm" type="button" variant="outline">
            Start over
          </Button>
          <Button size="sm" type="button" variant="ghost">
            View plan
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-amber/30 pt-3">
        <Button
          onClick={() => {
            setSettings({ ...SHIPPED, normalise: true });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Reset to shipped
        </Button>
        <span className="font-mono text-[11px] text-muted-foreground">
          --radius: {settings.radius}px;{" "}
          {settings.sans === "" ? "" : `--font-sans: ${settings.sans}, …;`}
        </span>
      </div>
    </section>
  );
}
