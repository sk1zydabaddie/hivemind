import { readFile } from "node:fs/promises";

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(stripUtf8Bom(await readFile(filePath, "utf8")));
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
