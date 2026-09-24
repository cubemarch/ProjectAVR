import cluster from 'node:cluster';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cluster supervisor.
 *
 * Node is single-threaded, so one process uses one core no matter how much
 * hardware is underneath it. This forks one worker per core and lets the OS
 * balance accepted connections between them.
 *
 * This is vertical scaling - it fills one machine. It is not a substitute for
 * running several machines behind a load balancer, which is what actually
 * removes the ceiling. It works here only because the app tier holds no
 * per-process state: any worker can serve any request.
 *
 *   npm run start:cluster            one worker per core
 *   AVR_WORKERS=4 npm run start:cluster
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, 'index.js');

const DESIRED = Math.max(1, Number(process.env.AVR_WORKERS) || os.availableParallelism?.() || os.cpus().length);

// Restarting faster than this usually means the worker is crashing on boot, and
// a hot loop of forks makes the logs useless.
const MIN_RESTART_INTERVAL_MS = 1000;

if (cluster.isPrimary) {
    // Create and migrate the database before any worker starts, so they all
    // find a ready schema instead of racing each other for the write lock.
    const { getDb } = await import('./db/index.js');
    getDb();

    cluster.setupPrimary({ exec: ENTRY });

    console.log(`[cluster] primary ${process.pid} starting ${DESIRED} worker(s)`);

    const lastStart = new Map();

    const fork = (index) => {
        // Only worker 0 runs the SSDP advertiser; see the note in index.js.
        const worker = cluster.fork({ AVR_WORKER_INDEX: String(index) });
        lastStart.set(worker.id, Date.now());
        worker.workerIndex = index;
        return worker;
    };

    for (let i = 0; i < DESIRED; i++) fork(i);

    cluster.on('exit', (worker, code, signal) => {
        if (shuttingDown) return;

        const index = worker.workerIndex ?? 0;
        const age = Date.now() - (lastStart.get(worker.id) ?? 0);
        lastStart.delete(worker.id);

        console.warn(`[cluster] worker ${worker.process.pid} exited (${signal || code}); restarting`);

        if (age < MIN_RESTART_INTERVAL_MS) {
            setTimeout(() => fork(index), MIN_RESTART_INTERVAL_MS);
        } else {
            fork(index);
        }
    });

    let shuttingDown = false;

    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log('[cluster] shutting down');
        for (const worker of Object.values(cluster.workers ?? {})) worker.kill('SIGTERM');

        setTimeout(() => process.exit(0), 8000).unref();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
} else {
    // Workers execute server/index.js directly via setupPrimary.
    await import('./index.js');
}
