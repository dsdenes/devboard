# Bounded contexts widget — significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

|ID|Information|Goal|Action|Frequency|Unique|Risk|Score|Priority|Decision|
|---|---|---:|---:|---:|---:|---:|---:|---|---|
|A1|Context name|5|4|4|5|2|86|P0|First line of every context row|
|A2|Context responsibility|4|3|3|5|2|71|P1|Second line, muted|
|A3|Context path|4|4|3|4|2|73|—|Removed by #230; no Discover card renders it|
|A4|Context entry points|4|3|3|4|1|66|P1|Chips under the responsibility; the card's only locator|
|A5|Shared kernels|4|3|2|4|3|67|P1|The `Shared kernels` card in the facts rail|
|A6|External boundaries|4|3|2|4|3|67|P1|The `External boundaries` card in the facts rail|
|A7|Dependency direction|4|3|2|5|3|70|—|Removed by #1091; no Discover card renders it|
|A8|Unknown reason per group|3|3|1|5|3|60|P1|Each boundary card's own reason line|

Ordering (A17) is a presentation rule, not an information item; `structure.md` owns it.

## Band reading

- **P0.** A1 is the only item a reader must see without opening anything else: it is the answer to
  "what exists here?". It sits on the first screen of the published overview at 1440×900.
- **P1.** A2, A4–A6, and A8 sit in the flow of the three architecture cards, with no disclosure.
  A2 and A4 make the P0 answer usable; A5 and A6 answer the coupling question the page provokes;
  A8 prevents absence from reading as evidence.
- **No priority.** A3 and A7 keep their scores as history only: #230 and #1091 removed them from
  every Discover card, so neither is rendered and neither lands in a region.
- **No P2.** Anything softer (evidence chips, confidence, term counts) is dropped rather than
  hidden, because the card is already a supporting region of the page.

## Deduplication after scoring

- A4's chips are the only locator: #230 removed the path element, so no other item repeats a
  context's entry point.
- A5 and A6 are scored equally but are not interchangeable: a kernel is inside the domain and
  shared; an external boundary is outside it. Each stays as its own rail card with its own header.
- A9, A11, A12, A15, A16 are absent; they add no decision the retained set does not already serve.
- A8 is not a group: it is the state text each boundary card carries for itself.
