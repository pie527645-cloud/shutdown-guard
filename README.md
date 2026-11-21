# @pie527645-cloud/shutdown-guard

Static TypeScript & JavaScript AST verifier for Node.js HTTP graceful shutdown signal handlers, connection drain paths, and keep-alive timeout ordering.

`shutdown-guard` uses a two-pass TypeScript Compiler API AST analyzer across `http`, `https`, `express`, and `fastify` codebases to catch production 502/504 rolling-deploy drops before merge—without adding runtime dependencies or modifying application code.

## Installation

```bash
npm install --save-dev @pie527645-cloud/shutdown-guard
```

Or run directly in CI:

```bash
npx @pie527645-cloud/shutdown-guard check . --lb-idle-timeout 60 --format sarif
```

Requires **Node.js `>=20.18.1`**.

## CLI Usage

```text
shutdown-guard check [target] [options]
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | `.` | Project directory or single source file to scan |
| `--format <text\|json\|sarif>` | `text` | Output format (`text`, `json`, or SARIF v2.1.0 `sarif`) |
| `--lb-idle-timeout <sec>` | unset | Upstream load balancer idle timeout in seconds (e.g. `60` for AWS ALB) |
| `--fail-on <high\|medium\|low\|info\|none>` | `medium` | Minimum finding severity that returns exit code `1` |
| `--include-tests` | `false` | Include `test/`, `tests/`, `__tests__/`, `*.test.*`, and `*.spec.*` files |
| `-h, --help` | - | Print CLI usage help |
| `-v, --version` | - | Print package version |

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Clean, all findings strictly below `--fail-on`, or `--fail-on none` |
| `1` | One or more findings at or above the `--fail-on` severity threshold |
| `2` | Invalid CLI arguments, invalid `--lb-idle-timeout`, missing target, or `SYMLINK_ESCAPE_BLOCKED` |

## Rules (`v1`)

| Rule ID | Severity | Condition |
| --- | --- | --- |
| `SDG001` | `medium` | An `http`, `https`, `express`, or `fastify` server calls `.listen(...)` with no `process.on` / `once` / `addListener` handler for `SIGTERM` or `SIGINT` anywhere in the scanned project. |
| `SDG002` | `high` | `headersTimeout <= keepAliveTimeout` on the same server (when both resolve to numeric literals or local numeric `const` expressions). Node.js requires `headersTimeout > keepAliveTimeout` so idle keep-alive sockets are not reset mid-header. |
| `SDG003` | `info` (default) / `medium` (with `--lb-idle-timeout <sec>`) | Server calls `.listen(...)` with `keepAliveTimeout` unset (`http`, `https`, and `express` default to `5000ms` in Node.js: `info` by default, or `medium` when `5000 <= sec * 1000`; `fastify` defaults to `72000ms`: unflagged by default, `medium` only when `72000 <= sec * 1000`), or static `keepAliveTimeout <= sec * 1000` (`medium` for any framework). Dynamic external values (e.g. environment variables) are left unflagged. |
| `SDG004` | `medium` | A `SIGTERM` or `SIGINT` handler invokes `process.exit(...)` synchronously before any awaited or callback `.close(...)` (including `promisify(server.close.bind(server))()`) finishes draining active requests. |
| `SDG005` | `low` | A `SIGTERM` or `SIGINT` handler calls `.close(...)` without scheduling a forced-exit fallback timer (`setTimeout` calling `process.exit` or `process.abort`, with or without `.unref()`). |

## Recommended Production Pattern

```ts
import http from 'node:http';

const KEEP_ALIVE_MS = 65_000; // > 60s upstream load balancer idle timeout
const HEADERS_TIMEOUT_MS = 66_000; // > keepAliveTimeout

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end('ok');
});

server.keepAliveTimeout = KEEP_ALIVE_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.listen(3000);

function shutdown(): void {
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    process.exit(0);
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, shutdown);
}
```

## Programmatic API

```ts
import { checkProject, formatReport } from '@pie527645-cloud/shutdown-guard';

const report = checkProject({
  target: './src',
  lbIdleTimeoutSec: 60,
  failOn: 'medium',
});

console.log(formatReport(report, 'json'));
```

## Prior Art

Graceful HTTP teardown spans runtime libraries and container linters, each addressing a different layer:

- **`@godaddy/terminus` (`terminus`)** and **`http-terminator`**: Runtime Node.js libraries wired directly into an `http.Server` instance to track sockets, expose health checks, and orchestrate connection draining at runtime. They require modifying production server code and adding runtime dependencies, and they do not statically audit whether `headersTimeout > keepAliveTimeout > lbIdleTimeout` holds across services that manage shutdown directly.
- **`hadolint DL3025`** and Docker's built-in **`JSONArgsRecommended`** check: Container build linters that verify `CMD` / `ENTRYPOINT` use exec-form JSON arrays so PID 1 forwards `SIGTERM` to Node.js rather than swallowing it inside `/bin/sh -c`.

**What `shutdown-guard` adds**: Zero-runtime-impact, decidable CI-time AST verification of the Node.js application layer itself—proving across multi-file TypeScript/JavaScript projects that listening servers register `SIGTERM`/`SIGINT` handlers (`SDG001`), satisfy `headersTimeout > keepAliveTimeout > lbIdleTimeout` (`SDG002`, `SDG003`), wait for `.close()` before `process.exit()` (`SDG004`), and arm a bounded fallback exit timer (`SDG005`), without replicating Dockerfile or Kubernetes manifest linters.

## License

MIT
