import { readFileSync } from "node:fs";
import type { Machine, Move, Transition } from "../types.js";

function parseSymbolSet(expr: string): Set<string> {
  const symbols = Array.from(expr.matchAll(/'([^']*)'/g)).map((m) => m[1]);
  return new Set(symbols);
}

function parseStateSet(expr: string): Set<string> {
  const states = Array.from(expr.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  return new Set(states);
}

function getRequiredMatch(source: string, re: RegExp, name: string): string {
  const match = source.match(re);
  if (!match || !match[1]) {
    throw new Error(`missing ${name} definition`);
  }
  return match[1].trim();
}

function transitionKey(state: string, readSymbol: string): string {
  return `${state}\u0000${readSymbol}`;
}

function parseTransitions(expr: string): Map<string, Transition> {
  const del = new Map<string, Transition>();
  const lineRe = /\(("[^"]+"),\s*([^)]*?)\)\s*->\s*\(("[^"]+"),\s*'([^']*)',\s*'([LRS])'\)\s*,?/g;

  for (const match of expr.matchAll(lineRe)) {
    const fromState = match[1].slice(1, -1);
    const readListRaw = match[2];
    const toState = match[3].slice(1, -1);
    const writeSymbol = match[4];
    const move = match[5] as Move;
    const readSymbols = Array.from(readListRaw.matchAll(/'([^']*)'/g)).map((m) => m[1]);

    if (readSymbols.length === 0) {
      throw new Error(`transition from state ${fromState} has no read symbols`);
    }

    for (const readSymbol of readSymbols) {
      const key = transitionKey(fromState, readSymbol);
      if (del.has(key)) {
        throw new Error(`duplicate transition for (${fromState}, ${readSymbol})`);
      }
      del.set(key, { nextState: toState, writeSymbol, move });
    }
  }

  return del;
}

export function makeTransitionKey(state: string, readSymbol: string): string {
  return transitionKey(state, readSymbol);
}

export function parseMachine(source: string): Machine {
  const withoutComments = source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  const sigExpr = getRequiredMatch(withoutComments, /Sig\s*=\s*(.+)/, "Sig");
  const gamExpr = getRequiredMatch(withoutComments, /Gam\s*=\s*(.+)/, "Gam");
  const qExpr = getRequiredMatch(withoutComments, /Q\s*=\s*\{([\s\S]*?)\}/, "Q");
  const delExpr = getRequiredMatch(withoutComments, /del\s*=\s*\{([\s\S]*?)\}/, "del");
  const q0 = getRequiredMatch(withoutComments, /q_0\s*=\s*"([^"]+)"/, "q_0");
  const qAcc = getRequiredMatch(withoutComments, /q_acc\s*=\s*"([^"]+)"/, "q_acc");
  const qRej = getRequiredMatch(withoutComments, /q_rej\s*=\s*"([^"]+)"/, "q_rej");

  const sig = parseSymbolSet(sigExpr);
  const gam = gamExpr.includes("Sig +")
    ? new Set([...sig, ...parseSymbolSet(gamExpr)])
    : parseSymbolSet(gamExpr);
  const q = parseStateSet(qExpr);
  const del = parseTransitions(delExpr);

  return { sig, gam, q, del, q0, qAcc, qRej };
}

export function parseMachineFile(path: string): Machine {
  return parseMachine(readFileSync(path, "utf8"));
}
