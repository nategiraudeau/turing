# turing tool

use to make turing machines and run tapes through them to see how it works.

lets you export the machine as latex code to use in homework assignments.

## turing machine def

how are turing machines defined here and how can the user make them?

turing machines here are defined as 7-tuples: `(Q, Sig, Gam, del, q_0, q_acc, q_rej)`, where `Q`, `Sig`, `Gam` are all finite sets and:

- `Q` is the set of states

- `Sig` is the input alphabet not containing the **blank symbol** `_`

    > blank symbol often used to mark special cases, end of input, etc.

- `Gam` is the tape alphabet, where `_` is in `Gam` and `Sig` is a proper subset of `Gam`

- `del`: `(subset of Q X Gam) -> Q X (Gam U {''}) X {L, R, S}` is the transition function

    > `L`, `R`, `S` here represent moving the head **left** or **right** or **staying** still.

- `q_0` (in `Q`) is the start state

- `q_acc` (in `Q`) is the accept state

- `q_rej` (in `Q`) is the reject state, where `q_rej != q_acc`

    > note that tm's (as defined here) have one accept and one reject state, and they cannot be equal.

more information about the transition function `del`:

- `(subset of Q X Gam) -> ...`:

    - what state the machine is in and what symbol is currently on the tape at the head’s current position.
    - not every `(state, symbol)` pair must be explicitly defined in `del`

- `... -> Q X (Gam U {''}) X {L, R, S}`:

    - machine will enter a new state
    - machine will write a symbol in `Gam`, or `''` for no-write (leave current tape symbol unchanged)
    - head will move `L`eft or `R`ight (or `S` for staying put)
    - for now (interim behavior): if a transition is missing, simulation treats it as reject

- shorthand in transition declarations:

    - entries like `("state", '0', '1') -> ...` mean one transition per listed symbol
        - e.g. `("state", '0', '1') -> X` expands to `("state", '0') -> X` and `("state", '1') -> X`

<!--
UNDECIDED DEFINITION NOTE:
Missing transitions (when `(state, read_symbol)` is not explicitly present in `del`)
are currently undecided in the formal definition.

Implementation Possibilities:

Option A: strict/fail-closed
  behavior:
    any missing transition is treated as immediate reject
  effective fallback:
    `(current_state, read_symbol) -> (q_rej, '', 'S')`
  implications:
    - machines are easier to reason about as deciders
    - undefined behavior never silently continues
    - authoring errors are punished quickly
    - recognizer-style looping from undefined cases is not possible

Option B: implicit no-op stay
  behavior:
    any missing transition keeps state, keeps symbol, and does not move head
  effective fallback:
    `(current_state, read_symbol) -> (current_state, '', 'S')`
  implications:
    - missing transitions create a fixed-point loop
    - supports recognizer-style non-halting behavior by default
    - easier to accidentally create unintended infinite loops
    - undefined behavior can be harder to debug
-->

### example turing machine

consider the language:

```
B = {w#w | w in {0,1}*}
```

it can be represented by the following machine D:

```
Sig = {'1', '0', '#'}
Gam = Sig + {'_', 'x'}

Q = {
    "Mv Rt",
    "Chk Rt",
    "0 Find #",
    "1 Find #",
    "Find 0",
    "Find 1",
    "Reset to #",
    "Reset to Lft",
    "ACC",
    "REJ"
}

del = {
    ("Mv Rt", 'x') -> ("Mv Rt", '', 'R'),
    ("Mv Rt", '#') -> ("Chk Rt", '', 'R'),
    ("Mv Rt", '0') -> ("0 Find #", 'x', 'R'),
    ("Mv Rt", '1') -> ("1 Find #", 'x', 'R'),

    ("Chk Rt", 'x') -> ("Chk Rt", '', 'R'),
    ("Chk Rt", '0', '1') -> ("REJ", '', 'S'),
    ("Chk Rt", '_') -> ("ACC", '', 'R'),

    ("0 Find #", '0', '1') -> ("0 Find #", '', 'R'),
    ("0 Find #", '#') -> ("Find 0", '', 'R'),

    ("1 Find #", '0', '1') -> ("1 Find #", '', 'R'),
    ("1 Find #", '#') -> ("Find 1", '', 'R'),

    ("Find 0", 'x') -> ("Find 0", '', 'R'),
    ("Find 0", '1', '_') -> ("REJ", '', 'S'),
    ("Find 0", '0') -> ("Reset to #", 'x', 'L'),

    ("Find 1", 'x') -> ("Find 1", '', 'R'),
    ("Find 1", '0', '_') -> ("REJ", '', 'S'),
    ("Find 1", '1') -> ("Reset to #", 'x', 'L'),

    ("Reset to #", '0', '1', 'x') -> ("Reset to #", '', 'L'),
    ("Reset to #", '#') -> ("Reset to Lft", '', 'L'),

    ("Reset to Lft", '0', '1') -> ("Reset to Lft", '', 'L'),
    ("Reset to Lft", 'x') -> ("Mv Rt", '', 'S')
}

q_0 = "Mv Rt"
q_acc = "ACC"
q_rej = "REJ"
```

## turing machine configurations

a **configuration** of a turing machine is the complete state the machine is in at any point during execution. this includes the state, the contents of the tape, and the position of the head.

configurations are represented as strings:

```
1011𝑞01111
```

would mean the machine is in state `q`, with the contents of the tape and position of the head shown below:

```
q __ __ __
          |
          |
          |
          v
  1 0 1 1 0 1 1 1 1 _ _ _ ...
```

## recognizing vs deciding

when turing machines execute, there are three possible outcomes:

- **accept:** input on tape is in language

- **reject:** input on tape is not in language

