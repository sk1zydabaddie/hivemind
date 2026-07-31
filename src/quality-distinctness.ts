import { createHash } from "node:crypto";

export interface PatchDistinctness {
  left_draft_id: string;
  right_draft_id: string;
  exact_patch_match: boolean;
  changed_line_set_jaccard_similarity: number;
  shared_changed_lines: number;
  union_changed_lines: number;
}

export function measurePatchDistinctness(
  leftDraftId: string,
  leftPatch: string,
  rightDraftId: string,
  rightPatch: string
): PatchDistinctness {
  const leftLines = changedLineSet(leftPatch);
  const rightLines = changedLineSet(rightPatch);
  const shared = [...leftLines].filter((line) => rightLines.has(line)).length;
  const union = new Set([...leftLines, ...rightLines]).size;
  return {
    left_draft_id: leftDraftId,
    right_draft_id: rightDraftId,
    exact_patch_match: hashText(leftPatch) === hashText(rightPatch),
    changed_line_set_jaccard_similarity: union === 0 ? 1 : shared / union,
    shared_changed_lines: shared,
    union_changed_lines: union
  };
}

function changedLineSet(patch: string): Set<string> {
  const result = new Set<string>();
  for (const line of patch.replace(/\r\n/gu, "\n").split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      const normalized = line.slice(1).trim().replace(/\s+/gu, " ");
      if (normalized !== "") {
        result.add(normalized);
      }
    }
  }
  return result;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
