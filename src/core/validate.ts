import { makeTransitionKey } from "./parser.js";
import type { Machine } from "../types.js";

export function validateMachine(machine: Machine): string[] {
  const errors: string[] = [];

  if (!machine.q.has(machine.q0)) {
    errors.push("q_0 must be in Q");
  }
  if (!machine.q.has(machine.qAcc)) {
    errors.push("q_acc must be in Q");
  }
  if (!machine.q.has(machine.qRej)) {
    errors.push("q_rej must be in Q");
  }
  if (machine.qAcc === machine.qRej) {
    errors.push("q_acc and q_rej must not be equal");
  }
  if (!machine.gam.has("_")) {
    errors.push("Gam must include blank symbol '_'");
  }
  for (const symbol of machine.sig) {
    if (symbol === "_") {
      errors.push("Sig must not include blank symbol '_'");
    }
    if (!machine.gam.has(symbol)) {
      errors.push(`Sig symbol '${symbol}' must be in Gam`);
    }
  }

  for (const state of machine.q) {
    for (const symbol of machine.gam) {
      const key = makeTransitionKey(state, symbol);
      const transition = machine.del.get(key);
      if (!transition) {
        continue;
      }
      if (!machine.q.has(transition.nextState)) {
        errors.push(
          `transition (${state}, ${symbol}) points to undefined state '${transition.nextState}'`,
        );
      }
      if (transition.writeSymbol !== "" && !machine.gam.has(transition.writeSymbol)) {
        errors.push(
          `transition (${state}, ${symbol}) writes undefined symbol '${transition.writeSymbol}'`,
        );
      }
    }
  }

  return errors;
}
