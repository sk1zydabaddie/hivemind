export function versionFromEpochMilliseconds(epochMilliseconds: number): string;
export function nextMonotonicVersion(
  epochMilliseconds: number,
  previousVersion?: string | null
): string;
export function parseVersion(value: string): number[];
