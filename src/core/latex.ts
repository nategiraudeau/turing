import type { Machine } from "../types.js";

function esc(value: string): string {
  return value.replace(/_/g, "\\_");
}

export function exportLatex(machine: Machine): string {
  const rows: string[] = [];
  for (const [key, t] of machine.del.entries()) {
    const [state, read] = key.split("\u0000");
    rows.push(
      `${esc(state)} & ${esc(read)} & ${esc(t.nextState)} & ${esc(t.writeSymbol || "''")} & ${t.move} \\\\`,
    );
  }
  rows.sort((a, b) => a.localeCompare(b));

  return [
    "\\begin{tabular}{lllll}",
    "state & read & next & write & move \\\\",
    "\\hline",
    ...rows,
    "\\end{tabular}",
  ].join("\n");
}
