import { describe, expect, test } from "vitest";
import { isSecureTimestampUrl, validatePublisherCertificate } from "../scripts/signing-preflight.mjs";

const policy = { publisherSubject: "CN=Hivemind AI", publisherThumbprint: "A".repeat(40) };

describe("Windows publisher signing preflight", () => {
  test("requires the exact current, private-key-backed code-signing identity", () => {
    const certificate = {
      Subject: policy.publisherSubject,
      Thumbprint: policy.publisherThumbprint,
      HasPrivateKey: true,
      CodeSigning: true,
      NotBefore: "2026-01-01T00:00:00.000Z",
      NotAfter: "2027-01-01T00:00:00.000Z"
    };
    expect(() => validatePublisherCertificate(certificate, policy, Date.parse("2026-08-29T00:00:00Z"))).not.toThrow();
    expect(() => validatePublisherCertificate({ ...certificate, HasPrivateKey: false }, policy, Date.parse("2026-08-29T00:00:00Z"))).toThrow(/private key/u);
    expect(() => validatePublisherCertificate({ ...certificate, Thumbprint: "B".repeat(40) }, policy, Date.parse("2026-08-29T00:00:00Z"))).toThrow(/mismatched/u);
  });

  test("accepts only credential-free HTTPS timestamp services", () => {
    expect(isSecureTimestampUrl("https://timestamp.example.test")).toBe(true);
    expect(isSecureTimestampUrl("http://timestamp.example.test")).toBe(false);
    expect(isSecureTimestampUrl("https://user:secret@timestamp.example.test")).toBe(false);
  });
});
