#!/usr/bin/env node
import { describeCapability } from "../src/capability.js";

function usage() {
  return [
    "AXM Ignition Fabric package interface",
    "",
    "Commands:",
    "  describe  Print the machine-readable capability boundary",
    "  demo      Compare eager and bounded Ignition execution",
    "",
    "Demo options:",
    "  --json             Print exact NDJSON receipts",
    "  --scenario <name>  Inspect one route"
  ].join("\n");
}

const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`${usage()}\n`);
} else if (command === "describe") {
  if (args.length) {
    process.stderr.write(`Unknown describe option: ${args[0]}\n\n${usage()}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify({ command, capability: describeCapability() }, null, 2)}\n`);
  }
} else if (command === "demo") {
  const { demoScenarioNames, runDemoCommand } = await import("./run-demo.mjs");
  try {
    await runDemoCommand(args);
  } catch (error) {
    process.stderr.write(`${error.message}\nAvailable scenarios: ${demoScenarioNames.join(", ")}\n`);
    process.exitCode = 2;
  }
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
  process.exitCode = 2;
}
