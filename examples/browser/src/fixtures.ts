export const fixtures: Array<[string, unknown]> = [
  ["null", null],
  ["boolean", true],
  ["small int", 42],
  ["large int", 1234567890123],
  ["float", 3.25],
  ["short string", "hello, msgpack"],
  ["unicode string", "héllo wörld — 日本語 ✓ 😀"],
  ["binary", new Uint8Array([0, 1, 2, 3, 255])],
  ["small array", [1, "two", true, null, [3, 4]]],
  ["small map", { id: 1, name: "widget", ok: true, tags: ["a", "b"], meta: { depth: 2 } }],
  [
    "nested",
    {
      users: [
        { id: 1, name: "Ada", active: true, score: 99.5 },
        { id: 2, name: "Grace", active: false, score: 87.25 },
      ],
      cursor: null,
      blob: new Uint8Array(64).map((_, index) => index & 0xff),
    },
  ],
];
