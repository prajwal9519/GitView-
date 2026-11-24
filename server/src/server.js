// Starts the HTTP server. Kept separate from app.js so tests never listen on a port.
import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { attachPreviewWebSocketUpgrade } from './modules/preview/previewWebSocket.js';
import { previewManager } from './modules/preview/previewManager.js';

const server = app.listen(env.PORT, () => {
  console.log(`GitView API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Milestone 7, Task 5: Handle preview domain WebSocket upgrades
attachPreviewWebSocketUpgrade(server);

// Startup reconciliation: clean up stale or orphaned preview resources on boot
previewManager
  .reconcileStaleSessions()
  .then((report) => {
    if (report.expiredCount > 0 || report.crashedCount > 0 || report.orphanedPrunedCount > 0) {
      console.log('[PreviewReconciler] Startup reconciliation completed:', report);
    }
  })
  .catch((err) => {
    console.error('[PreviewReconciler] Startup reconciliation error:', err.message);
  });

// Periodic background reaper: reconcile expired and stale sessions every 60 seconds
const reaperInterval = setInterval(async () => {
  try {
    await previewManager.reconcileStaleSessions();
  } catch (err) {
    // Non-fatal reconciliation tick
  }
}, 60000);
if (reaperInterval.unref) reaperInterval.unref();

// Graceful shutdown: stop accepting requests, let running ones finish, close the DB pool.
function shutdown(signal, exitCode = 0) {
  console.log(`${signal} received, shutting down`);
  clearInterval(reaperInterval);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force-quit if something hangs
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A promise rejected with nobody to handle it is a bug: log it, then restart cleanly.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  shutdown('unhandledRejection', 1);
});
