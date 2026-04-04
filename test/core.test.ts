import { describe, expect, test } from "bun:test";
import { parseMachine } from "../src/core/parser.js";
import { simulate } from "../src/core/simulate.js";
import { validateMachine } from "../src/core/validate.js";

const machineText = `
Sig = {'0', '1'}
Gam = Sig + {'_'}

Q = {
  "S",
  "ACC",
  "REJ"
}

del = {
  ("S", '0') -> ("ACC", '', 'S')
}

q_0 = "S"
q_acc = "ACC"
q_rej = "REJ"
`;

describe("parser + validate", () => {
  test("parses machine and validates shape", () => {
    const machine = parseMachine(machineText);
    const errors = validateMachine(machine);
    expect(errors.length).toBe(0);
  });

  test("allows // comments", () => {
    const commented = `
Sig = {'0', '1'} // input symbols
Gam = Sig + {'_'}

Q = {
  "S",
  "ACC",
  "REJ"
}

del = {
  ("S", '0') -> ("ACC", '', 'S') // go accept
}

q_0 = "S"
q_acc = "ACC"
q_rej = "REJ"
`;
    const machine = parseMachine(commented);
    expect(validateMachine(machine).length).toBe(0);
  });
});

describe("simulate", () => {
  test("defaults missing transitions to reject", () => {
    const machine = parseMachine(machineText);
    const result = simulate(machine, "1", 10, "reject");
    expect(result.status).toBe("reject");
  });

  test("stay mode can timeout on missing transition", () => {
    const machine = parseMachine(machineText);
    const result = simulate(machine, "1", 3, "stay");
    expect(result.status).toBe("timeout");
  });
});
