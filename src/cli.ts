#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { Command } from "commander";
import { saveTrace } from "./core/config.js";
import { exportLatex } from "./core/latex.js";
import { parseMachineFile } from "./core/parser.js";
import { simulate } from "./core/simulate.js";
import { validateMachine } from "./core/validate.js";
import type { MissingTransitionMode } from "./types.js";

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("value must be a positive integer");
  }
  return parsed;
}

function loadAndValidate(machinePath: string) {
  const machine = parseMachineFile(machinePath);
  const errors = validateMachine(machine);
  if (errors.length > 0) {
    throw new Error(`invalid machine:\n- ${errors.join("\n- ")}`);
  }
  return machine;
}

function resolveInputTape(inputArg: string | undefined, inputFlag: string | undefined): string {
  if (typeof inputArg === "string") {
    return inputArg;
  }
  if (typeof inputFlag === "string") {
    return inputFlag;
  }
  if (!process.stdin.isTTY) {
    return readFileSync(0, "utf8").trimEnd();
  }
  throw new Error("missing input tape: provide [input], --input, or pipe stdin");
}

function printStatus(status: "accept" | "reject" | "timeout"): void {
  if (status === "accept") {
    console.log(chalk.green("accept"));
  } else if (status === "reject") {
    console.log(chalk.red("reject"));
  } else {
    console.log(chalk.yellow("timeout"));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const program = new Command();
program.name("turing");

program
  .command("run")
  .argument("<machine.turing>")
  .argument("[input]")
  .option("--input <string>", "deprecated alias for positional input")
  .option("--max-steps <n>", "max simulation steps", parsePositiveInt, 10000)
  .option("--trace", "print full trace")
  .option(
    "--missing-transition <mode>",
    "missing transition behavior",
    "reject",
  )
  .action((machinePath: string, inputArg: string | undefined, options) => {
    const mode = options.missingTransition as MissingTransitionMode;
    if (mode !== "reject" && mode !== "stay") {
      throw new Error("missing-transition must be reject or stay");
    }
    const inputTape = resolveInputTape(inputArg, options.input);
    const machine = loadAndValidate(machinePath);
    const result = simulate(machine, inputTape, options.maxSteps, mode);

    printStatus(result.status);
    console.log(`steps: ${result.steps}`);

    if (options.trace) {
      for (const config of result.trace) {
        console.log(config);
      }
    }
  });

program
  .command("step")
  .argument("<machine.turing>")
  .argument("[input]")
  .option("--input <string>", "deprecated alias for positional input")
  .option("--max-steps <n>", "max simulation steps", parsePositiveInt, 10000)
  .option(
    "--missing-transition <mode>",
    "missing transition behavior",
    "reject",
  )
  .action(async (machinePath: string, inputArg: string | undefined, options) => {
    const mode = options.missingTransition as MissingTransitionMode;
    if (mode !== "reject" && mode !== "stay") {
      throw new Error("missing-transition must be reject or stay");
    }
    const inputTape = resolveInputTape(inputArg, options.input);
    const machine = loadAndValidate(machinePath);
    const result = simulate(machine, inputTape, options.maxSteps, mode);

    if (result.trace.length === 0) {
      printStatus(result.status);
      console.log(`steps: ${result.steps}`);
      return;
    }

    console.log(result.trace[0]);
    if (result.trace.length > 1) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      for (let i = 1; i < result.trace.length; i += 1) {
        await rl.question("");
        console.log(result.trace[i]);
      }
      rl.close();
    }

    printStatus(result.status);
    console.log(`steps: ${result.steps}`);
  });

program
  .command("clock")
  .argument("<machine.turing>")
  .argument("[input]")
  .option("--input <string>", "deprecated alias for positional input")
  .option("--max-steps <n>", "max simulation steps", parsePositiveInt, 10000)
  .requiredOption("--tick-ms <n>", "clock tick speed in milliseconds", parsePositiveInt)
  .option(
    "--missing-transition <mode>",
    "missing transition behavior",
    "reject",
  )
  .action(async (machinePath: string, inputArg: string | undefined, options) => {
    const mode = options.missingTransition as MissingTransitionMode;
    if (mode !== "reject" && mode !== "stay") {
      throw new Error("missing-transition must be reject or stay");
    }
    const inputTape = resolveInputTape(inputArg, options.input);
    const machine = loadAndValidate(machinePath);
    const result = simulate(machine, inputTape, options.maxSteps, mode);

    for (let i = 0; i < result.trace.length; i += 1) {
      console.log(result.trace[i]);
      if (i < result.trace.length - 1) {
        await sleep(options.tickMs);
      }
    }

    printStatus(result.status);
    console.log(`steps: ${result.steps}`);
  });

program
  .command("validate")
  .argument("<machine.turing>")
  .action((machinePath: string) => {
    const machine = parseMachineFile(machinePath);
    const errors = validateMachine(machine);
    if (errors.length > 0) {
      throw new Error(`invalid machine:\n- ${errors.join("\n- ")}`);
    }
    console.log(chalk.green("valid"));
  });

program
  .command("trace")
  .argument("<machine.turing>")
  .argument("[input]")
  .option("--input <string>", "deprecated alias for positional input")
  .option("--out <name.turingconfig>")
  .option("--max-steps <n>", "max simulation steps", parsePositiveInt, 10000)
  .option(
    "--missing-transition <mode>",
    "missing transition behavior",
    "reject",
  )
  .action((machinePath: string, inputArg: string | undefined, options) => {
    const mode = options.missingTransition as MissingTransitionMode;
    if (mode !== "reject" && mode !== "stay") {
      throw new Error("missing-transition must be reject or stay");
    }
    const inputTape = resolveInputTape(inputArg, options.input);
    const machine = loadAndValidate(machinePath);
    const result = simulate(machine, inputTape, options.maxSteps, mode);
    const defaultOut = `${basename(machinePath, extname(machinePath))}.turingconfig`;
    const outPath = options.out ?? defaultOut;
    saveTrace(outPath, result.trace);
    console.log(`status: ${result.status}`);
    console.log(`steps: ${result.steps}`);
    console.log(`trace written: ${outPath}`);
  });

program
  .command("latex")
  .argument("<machine.turing>")
  .requiredOption("--out <file.tex>")
  .action((machinePath: string, options) => {
    const machine = loadAndValidate(machinePath);
    const latex = exportLatex(machine);
    writeFileSync(options.out, latex, "utf8");
    console.log(`latex written: ${options.out}`);
  });

program.parse();
