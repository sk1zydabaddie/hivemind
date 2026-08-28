/**
 * Phase 0 containment boundary.
 *
 * The former release commands could sign an existing installer with an exposed
 * passwordless key and publish it against an unrelated commit. They stay
 * unavailable until one clean pipeline binds source, artifact, protected
 * signing, pre-publication verification, and installed identity.
 */

console.error(
  "Release pipeline contained: signing and publication are disabled until provenance, protected signing, and pre-publication verification are rebuilt."
);
process.exitCode = 1;
