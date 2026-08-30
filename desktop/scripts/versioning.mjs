const fieldBase = 65_536;
const maxField = fieldBase - 1;

/**
 * Encode an epoch millisecond into the three numeric fields Windows and Tauri
 * share. Unlike the former minute stamp, this is globally ordered at
 * millisecond resolution and every field remains a valid Windows version
 * component.
 */
export function versionFromEpochMilliseconds(epochMilliseconds) {
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
    throw new Error("release time must be a non-negative safe integer of epoch milliseconds");
  }
  const major = Math.floor(epochMilliseconds / (fieldBase * fieldBase));
  const remainder = epochMilliseconds % (fieldBase * fieldBase);
  const minor = Math.floor(remainder / fieldBase);
  const patch = remainder % fieldBase;
  if (major > maxField) throw new Error("release time exceeds the Windows version field range");
  return `${major}.${minor}.${patch}`;
}

export function nextMonotonicVersion(epochMilliseconds, previousVersion) {
  const candidate = parseVersion(versionFromEpochMilliseconds(epochMilliseconds));
  if (previousVersion === undefined || previousVersion === null || previousVersion === "") {
    return formatVersion(candidate);
  }
  const previous = parseVersion(previousVersion);
  if (compareFields(candidate, previous) > 0) return formatVersion(candidate);

  const advanced = [...previous];
  advanced[2] += 1;
  if (advanced[2] > maxField) {
    advanced[2] = 0;
    advanced[1] += 1;
  }
  if (advanced[1] > maxField) {
    advanced[1] = 0;
    advanced[0] += 1;
  }
  if (advanced[0] > maxField) throw new Error("the monotonic Windows version range is exhausted");
  return formatVersion(advanced);
}

export function parseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`invalid three-field numeric version: ${String(value)}`);
  }
  const fields = value.split(".").map(Number);
  if (fields.some((field) => !Number.isSafeInteger(field) || field < 0 || field > maxField)) {
    throw new Error(`version field exceeds the Windows range: ${value}`);
  }
  return fields;
}

function compareFields(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function formatVersion(fields) {
  return fields.join(".");
}
