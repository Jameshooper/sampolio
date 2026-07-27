/**
 * Prefix every server-side console line with an ISO timestamp.
 *
 * The launchd service captures stdout/stderr to ~/.sampolio/logs/*.log, and the
 * app logs via raw console.*, so without this the logs have no times. Installed
 * once from instrumentation.register() on the Node runtime; idempotent.
 */

let installed = false;

export function installTimestampedConsole(): void {
  if (installed) return;
  installed = true;

  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original: Record<string, (...args: unknown[]) => void> = {};
  for (const m of methods) {
    original[m] = console[m].bind(console);
    console[m] = (...args: unknown[]) => original[m](`[${new Date().toISOString()}]`, ...args);
  }
}
