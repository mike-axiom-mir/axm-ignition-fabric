#!/usr/bin/env node
import { describeCapability } from "../src/capability.js";

function usage() {
  return [
    "AXM Ignition Fabric package interface",
    "",
    "Commands:",
    "  describe  Print the machine-readable capability boundary",
    "  demo      Compare eager and bounded Ignition execution"
  ].join("\n");
}

const [command] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`${usage()}\n`);
} else if (command === "describe") {
  process.stdout.write(`${JSON.stringify({ command, capability: describeCapability() }, null, 2)}\n`);
} else if (command === "demo") {
  await import("./run-demo.mjs");
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
  process.exitCode = 2;
}
