/**
 * The mutation registry the connection dispatches commands through.
 *
 * Every non-GET operation the client knows is one `createMutation` created at
 * the app root; a store's control calls `connection.send`, which hands the
 * command to that mutation. The mutation writes its answer into the cache and
 * invalidates exactly the resources that answer changed.
 */
import type { Command, Envelope } from "./rest-transport";

/**
 * One registered mutation. `onSettled` runs either way; `onFailure` runs only
 * when the answer failed, so the store that sent the command settles it
 * instead of waiting for a frame a refused request never produces.
 */
export interface CommandMutation {
  mutate: (
    command: Command,
    onSettled?: () => void,
    onFailure?: (error: Error) => void,
  ) => void;
}

let registry: Record<string, CommandMutation> = {};

/** Installs the app root's mutations; the last install owns the registry. */
export function registerMutations(mutations: Record<string, CommandMutation>): void {
  registry = mutations;
}

/** The mutation for one command type, when the app root installed it. */
export function mutationFor(type: string): CommandMutation | undefined {
  return registry[type];
}

export type MutationAnswer = ReadonlyArray<Envelope>;
