/* Stamp the build's version, BEFORE the Tauri CLI is invoked.
 *
 * This used to live at the end of `prepare-bundle.mjs`, which runs as Tauri's
 * `beforeBuildCommand`. That could never have worked, and did not:
 *
 *     tauri build --bundles nsis --config src-tauri/gen/version.conf.json
 *     error: invalid value for '--config': failed to read configuration file
 *
 * The CLI validates `--config` while parsing arguments, which is strictly
 * before it runs `beforeBuildCommand`. So the file that generates the version
 * was scheduled to run after the file was already required to exist. Because
 * `src-tauri/gen/` is gitignored, EVERY clean checkout hit this -- the calendar
 * versioning shipped broken and stayed broken, while the installed binary went
 * on reporting the hardcoded 0.0.0 that the versioning existed to replace.
 *
 * Two rules come out of it, and they are why this is its own file:
 *
 * 1. **A generated input must be generated before the tool that reads it
 *    starts**, not by a hook that tool runs. A build hook cannot produce the
 *    build's own arguments.
 *
 * 2. **Stamp exactly once per build.** The tempting fix was to leave the
 *    stamping in `prepare-bundle.mjs` and also call it earlier. That stamps
 *    twice, and if the clock crosses a minute between them the build uses the
 *    first version while `app-version.txt` records the second -- so
 *    `install-local.mjs` would look for an installer that does not exist and
 *    report INSTALL DID NOT TAKE against a perfectly good install. A verifier
 *    that can fail on a correct build is worse than none.
 *
 * `prepare-bundle.mjs` keeps everything a build needs regardless of how it was
 * started, and stays wired to `beforeBuildCommand` so a bare `tauri build`
 * still gets a fresh frontend. Versioning is a SHIPPING concern; it belongs to
 * the shipping script.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = path.join(desktopRoot, "src-tauri", "gen");

/* A version that actually changes, and the reason it has to.
 *
 * `tauri.conf.json` carries a hardcoded `0.0.0`. Without this overlay every
 * build produces an identically-named installer, every uninstall entry reads
 * `DisplayVersion 0.0.0` forever, and Windows cannot tell an upgrade from a
 * reinstall. The observed symptom was the Start menu opening an eleven-day-old
 * build with nothing anywhere indicating it was stale -- because nothing
 * anywhere WAS different.
 *
 * Calendar version, `YY.MMDD.HHmm`, because this project has no release cadence
 * to hang semver off and a date is the only thing that is honestly monotonic
 * here. Each field stays under 65536, which the Windows version resource
 * requires -- `20260814` would not, which is why the year is two digits and the
 * date is packed rather than concatenated.
 *
 * Written to a generated overlay rather than edited into the checked-in config:
 * a build must not dirty the working tree, and `tauri build --config` merges
 * this over the base.
 */
const stamp = new Date();
const pad = (value, width) => String(value).padStart(width, "0");
const version = [
  stamp.getFullYear() % 100,
  `${stamp.getMonth() + 1}${pad(stamp.getDate(), 2)}`,
  `${pad(stamp.getHours(), 2)}${pad(stamp.getMinutes(), 2)}`
].join(".");

await mkdir(generatedDir, { recursive: true });
await writeFile(
  path.join(generatedDir, "version.conf.json"),
  `${JSON.stringify({ version }, null, 2)}\n`,
  "utf8"
);
/* Readable by the app itself, so "which build am I running" is answerable from
   inside rather than from the uninstall registry -- and read by
   `install-local.mjs` to name the installer it must verify landed. */
await writeFile(path.join(generatedDir, "app-version.txt"), `${version}\n`, "utf8");
console.log(`bundle version ${version}`);
