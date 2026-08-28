import { randomBytes, timingSafeEqual } from "node:crypto";

const daemonTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

/** One unpredictable credential per daemon process. It is never derived from
 * a port, project path, PID, build id, or other public rendezvous metadata. */
export function createDaemonAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isDaemonAuthToken(value: unknown): value is string {
  return typeof value === "string" && daemonTokenPattern.test(value);
}

export function daemonAuthorization(token: string): string {
  return `Bearer ${token}`;
}

/** Constant-time after closed-shape validation. Malformed and wrong tokens
 * receive the same external answer so the daemon reveals no useful oracle. */
export function daemonTokenMatches(candidate: unknown, expected: string): boolean {
  if (!isDaemonAuthToken(candidate) || !isDaemonAuthToken(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate, "ascii"), Buffer.from(expected, "ascii"));
}

export function isAllowedDaemonOrigin(origin: string | undefined): boolean {
  return (
    origin === undefined ||
    origin === "http://localhost:1420" ||
    origin === "http://127.0.0.1:1420" ||
    origin === "http://tauri.localhost" ||
    origin === "https://tauri.localhost" ||
    origin === "tauri://localhost"
  );
}

export function isLoopbackDaemonHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost";
}

export function isLoopbackDaemonUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/?$/iu.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port || (parsed.protocol === "http:" ? "80" : ""));
    return parsed.protocol === "http:" &&
      isLoopbackDaemonHost(parsed.hostname.toLowerCase()) &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "";
  } catch {
    return false;
  }
}
