export type ObservableInterfaceKind =
  | "named CLI flag"
  | "CLI argument or output contract"
  | "exported signature"
  | "output shape"
  | "file format";

export function observableInterfaceKind(criterion: string): ObservableInterfaceKind | null {
  const normalized = criterion.normalize("NFKC");
  if (/(?:^|\s)--[a-z0-9][a-z0-9-]*/iu.test(normalized)) return "named CLI flag";
  if (
    /\b(?:cli|command[- ]line|command)\b[^.\n]{0,180}\b(?:accepts?|supports?|requires?|flags?|options?|arguments?|stdout|stderr|exit code|output (?:format|shape|contains?|is))\b/iu.test(normalized)
  ) return "CLI argument or output contract";
  if (
    /\bexport(?:ed|s)?\b[^.\n]{0,140}\b(?:function|method|class|type|interface|signature|parameters?|return type)\b|\b(?:function|method|export) signature\b/iu.test(normalized)
  ) return "exported signature";
  if (/\b(?:output|response|stdout|stderr)\s+(?:shape|schema|format)\b/iu.test(normalized)) return "output shape";
  if (/\bfile\s+format\b|\b(?:json|jsonl|ndjson|csv|yaml|toml|xml)\s+(?:file|format|schema)\b/iu.test(normalized)) return "file format";
  return null;
}

export function observableValidityCheckProblem(check: string, requiredTests: string[]): string | null {
  const normalized = check.trim();
  if (requiredTests.some((entry) => entry.trim() === normalized)) {
    return "deterministic_validity_check must be independent of required_tests";
  }
  if (/^(?:true|exit\s+0|node(?:\.exe)?\s+-e\s+["']?(?:process\.)?exit\(0\);?["']?)$/iu.test(normalized)) {
    return "deterministic_validity_check is an unconditional pass";
  }
  return null;
}
