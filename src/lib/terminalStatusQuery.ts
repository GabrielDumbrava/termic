/** A complete chunk containing only device-status / cursor-position requests.
 * These must still reach xterm so the CLI gets its reply, but they do not
 * paint anything. Some TUIs send them at 5 Hz even at an idle prompt.
 * Updating the UI's activity snapshot for each query fans out store writes
 * to every mounted task. Raw liveness must still count these bytes.
 *
 * Deliberately conservative: mixed or fragmented chunks take the normal
 * activity path. Never buffer or discard bytes here; xterm owns parsing. */
export function isTerminalStatusQueryOnly(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  let i = 0;
  while (i < data.length) {
    if (data[i++] !== 0x1b || data[i++] !== 0x5b) return false; // ESC [
    if (data[i] === 0x3f) i++; // DEC private query
    const status = data[i++];
    if ((status !== 0x35 && status !== 0x36) || data[i++] !== 0x6e) return false;
  }
  return true;
}
