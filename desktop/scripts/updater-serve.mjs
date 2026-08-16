/**
 * The local stand-in for a release host.
 *
 * Twenty lines because it is a stand-in and should stay obviously replaceable:
 * a real endpoint is a GitHub release URL and this script disappears. It exists
 * so the updater can be exercised end to end — including signature verification
 * and the actual NSIS swap — on one machine with nothing published anywhere.
 *
 * Deliberately bound to 127.0.0.1. It serves an installer, and an installer
 * served on a LAN interface is an invitation.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const updates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "updates");
const PORT = Number(process.env.UPDATER_PORT ?? 8787);

createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? "/").split("?")[0].replace(/^\//u, ""));
  /* No traversal: the served set is exactly what `release-local.mjs` wrote. */
  const file = path.join(updates, path.basename(name));
  if (name === "" || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not published: ${name}\n`);
    console.log(`404 ${name}`);
    return;
  }
  response.writeHead(200, {
    "content-type": file.endsWith(".json") ? "application/json" : "application/octet-stream",
    "content-length": statSync(file).size
  });
  createReadStream(file).pipe(response);
  console.log(`200 ${name}`);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${updates} on http://127.0.0.1:${PORT}`);
  console.log("this is the dev stand-in for a release host; a real endpoint replaces it");
});
