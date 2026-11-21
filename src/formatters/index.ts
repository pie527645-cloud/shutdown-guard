import { RULES } from '../rules.js';
import {
  type CheckReport,
  type OutputFormat,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type RuleId,
  type Severity,
} from '../types.js';

export type SarifLevel = 'error' | 'warning' | 'note';

export interface SarifLog {
  readonly $schema: string;
  readonly version: '2.1.0';
  readonly runs: readonly [
    {
      readonly tool: {
        readonly driver: {
          readonly name: string;
          readonly version: string;
          readonly informationUri: string;
          readonly rules: readonly {
            readonly id: RuleId;
            readonly name: string;
            readonly shortDescription: { readonly text: string };
            readonly fullDescription: { readonly text: string };
            readonly help: { readonly text: string };
            readonly defaultConfiguration: { readonly level: SarifLevel };
          }[];
        };
      };
      readonly results: readonly {
        readonly ruleId: RuleId;
        readonly ruleIndex: number;
        readonly level: SarifLevel;
        readonly message: { readonly text: string };
        readonly locations: readonly [
          {
            readonly physicalLocation: {
              readonly artifactLocation: {
                readonly uri: string;
                readonly uriBaseId: '%SRCROOT%';
              };
              readonly region: {
                readonly startLine: number;
                readonly startColumn: number;
                readonly endLine: number;
                readonly endColumn: number;
              };
            };
          },
        ];
        readonly properties: {
          readonly severity: Severity;
        };
      }[];
    },
  ];
}

export function severityToSarifLevel(severity: Severity): SarifLevel {
  switch (severity) {
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
    case 'info':
      return 'note';
  }
}

export function formatText(report: CheckReport): string {
  const lines: string[] = [];

  for (const finding of report.findings) {
    lines.push(
      `${finding.file}:${finding.line}:${finding.column} [${finding.severity}] ${finding.ruleId}: ${finding.message}`
    );
  }

  if (report.findings.length === 0) {
    lines.push(
      `shutdown-guard: 0 findings across ${report.scannedFiles} scanned file(s).`
    );
  } else {
    const s = report.summary;
    lines.push(
      `shutdown-guard: ${s.total} finding(s) (${s.high} high, ${s.medium} medium, ${s.low} low, ${s.info} info) across ${report.scannedFiles} scanned file(s).`
    );
  }

  return lines.join('\n');
}

export function formatJson(report: CheckReport): string {
  return JSON.stringify(report, null, 2);
}

export function buildSarifLog(report: CheckReport): SarifLog {
  const ruleIndexMap = new Map<RuleId, number>();
  RULES.forEach((rule, idx) => {
    ruleIndexMap.set(rule.id, idx);
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: PACKAGE_NAME,
            version: PACKAGE_VERSION,
            informationUri: 'https://github.com/pie527645-cloud/shutdown-guard',
            rules: RULES.map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: rule.shortDescription },
              fullDescription: { text: rule.fullDescription },
              help: { text: rule.helpText },
              defaultConfiguration: {
                level: severityToSarifLevel(rule.defaultSeverity),
              },
            })),
          },
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          ruleIndex: ruleIndexMap.get(finding.ruleId) ?? 0,
          level: severityToSarifLevel(finding.severity),
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: finding.file.replaceAll('\\', '/'),
                  uriBaseId: '%SRCROOT%',
                },
                region: {
                  startLine: finding.line,
                  startColumn: finding.column,
                  endLine: finding.endLine,
                  endColumn: finding.endColumn,
                },
              },
            },
          ],
          properties: {
            severity: finding.severity,
          },
        })),
      },
    ],
  };
}

export function formatSarif(report: CheckReport): string {
  return JSON.stringify(buildSarifLog(report), null, 2);
}

export function formatReport(report: CheckReport, format: OutputFormat = 'text'): string {
  switch (format) {
    case 'json':
      return formatJson(report);
    case 'sarif':
      return formatSarif(report);
    case 'text':
    default:
      return formatText(report);
  }
}
