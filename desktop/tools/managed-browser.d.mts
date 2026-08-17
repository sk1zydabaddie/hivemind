/* `tools/` is plain JavaScript on purpose: it runs under bare node, before and
   outside the bundle, so it cannot depend on the TypeScript build. This is the
   one seam where a test reaches across that boundary, so the boundary gets a
   declaration rather than an `any`. */
export declare function findBrowser(candidates: string[], port: number): string;

export declare function ensureHarness(options: {
  base: string;
  port: string | number;
  root: string;
  /** Serve a production build under the exact application CSP. */
  staticRoot?: string;
  csp?: string;
  /** Injected by tests; production reads the per-platform list. */
  candidates?: string[];
}): Promise<{ stop: () => void }>;
