import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSarifLog,
  formatJson,
  formatReport,
  formatSarif,
  formatText,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  RULES,
  summarizeFindings,
  type CheckReport,
  type Finding,
} from '../src/index.js';

const SAMPLE_FINDINGS: readonly Finding[] = [
  {
    ruleId: 'SDG002',
    severity: 'high',
    message: 'headersTimeout (60000ms) <= keepAliveTimeout (65000ms)',
    file: 'src/server.ts',
    line: 8,
    column: 1,
    endLine: 8,
    endColumn: 32,
  },
  {
    ruleId: 'SDG004',
    severity: 'medium',
    message: 'Synchronous process.exit before .close()',
    file: 'src/server.ts',
    line: 14,
    column: 3,
    endLine: 14,
    endColumn: 18,
  },
  {
    ruleId: 'SDG005',
    severity: 'low',
    message: 'Missing fallback timer',
    file: 'src/shutdown.ts',
    line: 5,
    column: 3,
    endLine: 5,
    endColumn: 21,
  },
];

function makeSampleReport(findings: readonly Finding[]): CheckReport {
  return {
    tool: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    target: '.',
    scannedFiles: 2,
    options: {
      failOn: 'medium',
      includeTests: false,
      lbIdleTimeoutSec: 60,
    },
    summary: summarizeFindings(findings),
    findings,
  };
}

describe('Output Formatters (text, json, sarif v2.1.0)', () => {
  it('formats clean and non-empty reports as deterministic text', () => {
    const cleanText = formatText(makeSampleReport([]));
    assert.equal(cleanText, 'shutdown-guard: 0 findings across 2 scanned file(s).');

    const fullText = formatReport(makeSampleReport(SAMPLE_FINDINGS), 'text');
    assert.ok(fullText.includes('src/server.ts:8:1 [high] SDG002:'));
    assert.ok(fullText.includes('src/server.ts:14:3 [medium] SDG004:'));
    assert.ok(fullText.includes('src/shutdown.ts:5:3 [low] SDG005:'));
    assert.ok(fullText.includes('3 finding(s) (1 high, 1 medium, 1 low, 0 info)'));
  });

  it('formats valid JSON reports with accurate summary counts', () => {
    const rawJson = formatJson(makeSampleReport(SAMPLE_FINDINGS));
    const parsed = JSON.parse(rawJson) as CheckReport;
    assert.equal(parsed.tool, PACKAGE_NAME);
    assert.equal(parsed.version, PACKAGE_VERSION);
    assert.equal(parsed.summary.total, 3);
    assert.equal(parsed.summary.high, 1);
    assert.equal(parsed.summary.medium, 1);
    assert.equal(parsed.summary.low, 1);
    assert.equal(parsed.summary.info, 0);
    assert.equal(parsed.findings.length, 3);
  });

  it('emits valid SARIF v2.1.0 log structure with exact 5 rules and level mappings', () => {
    const report = makeSampleReport(SAMPLE_FINDINGS);
    const sarifRaw = formatSarif(report);
    const sarif = JSON.parse(sarifRaw) as ReturnType<typeof buildSarifLog>;

    assert.equal(sarif.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs.length, 1);

    const run = sarif.runs[0];
    assert.equal(run.tool.driver.name, PACKAGE_NAME);
    assert.equal(run.tool.driver.version, PACKAGE_VERSION);
    assert.equal(run.tool.driver.rules.length, 5);
    assert.deepEqual(
      run.tool.driver.rules.map((r) => r.id),
      RULES.map((r) => r.id)
    );

    assert.equal(run.results.length, 3);
    assert.equal(run.results[0]?.ruleId, 'SDG002');
    assert.equal(run.results[0]?.level, 'error');
    assert.equal(run.results[0]?.locations[0].physicalLocation.artifactLocation.uri, 'src/server.ts');
    assert.equal(run.results[0]?.locations[0].physicalLocation.region.startLine, 8);

    assert.equal(run.results[1]?.ruleId, 'SDG004');
    assert.equal(run.results[1]?.level, 'warning');

    assert.equal(run.results[2]?.ruleId, 'SDG005');
    assert.equal(run.results[2]?.level, 'note');
  });
});
