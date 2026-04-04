export type Move = "L" | "R" | "S";

export type MissingTransitionMode = "reject" | "stay";

export interface Transition {
  nextState: string;
  writeSymbol: string;
  move: Move;
}

export interface Machine {
  sig: Set<string>;
  gam: Set<string>;
  q: Set<string>;
  del: Map<string, Transition>;
  q0: string;
  qAcc: string;
  qRej: string;
}

export interface SimulationResult {
  status: "accept" | "reject" | "timeout";
  steps: number;
  trace: string[];
}
