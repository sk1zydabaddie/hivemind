#!/usr/bin/env node

import { initProject } from "./init.js";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "init" && rest.length === 0) {
    return initProject(process.cwd());
  }

  console.error(command ? `error: unknown command ${command}` : "error: missing command");
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `error: ${error.message}` : "error: unexpected failure");
    process.exitCode = 1;
  });
