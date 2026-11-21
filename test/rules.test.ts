import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { analyzeSources, checkProject, type SourceInput } from '../src/index.js';

function singleSource(content: string, displayPath = 'src/server.ts'): readonly SourceInput[] {
  return [
    {
      absolutePath: path.resolve('/virtual/project', displayPath),
      displayPath,
      content,
    },
  ];
}

function withTempProject(
  files: Readonly<Record<string, string>>,
  fn: (dir: string) => void
): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-rules-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    }
    fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('Rule SDG001 - Missing SIGTERM/SIGINT handler', () => {
  it('flags http.createServer().listen() when no signal handler exists in project', () => {
    const findings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer((_req, res) => res.end('ok'));
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
      `)
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'SDG001');
    assert.equal(findings[0]?.severity, 'medium');
  });

  it('flags express, fastify, https, and CommonJS require servers without signal handlers', () => {
    const expressFindings = analyzeSources(
      singleSource(`
        import express from 'express';
        const app = express();
        const srv = app.listen(8080);
        srv.keepAliveTimeout = 65000;
        srv.headersTimeout = 66000;
      `)
    );
    assert.ok(expressFindings.some((f) => f.ruleId === 'SDG001'));

    const fastifyFindings = analyzeSources(
      singleSource(`
        import Fastify from 'fastify';
        const app = Fastify({ keepAliveTimeout: 65000 });
        await app.listen({ port: 3000 });
      `)
    );
    assert.ok(fastifyFindings.some((f) => f.ruleId === 'SDG001'));

    const cjsFindings = analyzeSources(
      singleSource(
        `
        const https = require('node:https');
        const srv = https.createServer({}, (_req, res) => res.end('ok'));
        srv.keepAliveTimeout = 65000;
        srv.listen(8443);
      `,
        'src/server.cjs'
      )
    );
    assert.ok(cjsFindings.some((f) => f.ruleId === 'SDG001'));
  });

  it('stays clean when SIGTERM/SIGINT handler exists in ANOTHER file of the same project', () => {
    withTempProject(
      {
        'src/server.ts': `
          import http from 'node:http';
          export const server = http.createServer((_req, res) => res.end('ok'));
          server.keepAliveTimeout = 65_000;
          server.headersTimeout = 66_000;
          server.listen(3000);
        `,
        'src/signals.ts': `
          import { server } from './server.js';
          for (const sig of ['SIGTERM', 'SIGINT'] as const) {
            process.once(sig, () => {
              setTimeout(() => process.exit(1), 10_000).unref();
              server.close(() => process.exit(0));
            });
          }
        `,
      },
      (dir) => {
        const report = checkProject({ target: dir, lbIdleTimeoutSec: 60 });
        assert.equal(report.scannedFiles, 2);
        assert.equal(report.findings.length, 0);
      }
    );
  });

  it('recognizes process.addListener, local const signal names, and array.forEach', () => {
    const findings = analyzeSources(
      singleSource(`
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        const http = require('http');
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);

        const SIGNALS = ['SIGTERM', 'SIGINT'];
        SIGNALS.forEach((sig) => {
          process.addListener(sig, () => {
            setTimeout(() => process.exit(1), 5_000).unref();
            server.close(() => process.exit(0));
          });
        });
      `)
    );
    assert.equal(findings.length, 0);
  });
});

describe('Rule SDG002 - headersTimeout <= keepAliveTimeout', () => {
  it('flags headersTimeout <= keepAliveTimeout with high severity for literals and const expressions', () => {
    const equalFindings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const IDLE_MS = 65 * 1000;
        const server = http.createServer();
        server.keepAliveTimeout = IDLE_MS;
        server.headersTimeout = 65_000;
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10000).unref();
          server.close(() => process.exit(0));
        });
      `)
    );
    assert.equal(equalFindings.length, 1);
    assert.equal(equalFindings[0]?.ruleId, 'SDG002');
    assert.equal(equalFindings[0]?.severity, 'high');

    const smallerFindings = analyzeSources(
      singleSource(`
        import Fastify from 'fastify';
        const app = Fastify({ keepAliveTimeout: 65_000 });
        app.server.headersTimeout = 60_000;
        app.listen({ port: 3000 });
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10000).unref();
          app.close().then(() => process.exit(0));
        });
      `)
    );
    assert.equal(smallerFindings.length, 1);
    assert.equal(smallerFindings[0]?.ruleId, 'SDG002');
    assert.equal(smallerFindings[0]?.severity, 'high');
  });

  it('stays clean when headersTimeout (66000) > keepAliveTimeout (65000)', () => {
    const findings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const KEEP_ALIVE = 65_000;
        const HEADERS = KEEP_ALIVE + 1_000;
        const server = http.createServer();
        server.keepAliveTimeout = KEEP_ALIVE;
        server.headersTimeout = HEADERS;
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close(() => process.exit(0));
        });
      `)
    );
    assert.equal(findings.length, 0);
  });

  it('leaves dynamic external timeout values unflagged', () => {
    const findings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_MS);
        server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS);
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close(() => process.exit(0));
        });
      `),
      { lbIdleTimeoutSec: 60 }
    );
    assert.equal(findings.length, 0);
  });
});

