export function isSecureTimestampUrl(value: string): boolean;
export function validatePublisherCertificate(
  certificate: Record<string, unknown>,
  policy: { publisherSubject: string; publisherThumbprint: string },
  nowMs: number
): void;
