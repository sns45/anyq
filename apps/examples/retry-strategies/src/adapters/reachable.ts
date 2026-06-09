/**
 * Tiny TCP reachability probe used to gate broker integration tests.
 *
 * Returns `true` if a TCP connect to `host:port` completes within
 * `timeoutMs`; otherwise `false`. Never throws.
 */

import { Socket } from 'node:net';

export function tcpReachable(
  host: string,
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}
