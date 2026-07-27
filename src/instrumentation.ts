/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * We use it to start the Enable Banking background sync scheduler (Node runtime
 * only; it's a no-op on the Edge runtime and when the feature is unconfigured).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installTimestampedConsole } = await import('@/lib/server-logger');
    installTimestampedConsole();
    const { startBankScheduler } = await import('@/lib/bank/scheduler');
    startBankScheduler();
  }
}
