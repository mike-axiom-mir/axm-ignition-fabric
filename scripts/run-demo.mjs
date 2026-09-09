import { compareEquivalentRuns, executeIgnitionRun } from "../src/ignition-core.js";
import { buildDemoRegistry, demoRequests } from "../src/demo-capabilities.js";
import { pathToFileURL } from "node:url";

const state = { answer: 42 };

export const demoScenarioNames = Object.freeze(Object.keys(demoRequests));

export async function collectDemoRows({ scenario = null } = {}) {
  if (scenario !== null && !demoScenarioNames.includes(scenario)) {
    throw new Error(`unknown scenario: ${scenario}`);
  }

  const selected = scenario ? [[scenario, demoRequests[scenario]]] : Object.entries(demoRequests);
  const rows = [];
  for (const [name, request] of selected) {
    const registry = buildDemoRegistry();
    const eager = await executeIgnitionRun({ registry, request, state, mode: "eager" });
    const ignition = await executeIgnitionRun({ registry, request, state, mode: "ignition" });
    const comparison = compareEquivalentRuns(eager, ignition);

    rows.push({
      schema: "axm.ignition-demo/v0.02",
      scenario: name,
      equivalent: comparison.equivalent,
      eagerMaterialized: eager.receipt.materializedCount,
      ignitionMaterialized: ignition.receipt.materializedCount,
      eagerActualMaterializedBytes: eager.receipt.actualMaterializedBytes,
      ignitionActualMaterializedBytes: ignition.receipt.actualMaterializedBytes,
      actualMaterializedSavingsBytes: comparison.actualMaterializedDeltaBytes,
      executedCapabilityIds: ignition.receipt.executedCapabilityIds,
      resultHash: ignition.receipt.resultHash,
    });
  }
  return rows;
}

function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function clampWidth(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(44, Math.min(120, parsed)) : 80;
}

function fit(text, width) {
  if (text.length <= width) return text;
  return width <= 3 ? text.slice(0, width) : `${text.slice(0, width - 3)}...`;
}

function wrap(text, width, subsequentPrefix = "") {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = `${subsequentPrefix}${word}`;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function routeLines(ids, width) {
  const prefix = "    Route: ";
  const continuation = "           ";
  const lines = [];
  let line = prefix;
  for (const id of ids) {
    const token = line === prefix ? id : ` -> ${id}`;
    if (line.length + token.length <= width) {
      line += token;
    } else {
      lines.push(line);
      line = `${continuation}${id}`;
    }
  }
  lines.push(line);
  return lines;
}

function bar(active, total, width = 12) {
  const count = Math.round((active / total) * width);
  return `[${"#".repeat(count)}${"-".repeat(width - count)}]`;
}

export function formatHumanDemo(rows, { columns = process.env.COLUMNS } = {}) {
  const width = clampWidth(columns);
  const exact = rows.filter((row) => row.equivalent).length;
  const totalActive = rows.reduce((sum, row) => sum + row.ignitionMaterialized, 0);
  const totalPossible = rows.reduce((sum, row) => sum + row.eagerMaterialized, 0);
  const totalDifference = rows.reduce((sum, row) => sum + row.actualMaterializedSavingsBytes, 0);
  const weakest = [...rows].sort((a, b) => a.actualMaterializedSavingsBytes - b.actualMaterializedSavingsBytes)[0];
  const rule = "-".repeat(Math.min(width, 72));
  const lines = [
    fit("AXM IGNITION / BOUNDED MATERIALIZATION DEMO", width),
    `${exact}/${rows.length} EXACT OUTPUT MATCH${rows.length === 1 ? "" : "ES"}`,
    ...wrap("Requested bodies wake; unrelated bodies remain dormant.", width),
    rule
  ];

  rows.forEach((row, index) => {
    const status = row.equivalent ? "EXACT" : "MISMATCH";
    const label = `${String(index + 1).padStart(2, "0")}  ${row.scenario.toUpperCase()}`;
    const barWidth = width < 50 ? 6 : 12;
    lines.push(fit(`${label.padEnd(16)} ${status}  ${row.ignitionMaterialized}/${row.eagerMaterialized} bodies ${bar(row.ignitionMaterialized, row.eagerMaterialized, barWidth)}`, width));
    lines.push(fit(`    Demo allocation difference: ${mib(row.actualMaterializedSavingsBytes)}`, width));
    if (width >= 64) lines.push(...routeLines(row.executedCapabilityIds, width));
    lines.push(fit(`    Receipt: ${row.resultHash}`, width));
  });

  lines.push(rule);
  lines.push(`${exact}/${rows.length} exact | ${totalActive}/${totalPossible} bodies materialized`);
  lines.push(...wrap(`Cumulative demo allocation delta: ${mib(totalDifference)}`, width));
  if (rows.length > 1) lines.push(fit(`Smallest difference: ${weakest.scenario.toUpperCase()} (${mib(weakest.actualMaterializedSavingsBytes)})`, width));
  lines.push("");
  lines.push("BOUNDARY");
  lines.push(...wrap("These are deterministic demo allocations, not OS memory, energy, universal speedup, or a claim that Ignition should always win.", width));
  lines.push("");
  lines.push("NEXT");
  lines.push(...wrap("Use `axm-ignition demo --json` for exact NDJSON receipts.", width));
  lines.push(...wrap("Use `--scenario <name>` to inspect one route.", width));
  return `${lines.join("\n")}\n`;
}

function parseArgs(args) {
  let json = false;
  let scenario = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--scenario") {
      scenario = args[index + 1] ?? null;
      if (!scenario) throw new Error("--scenario requires a name");
      index += 1;
    } else {
      throw new Error(`unknown demo option: ${arg}`);
    }
  }
  return { json, scenario };
}

export async function runDemoCommand(args = [], output = process.stdout) {
  const options = parseArgs(args);
  const rows = await collectDemoRows({ scenario: options.scenario });
  if (options.json) output.write(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  else output.write(formatHumanDemo(rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runDemoCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nAvailable scenarios: ${demoScenarioNames.join(", ")}\n`);
    process.exitCode = 2;
  }
}
