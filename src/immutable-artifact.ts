import { isNodeError } from "./error-detail.js";
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeImmutableJsonArtifact(
  filePath: string,
  value: unknown
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await link(tempPath, filePath);
  } catch (error: unknown) {
    if (isNodeError(error, "EEXIST")) {
      throw new Error(`immutable artifact already exists: ${filePath}`);
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true });
  }
}
