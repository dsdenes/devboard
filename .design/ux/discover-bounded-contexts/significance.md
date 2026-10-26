# Bounded contexts widget — significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

|ID|Information|Goal|Action|Frequency|Unique|Risk|Score|Priority|Decision|
|---|---|---:|---:|---:|---:|---:|---:|---|---|
|A1|Context name|5|4|4|5|2|86|P0|First line of every context row|
|A2|Context responsibility|4|3|3|5|2|71|P1|Second line, muted|
|A3|Context path|4|4|3|4|2|73|P1|Right side of the context head, mono|
|A4|Context entry points|4|3|3|4|1|66|P1|Chips under the responsibility|
|A5|Shared kernels|4|3|2|4|3|67|P1|First boundary role row|
|A6|External boundaries|4|3|2|4|3|67|P1|Second boundary role row|
|A7|Dependency direction|4|3|2|5|3|70|P1|Last boundary role row, as a sentence|
|A8|Unknown reason per group|3|3|1|5|3|60|P1|One line naming the missing groups|

Ordering (A17) is a presentation rule, not an information item; `structure.md` owns it.

## Band reading

- **P0.** A1 is the only item a reader must see without opening anything else: it is the answer to
  "what exists here?". It sits on the first screen of the published overview at 1440×900.
- **P1.** A2–A8 all sit in the main flow, inside the same card, with no disclosure. A2 and A3 make
  the P0 answer usable; A5–A7 answer the coupling question the card provokes; A8 prevents absence
  from reading as evidence.
- **No P2.** Anything softer (evidence chips, confidence, term counts) is dropped rather than
  hidden, because the card is already a supporting region of the page.

## Deduplication after scoring

- A3 and A4 overlap when the crawler records the path as its own entry point. Keep A3 and suppress
  the duplicate chip.
- A5 and A6 are scored equally but are not interchangeable: a kernel is inside the domain and
  shared; an external boundary is outside it. Both stay, in one grouped list, each labeled.
- A9, A11, A12, A15, A16 are absent; they add no decision the retained set does not already serve.
- A8 is not a fourth group: it is the state text for A5–A7 and appears once per unknown group.
