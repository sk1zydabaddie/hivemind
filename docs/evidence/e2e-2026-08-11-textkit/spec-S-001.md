# Spec: Add slugify, truncate and wordCount text helpers with tests and docs
status: ratified
## Problem / goal

Add three independent text helpers, each with its own module and tests, and document them in the README.

## Context

`textkit` is a small ESM package. Each helper lives in its own file under
`src/`, is re-exported from `src/index.js`, and has its own test file under
`test/`. Tests run with `npm test` (`node --test`).

## Users / stakeholders

Developers importing `textkit` in other projects.

## In scope

- `slugify(text)`: lowercase, url-safe slug.
- `truncate(text, max)`: shorten to `max` characters, appending an ellipsis
  only when the string actually had to be cut.
- `wordCount(text)`: number of whitespace-separated words.
- A test file per helper.
- `README.md` documenting all three.

## Non-goals

- No changes to `capitalize`.
- No new runtime dependencies.
- No build step, bundler, or TypeScript migration.
- No changes to `package.json`.

## Constraints

- Plain ESM JavaScript, Node 22, no dependencies.
- Each helper in its own file; helpers must not import one another.
- `npm test` must pass.

## Acceptance criteria

- `npm test` passes with tests covering each helper, including empty input and
  a non-string input rejected with a `TypeError`.
- `truncate` appends an ellipsis only when it truncated, and `max` is the
  length of the returned string including the ellipsis; a test covers the exact
  boundary length.
- All three helpers are exported from `src/index.js` and documented in README.

## Risks / unknowns

- Ellipsis handling at the exact boundary length is easy to get off by one.

## Open questions
