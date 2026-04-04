import { readFileSync, writeFileSync } from "node:fs";

export function saveTrace(path: string, trace: string[]): void {
  writeFileSync(path, `${trace.join("\n")}\n`, "utf8");
}

export function loadTrace(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
