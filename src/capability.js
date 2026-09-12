import fs from "node:fs";

const packageUrl = new URL("../package.json", import.meta.url);

export function describeCapability() {
  const packageDocument = JSON.parse(fs.readFileSync(packageUrl, "utf8"));
  const capability = packageDocument.axmCapability;
  if (!capability || capability.schema !== "axm.capability/v1") {
    throw new Error("Ignition package capability metadata is missing or incompatible");
  }
  return structuredClone(capability);
}
