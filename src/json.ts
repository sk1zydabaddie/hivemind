import { readFile } from "node:fs/promises";
import type { SpecResult } from "./spec-format.js";

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(stripUtf8Bom(await readFile(filePath, "utf8")));
}

export function extractJsonObject(stdout: string, label: string): SpecResult<string> {
  const trimmed = stdout.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const source = fenced ? fenced[1].trim() : trimmed;
  const start = source.indexOf("{");
  if (start < 0) {
    return { ok: false, reason: `${label} output did not contain a JSON object` };
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { ok: true, value: source.slice(start, index + 1) };
      }
    }
  }
  return { ok: false, reason: `${label} output did not contain a complete JSON object` };
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
