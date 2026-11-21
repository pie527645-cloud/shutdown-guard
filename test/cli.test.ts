import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { CheckReport, SarifLog } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');

interface CliExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeCli(args: readonly string[], cwd: string = REPO_ROOT): CliExecResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof e.status === 'number' ? e.status : 2,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? ''),
    };
  }
}

describe('CLI integration & exit code contract', () => {
  it('ensures dist/cli.js has LF line endings and #!/usr/bin/env node shebang', () => {
    const raw = fs.readFileSync(CLI_PATH, 'utf8');
    assert.equal(raw.startsWith('#!/usr/bin/env node\n'), true);
    assert.equal(raw.includes('\r\n'), false);
  });

  it('supports --help and --version with exit code 0', () => {
    const helpRes = invokeCli(['--help']);
    assert.equal(helpRes.status, 0);
    assert.ok(helpRes.stdout.includes('shutdown-guard check [target]'));

    const verRes = invokeCli(['--version']);
    assert.equal(verRes.status, 0);
    assert.equal(verRes.stdout.trim(), '1.0.0');
  });

  it('returns exit code 0 on clean self-check and when findings are below --fail-on threshold', () => {
    const selfRes = invokeCli(['check', '.', '--format', 'json']);
    assert.equal(selfRes.status, 0);
    const selfReport = JSON.parse(selfRes.stdout) as CheckReport;
    assert.equal(selfReport.summary.total, 0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-threshold-'));
    try {
      // Server has SIGTERM + fallback timer + safe close, only keepAliveTimeout unset -> SDG003 (info)
      fs.writeFileSync(
        path.join(tmpDir, 'server.ts'),
        `
        import http from 'node:http';
        const server = http.createServer();
        server.listen(3000);
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(1), 10_000).unref();
          server.close(() => process.exit(0));
        });
      `,
        'utf8'
      );

      // Default --fail-on medium -> info finding exits 0
      const defaultRes = invokeCli(['check', tmpDir, '--format', 'json']);
      assert.equal(defaultRes.status, 0);
      const parsed = JSON.parse(defaultRes.stdout) as CheckReport;
      assert.equal(parsed.summary.info, 1);

      // --fail-on info -> info finding exits 1
      const strictRes = invokeCli(['check', tmpDir, '--fail-on', 'info', '--format', 'json']);
      assert.equal(strictRes.status, 1);

      // --lb-idle-timeout 60 -> promotes SDG003 to medium -> exits 1 under default --fail-on medium
      const lbRes = invokeCli(['check', tmpDir, '--lb-idle-timeout', '60', '--format', 'sarif']);
      assert.equal(lbRes.status, 1);
      const sarif = JSON.parse(lbRes.stdout) as SarifLog;
      assert.equal(sarif.version, '2.1.0');
      assert.equal(sarif.runs[0].results[0]?.ruleId, 'SDG003');
      assert.equal(sarif.runs[0].results[0]?.level, 'warning');

      // --fail-on none -> always exits 0 even with medium/high findings
      const noneRes = invokeCli([
        'check',
        tmpDir,
        '--lb-idle-timeout',
        '60',
        '--fail-on',
        'none',
      ]);
      assert.equal(noneRes.status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 on invalid CLI arguments, invalid --lb-idle-timeout, missing target, or symlink escape', () => {
    assert.equal(invokeCli([]).status, 2);
    assert.equal(invokeCli(['unknown']).status, 2);
    assert.equal(invokeCli(['check', '.', '--unknown-flag']).status, 2);
    assert.equal(invokeCli(['check', '.', '--format', 'xml']).status, 2);
    assert.equal(invokeCli(['check', '.', '--fail-on', 'blocker']).status, 2);
    assert.equal(invokeCli(['check', '.', '--lb-idle-timeout', 'abc']).status, 2);
    assert.equal(invokeCli(['check', '.', '--lb-idle-timeout', '0']).status, 2);
    assert.equal(invokeCli(['check', '.', '--lb-idle-timeout', '-30']).status, 2);
    assert.equal(invokeCli(['check', './definitely-does-not-exist-99999']).status, 2);

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-symroot-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-symout-'));
    try {
      fs.writeFileSync(path.join(outDir, 'leak.ts'), 'export const a = 1;\n', 'utf8');
      const linkPath = path.join(rootDir, 'escape-junction');
      fs.symlinkSync(outDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      const escapeRes = invokeCli(['check', rootDir]);
      assert.equal(escapeRes.status, 2);
      assert.ok(escapeRes.stderr.includes('SYMLINK_ESCAPE_BLOCKED'));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
