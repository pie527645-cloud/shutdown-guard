import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { checkProject } from '../src/index.js';

function withFixtureDir(
  files: Readonly<Record<string, string>>,
  callback: (dir: string) => void
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-golden-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Golden-clean multi-file production server fixtures', () => {
  it('produces 0 findings on a multi-file http production service (default & --lb-idle-timeout 60)', () => {
    withFixtureDir(
      {
        'src/constants.ts': `
          export const ALB_IDLE_SECONDS = 60;
          export const KEEP_ALIVE_TIMEOUT_MS = (ALB_IDLE_SECONDS + 5) * 1000;
          export const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 1000;
          export const SHUTDOWN_DEADLINE_MS = 15_000;
        `,
        'src/server.ts': `
          import http from 'node:http';
          import { KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } from './constants.js';

          export const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          });

          server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
          server.headersTimeout = HEADERS_TIMEOUT_MS;
        `,
        'src/shutdown.ts': `
          import type http from 'node:http';
          import { SHUTDOWN_DEADLINE_MS } from './constants.js';

          let shuttingDown = false;

          export async function gracefulShutdown(server: http.Server): Promise<void> {
            if (shuttingDown) {
              return;
            }
            shuttingDown = true;

            const watchdog = setTimeout(() => {
              process.exit(1);
            }, SHUTDOWN_DEADLINE_MS);
            watchdog.unref();

            try {
              await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
              });
              clearTimeout(watchdog);
              process.exit(0);
            } catch {
              process.exit(1);
            }
          }
        `,
        'src/index.ts': `
          import { server } from './server.js';
          import { gracefulShutdown } from './shutdown.js';

          server.listen(8080);

          for (const sig of ['SIGTERM', 'SIGINT'] as const) {
            process.once(sig, () => {
              void gracefulShutdown(server);
            });
          }
        `,
      },
      (dir) => {
        const defaultReport = checkProject({ target: dir, failOn: 'info' });
        assert.equal(defaultReport.scannedFiles, 4);
        assert.deepEqual(defaultReport.findings, []);
        assert.equal(defaultReport.summary.total, 0);

        const lbReport = checkProject({
          target: dir,
          lbIdleTimeoutSec: 60,
          failOn: 'info',
        });
        assert.equal(lbReport.scannedFiles, 4);
        assert.deepEqual(lbReport.findings, []);
        assert.equal(lbReport.summary.total, 0);
      }
    );
  });

  it('produces 0 findings on a multi-file Express production service', () => {
    withFixtureDir(
      {
        'src/app.ts': `
          import express from 'express';
          export function createApp() {
            const app = express();
            return app;
          }
        `,
        'src/main.ts': `
          import { createApp } from './app.js';

          const app = createApp();
          const httpServer = app.listen(3000);
          httpServer.keepAliveTimeout = 65_000;
          httpServer.headersTimeout = 66_000;

          const shutdown = () => {
            setTimeout(() => process.exit(1), 10_000).unref();
            httpServer.close(() => {
              process.exit(0);
            });
          };

          process.on('SIGTERM', shutdown);
          process.on('SIGINT', shutdown);
        `,
      },
      (dir) => {
        const report = checkProject({
          target: dir,
          lbIdleTimeoutSec: 60,
          failOn: 'info',
        });
        assert.equal(report.scannedFiles, 2);
        assert.deepEqual(report.findings, []);
      }
    );
  });
});
