/**
 * Deterministic `gh` substitute for the feedback endpoint tests.
 *
 * It records the arguments, working directory and stdin body, then either
 * prints an issue URL, fails, or hangs so timeout handling can be exercised.
 */

const recordPath = process.env.STUB_GH_RECORD;
const mode = process.env.STUB_GH_MODE ?? "ok";

let body = "";
for await (const chunk of Bun.stdin.stream()) {
  body += new TextDecoder().decode(chunk);
}

if (recordPath !== undefined) {
  await Bun.write(
    recordPath,
    JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), body }),
  );
}

if (mode === "fail") {
  console.error("boom: not a git repository");
  process.exit(1);
}

if (mode === "hang") {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 60_000);
  await promise;
}

console.log("https://github.com/example/host/issues/42");

export {};
