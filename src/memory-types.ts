export type MemoryResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function isMemoryProposalId(value: string): boolean {
  return /^M-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
