/**
 * The public surface of an ACP peer a dashboard holds. An in-process
 * `AcpConnection` and a detached owner's `DetachedPeer` both satisfy it, so
 * orchestration code never depends on where the peer process lives.
 */
export interface PeerConnection {
  readonly closed: boolean;
  readonly pid: number | undefined;
  readonly argv: string[];
  run(prompt: string): Promise<unknown>;
  prompt(prompt: string): Promise<unknown>;
  answer(id: number | string, value: string): boolean;
  pause(): boolean;
  resume(): boolean;
  close(): void;
}