describe('Rule SDG003 - keepAliveTimeout unset or <= lb-idle-timeout', () => {
  it('emits info by default when keepAliveTimeout is unset', () => {
    const findings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close(() => process.exit(0));
        });
      `)
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'SDG003');
    assert.equal(findings[0]?.severity, 'info');
  });

  it('emits medium when --lb-idle-timeout 60 is passed and keepAliveTimeout is unset or <= 60000', () => {
    const unsetFindings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close(() => process.exit(0));
        });
      `),
      { lbIdleTimeoutSec: 60 }
    );
    assert.equal(unsetFindings.length, 1);
    assert.equal(unsetFindings[0]?.ruleId, 'SDG003');
    assert.equal(unsetFindings[0]?.severity, 'medium');

    const tooLowFindings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 60 * 1000;
        server.headersTimeout = 65_000;
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close(() => process.exit(0));
        });
      `),
      { lbIdleTimeoutSec: 60 }
    );
    assert.equal(tooLowFindings.length, 1);
    assert.equal(tooLowFindings[0]?.ruleId, 'SDG003');
    assert.equal(tooLowFindings[0]?.severity, 'medium');
  });

  it('stays clean when --lb-idle-timeout 60 and keepAliveTimeout = 65000', () => {
    const findings = analyzeSources(
      singleSource(`
        import Fastify from 'fastify';
        const app = Fastify({ keepAliveTimeout: 65_000 });
        app.server.headersTimeout = 66_000;
        await app.listen({ port: 3000 });
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          app.close().then(() => process.exit(0));
        });
      `),
      { lbIdleTimeoutSec: 60 }
    );
    assert.equal(findings.length, 0);
  });
});

describe('Rule SDG004 - Synchronous process.exit() before .close()', () => {
  it('flags immediate process.exit(0) and unawaited server.close(); process.exit(0)', () => {
    const directFindings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
        process.on('SIGTERM', () => {
          process.exit(0);
        });
      `)
    );
    assert.equal(directFindings.length, 1);
    assert.equal(directFindings[0]?.ruleId, 'SDG004');
    assert.equal(directFindings[0]?.severity, 'medium');

    const unawaitedFindings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
        function handleShutdown() {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close();
          process.exit(0);
        }
        process.on('SIGINT', () => handleShutdown());
      `)
    );
    assert.equal(unawaitedFindings.length, 1);
    assert.equal(unawaitedFindings[0]?.ruleId, 'SDG004');
  });

  it('stays clean on server.close(cb), .close().then(cb), await server.close(), and setTimeout', () => {
    const callbackClean = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000);
          server.close(() => process.exit(0));
        });
      `)
    );
    assert.equal(callbackClean.length, 0);

    const thenClean = analyzeSources(
      singleSource(`
        import Fastify from 'fastify';
        const app = Fastify({ keepAliveTimeout: 65_000 });
        app.server.headersTimeout = 66_000;
        app.listen({ port: 3000 });
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          app.close().then(() => process.exit(0));
        });
      `)
    );
    assert.equal(thenClean.length, 0);

    const awaitClean = analyzeSources(
      singleSource(`
        import Fastify from 'fastify';
        const app = Fastify({ keepAliveTimeout: 65_000 });
        app.server.headersTimeout = 66_000;
        await app.listen({ port: 3000 });
        async function shutdown() {
          setTimeout(() => process.exit(1), 10_000).unref();
          await app.close();
          process.exit(0);
        }
        process.on('SIGTERM', shutdown);
      `)
    );
    assert.equal(awaitClean.length, 0);
  });
});

describe('Rule SDG005 - .close() without forced-exit fallback timer', () => {
  it('flags .close() handler lacking a setTimeout calling process.exit or process.abort', () => {
    const noTimerFindings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
        process.on('SIGTERM', () => {
          server.close(() => process.exit(0));
        });
      `)
    );
    assert.equal(noTimerFindings.length, 1);
    assert.equal(noTimerFindings[0]?.ruleId, 'SDG005');
    assert.equal(noTimerFindings[0]?.severity, 'low');

    const nonExitTimerFindings = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => console.warn('still closing'), 10_000);
          server.close(() => process.exit(0));
        });
      `)
    );
    assert.equal(nonExitTimerFindings.length, 1);
    assert.equal(nonExitTimerFindings[0]?.ruleId, 'SDG005');
  });

  it('stays clean with setTimeout(() => process.exit(1), 10000).unref() or named abort timer callback', () => {
    const unrefClean = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close(() => process.exit(0));
        });
      `)
    );
    assert.equal(unrefClean.length, 0);

    const namedCallbackClean = analyzeSources(
      singleSource(`
        import http from 'node:http';
        const server = http.createServer();
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(3000);
        function forceAbort() {
          process.abort();
        }
        function shutdown() {
          setTimeout(forceAbort, 10_000);
          server.close(() => process.exit(0));
        }
        process.on('SIGTERM', () => shutdown());
      `)
    );
    assert.equal(namedCallbackClean.length, 0);
  });
});
