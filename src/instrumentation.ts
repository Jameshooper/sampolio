/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * We use it to apply any one-shot add-on maintenance request (a forgotten
 * password reset) and to start the Enable Banking background sync scheduler
 * (Node runtime only; both are no-ops on the Edge runtime, and the scheduler
 * is also a no-op when the feature is unconfigured).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installTimestampedConsole } = await import('@/lib/server-logger');
    installTimestampedConsole();

    // Before anything else serves traffic, so the log line is easy to find.
    const { runAdminPasswordReset } = await import('@/lib/addon-maintenance');
    try {
      await runAdminPasswordReset();
    } catch (error) {
      // Never let a maintenance request stop the app from starting — being
      // locked out is the problem it exists to solve.
      console.error('[addon] Admin password reset failed:', error instanceof Error ? error.message : error);
    }

    const { startBankScheduler } = await import('@/lib/bank/scheduler');
    startBankScheduler();
  }
}
