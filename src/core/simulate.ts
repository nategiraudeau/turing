import { makeTransitionKey } from "./parser.js";
import type { Machine, MissingTransitionMode, SimulationResult } from "../types.js";

function readTape(tape: Map<number, string>, index: number): string {
  return tape.get(index) ?? "_";
}

function writeTape(tape: Map<number, string>, index: number, symbol: string): void {
  if (symbol === "_") {
    tape.delete(index);
    return;
  }
  tape.set(index, symbol);
}

function renderConfiguration(
  tape: Map<number, string>,
  state: string,
  head: number,
  inputLength: number,
): string {
  const used = Array.from(tape.keys());
  const min = Math.min(0, head, ...(used.length > 0 ? used : [0]));
  const max = Math.max(inputLength + 1, head, ...(used.length > 0 ? used : [0]));
  let left = "";
  let right = "";

  for (let i = min; i < head; i += 1) {
    left += readTape(tape, i);
  }
  for (let i = head; i <= max; i += 1) {
    right += readTape(tape, i);
  }

  return `${left}${state}${right}`;
}

export function simulate(
  machine: Machine,
  input: string,
  maxSteps: number,
  missingTransitionMode: MissingTransitionMode = "reject",
): SimulationResult {
  const tape = new Map<number, string>();
  for (let i = 0; i < input.length; i += 1) {
    tape.set(i, input[i] ?? "_");
  }

  let state = machine.q0;
  let head = 0;
  const trace = [renderConfiguration(tape, state, head, input.length)];

  for (let step = 0; step < maxSteps; step += 1) {
    if (state === machine.qAcc) {
      return { status: "accept", steps: step, trace };
    }
    if (state === machine.qRej) {
      return { status: "reject", steps: step, trace };
    }

    const readSymbol = readTape(tape, head);
    const transition = machine.del.get(makeTransitionKey(state, readSymbol));

    if (!transition) {
      if (missingTransitionMode === "reject") {
        state = machine.qRej;
        trace.push(renderConfiguration(tape, state, head, input.length));
        return { status: "reject", steps: step + 1, trace };
      }
      trace.push(renderConfiguration(tape, state, head, input.length));
      continue;
    }

    if (transition.writeSymbol !== "") {
      writeTape(tape, head, transition.writeSymbol);
    }
    state = transition.nextState;
    if (transition.move === "L") {
      head -= 1;
    } else if (transition.move === "R") {
      head += 1;
    }

    trace.push(renderConfiguration(tape, state, head, input.length));
  }

  return { status: "timeout", steps: maxSteps, trace };
}
