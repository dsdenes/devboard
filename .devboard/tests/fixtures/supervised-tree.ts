import { writeFileSync } from "node:fs";
import { supervisedDetach } from "../../watchdog/supervision";

/**
 * One supervised tree for the leak regression: the owner starts a peer and the
 * peer starts a grandchild, each through the same helper with the same state
 * directory. Every process writes its own pid beside the marker, so a test can
 * kill the owner and observe what the reaper does to the rest.
 */

const [stateDir, role, marker] = process.argv.slice(2);
if (stateDir === undefined || role === undefined || marker === undefined) {
  console.error("usage: supervised-tree.ts <state-dir> <owner|peer|grandchild> <marker>");
  process.exit(2);
}

const next = role === "owner" ? "peer" : role === "peer" ? "grandchild" : undefined;
writeFileSync(`${marker}.${role}`, `${process.pid}\n`);

if (next !== undefined) {
  const cwd = process.cwd();
  supervisedDetach([process.execPath, import.meta.path, stateDir, next, marker], {
    cwd,
    env: { ...process.env, STATE_DIR: stateDir },
    stateDir,
  });
}

setInterval(() => {}, 1_000);