- **loop:** machine runs forever and never reaches an accept or reject state

a turing machine is said to be a decider, and the language it represents is said to be a decidable language, if it always accepts or rejects (never loops). a machine that allows for accepting, rejecting, and looping is called a recognizer.

this tool supports both deciders and recognizers, however there is a timeout built in such that machine simulations can only run for so long.

## implementation notes

### 4/4/26

initially, this program is to be ionteractable as some form of cli/script/etc easily testable from the command line

eventually, an extensively interactive webb app will be built with vite on bun with scss

the core logic and scripts rely on the following data storage:

- "[machine name].turing" files (essentially plaintext) store definitions of turing machines

- ".turingconfig" files (anslo just plaintext) store configurations from a simulation, where each newline is a configuration (all configurations are saved)

steps to minimally implement the core scripts and logic:

- `step 1`: parse `.turing` files and run a single simulation from cli

- `step 2`: save full simulation traces to `.turingconfig` (one config per line)

- `step 3`: add machine validation (duplicate transitions, undefined states/symbols, shorthand expansion)

- `step 4`: add fallback behavior mode for missing transitions

  - possible modes are `reject` and `stay`
  - this is still undecided in the long term
  - interim default behavior is `reject`

- `step 5`: add latex export for machine definitions

- `step 6`: keep core tm logic framework-agnostic so cli and web app share the same engine

#### `.turing` syntax:

machine definition files are plain text and follow this shape:

```txt
Sig = {'1', '0', '#'}
Gam = Sig + {'_', 'x'}

Q = {
    "State A",
    "State B",
    "ACC",
    "REJ"
}

del = {
    ("State A", '0') -> ("State B", 'x', 'R'),
    ("State A", '1', '#') -> ("REJ", '', 'S'),
    ("State B", '_') -> ("ACC", '', 'S')
}

q_0 = "State A"
q_acc = "ACC"
q_rej = "REJ"
```

rules:

- each machine must define `Sig`, `Gam`, `Q`, `del`, `q_0`, `q_acc`, and `q_rej`

- state names are strings in double quotes (example: `"Mv Rt"`)

- tape/input symbols are single-quoted (example: `'0'`, `'_'`, `'x'`)

- each transition is `(<state>, <read symbol(s)>) -> (<next state>, <write symbol>, <move>)`

- `<move>` must be one of `'L'`, `'R'`, `'S'`

- `''` as write symbol means no-write (keep current tape symbol)

- shorthand read lists are allowed: `("A", '0', '1') -> ...` expands to one transition per symbol

- missing transitions are currently treated as reject in simulation (interim behavior)

- line comments are supported with `//` (everything after `//` on that line is ignored)

#### cli stack details

the cli stack will be built on `bun` + `typescript`.

core packages/libraries:

- runtime/package manager: `bun`

- language: `typescript`

- cli argument parsing: `commander`

- terminal output: `chalk` (for color) + plain text fallback

- file i/o and paths: node stdlib (`fs`, `path`)

- tests: `bun test`

project layout:

- `src/cli.ts`:
  - entrypoint for all cli commands
  - parses flags and dispatches to command handlers

- `src/core/parser.ts`:
  - parses `.turing` files into internal machine objects
  - handles shorthand expansion for read symbol lists

- `src/core/validate.ts`:
  - validates machine shape and references
  - checks duplicate transitions and undefined symbols/states

- `src/core/simulate.ts`:
  - runs tm step-by-step
  - returns status (`accept`/`reject`/`timeout`) and trace

- `src/core/config.ts`:
  - reads/writes `.turingconfig`
  - saves and loads simulation traces

- `src/core/latex.ts`:
  - machine-to-latex export logic

- `src/types.ts`:
  - shared types for machine, transition, tape, and config

cli commands:

- `turing run <machine.turing> [input] [--input <string>] [--max-steps <n>] [--trace] [--missing-transition reject|stay]`
  - runs a simulation and prints result
  - if `[input]` is missing, reads from `--input`, otherwise from piped stdin

- `turing validate <machine.turing>`
  - checks syntax and machine validity

- `turing step <machine.turing> [input] [--input <string>] [--max-steps <n>] [--missing-transition reject|stay]`
  - interactive stepping mode (press enter to advance one tick)
  - prints configuration at each tick

- `turing clock <machine.turing> [input] [--input <string>] --tick-ms <n> [--max-steps <n>] [--missing-transition reject|stay]`
  - clocked stepping mode
  - prints configuration every tick using `--tick-ms`

- `turing trace <machine.turing> [input] [--input <string>] [--out <name.turingconfig>] [--max-steps <n>] [--missing-transition reject|stay]`
  - runs simulation and writes full trace file
  - default output is `[machine].turingconfig` in current directory when `--out` is omitted

- `turing latex <machine.turing> --out <file.tex>`
  - exports latex code for the machine

execution flow for `run`:

1. parse args and load `.turing` file
2. parse + validate machine
3. choose missing-transition behavior (interim default: `reject`)
4. simulate until accept/reject/timeout
5. print summary and optionally print or save trace

build + dev flow:

- `bun install`

- `bun run build` compiles `src/cli.ts` to `dist/cli.js`

- `bun run dev -- <args>` runs cli in watch/dev mode

- `bun test` runs parser/simulator/validator tests

interim implementation defaults:

- missing transition behavior defaults to `reject`

- `trace` output path defaults to `[machine].turingconfig`

### 4/6/24 - web dev

here is what needs to be implemented in order:

the entire screen to be considered as a "blank canvas" that the user can use to draw turing machines

- note: javascript/html canvas is not to be used, the app is t be primarily built with plain html css elements

initially, the screen is blank

**clicking anywhere on the screen makes a circle appear there** (needs to be implemented)