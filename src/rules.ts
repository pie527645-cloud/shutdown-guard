import type { FailOnThreshold, Finding, RuleId, RuleMetadata, Severity, SeveritySummary } from './types.js';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
};

export const RULES: readonly RuleMetadata[] = [
  {
    id: 'SDG001',
    name: 'MissingShutdownSignalHandler',
    defaultSeverity: 'medium',
    shortDescription: 'HTTP server calls .listen() with no SIGTERM or SIGINT handler in the scanned project.',
    fullDescription:
      'An http, https, express, or fastify server starts listening for traffic, but no process signal listener for SIGTERM or SIGINT was found across scanned project files.',
    helpText:
      'Register process.on("SIGTERM", shutdown) and process.on("SIGINT", shutdown) to stop accepting new connections and drain active requests cleanly.',
  },
  {
    id: 'SDG002',
    name: 'HeadersTimeoutNotGreaterThanKeepAlive',
    defaultSeverity: 'high',
    shortDescription: 'Server headersTimeout is set less than or equal to keepAliveTimeout.',
    fullDescription:
      'When headersTimeout is less than or equal to keepAliveTimeout on a Node.js HTTP server, the headers parser timer can expire while an idle keep-alive socket is reused, dropping in-flight requests.',
    helpText:
      'Configure server.headersTimeout strictly greater than server.keepAliveTimeout (for example keepAliveTimeout = 65_000 and headersTimeout = 66_000).',
  },
  {
    id: 'SDG003',
    name: 'KeepAliveTimeoutUnsetOrBelowLoadBalancer',
    defaultSeverity: 'info',
    shortDescription: 'Server keepAliveTimeout is unset or not greater than the load balancer idle timeout.',
    fullDescription:
      'Node.js http, https, and express servers default keepAliveTimeout to 5000ms when unset, while Fastify defaults keepAliveTimeout to 72000ms (72s). Behind a reverse proxy or load balancer, server keepAliveTimeout must exceed the upstream idle timeout so the upstream closes idle sockets first instead of racing new requests onto closing sockets.',
    helpText:
      'Explicitly set keepAliveTimeout above your upstream load balancer idle timeout (for example 65_000ms behind a 60s load balancer, or Fastify({ keepAliveTimeout: 75_000 }) behind a >=72s load balancer) and set headersTimeout higher still.',
  },
  {
    id: 'SDG004',
    name: 'SynchronousProcessExitBeforeClose',
    defaultSeverity: 'medium',
    shortDescription: 'Signal handler calls process.exit() synchronously before an awaited or callback .close().',
    fullDescription:
      'Calling process.exit() synchronously inside a SIGTERM or SIGINT handler terminates the event loop immediately and aborts active HTTP requests before server.close() completes draining.',
    helpText:
      'Wait for server.close(callback), await server.close(), or await promisify(server.close.bind(server))() to finish draining active requests before calling process.exit(0), keeping forced process.exit(1) inside a fallback setTimeout.',
  },
  {
    id: 'SDG005',
    name: 'MissingForcedExitFallbackTimer',
    defaultSeverity: 'low',
    shortDescription: 'Signal handler calls .close() without a forced-exit fallback setTimeout timer.',
    fullDescription:
      'server.close() waits indefinitely if long-lived connections or stuck handlers never finish, risking an abrupt SIGKILL from the orchestrator without controlled teardown logging or exit status.',
    helpText:
      'Schedule a bounded watchdog timer such as setTimeout(() => process.exit(1), 10_000).unref() inside the shutdown handler.',
  },
];

export const RULE_MAP: ReadonlyMap<RuleId, RuleMetadata> = new Map(
  RULES.map((rule) => [rule.id, rule])
);

export function summarizeFindings(findings: readonly Finding[]): SeveritySummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  let info = 0;

  for (const finding of findings) {
    switch (finding.severity) {
      case 'high':
        high += 1;
        break;
      case 'medium':
        medium += 1;
        break;
      case 'low':
        low += 1;
        break;
      case 'info':
        info += 1;
        break;
    }
  }

  return {
    total: findings.length,
    high,
    medium,
    low,
    info,
  };
}

export function exceedsFailOnThreshold(
  findings: readonly Finding[],
  failOn: FailOnThreshold
): boolean {
  if (failOn === 'none') {
    return false;
  }
  const minRank = SEVERITY_RANK[failOn];
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] >= minRank) {
      return true;
    }
  }
  return false;
}
