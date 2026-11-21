import * as path from 'node:path';
import ts from 'typescript';
import {
  evaluateNumericExpression,
  evaluateStringValues,
  findConstInitializerInScope,
  getStaticPropertyName,
  unwrapExpression,
} from './numericEval.js';
import type { Finding, RuleId, Severity, SourceInput } from '../types.js';

type ServerFramework = 'http' | 'https' | 'express' | 'fastify';

type TimeoutSetting =
  | { readonly state: 'unset' }
  | { readonly state: 'dynamic'; readonly file: ParsedFileRecord; readonly node: ts.Node }
  | {
      readonly state: 'numeric';
      readonly value: number;
      readonly file: ParsedFileRecord;
      readonly node: ts.Node;
    };

interface ListenSite {
  readonly file: ParsedFileRecord;
  readonly node: ts.CallExpression;
}

interface ServerEntity {
  readonly id: number;
  readonly framework: ServerFramework;
  keepAliveTimeout: TimeoutSetting;
  headersTimeout: TimeoutSetting;
  readonly listenSites: ListenSite[];
}

interface ImportBinding {
  readonly moduleSpecifier: string;
  readonly importedName: string; // 'default' | '*' | named export
}

export type FunctionLikeTarget =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

interface FunctionRecord {
  readonly file: ParsedFileRecord;
  readonly node: FunctionLikeTarget;
}

interface SignalRegistration {
  readonly file: ParsedFileRecord;
  readonly callNode: ts.CallExpression;
  readonly signals: readonly string[];
  readonly handlerArg: ts.Expression;
}

interface ParsedFileRecord {
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly sourceFile: ts.SourceFile;
  readonly imports: Map<string, ImportBinding>;
  readonly requireHelperNames: Set<string>;
  readonly processAliases: Set<string>;
  readonly exportedConsts: Map<string, ts.Expression>;
  readonly localFunctions: Map<string, FunctionRecord>;
  readonly exportedFunctions: Map<string, FunctionRecord>;
  readonly varToServer: Map<string, ServerEntity>;
  readonly exportedServers: Map<string, ServerEntity>;
  readonly factoryReturnServers: Map<string, ServerEntity>;
  readonly exportedFactories: Map<string, ServerEntity>;
  readonly signalRegistrations: SignalRegistration[];
}

export interface AnalyzerOptions {
  readonly lbIdleTimeoutSec?: number;
}

const HTTP_SPECIFIERS = new Set<string>(['http', 'node:http']);
const HTTPS_SPECIFIERS = new Set<string>(['https', 'node:https']);
const PROCESS_SPECIFIERS = new Set<string>(['process', 'node:process']);
const TIMERS_SPECIFIERS = new Set<string>(['timers', 'node:timers']);
const MODULE_SPECIFIERS = new Set<string>(['module', 'node:module']);
const UTIL_SPECIFIERS = new Set<string>(['util', 'node:util']);

const CANDIDATE_RELATIVE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.mts',
  '/index.cts',
  '/index.js',
  '/index.mjs',
  '/index.cjs',
];

function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.mts':
    case '.cts':
    case '.ts':
    default:
      return ts.ScriptKind.TS;
  }
}

function normalizeLookupKey(filePath: string): string {
  const resolved = path.resolve(filePath).replaceAll('\\', '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const mods = ts.getModifiers(node);
  if (!mods) {
    return false;
  }
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const mods = ts.getModifiers(node);
  if (!mods) {
    return false;
  }
  return mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function isFunctionLikeInit(expr: ts.Expression): FunctionLikeTarget | null {
  const unwrapped = unwrapExpression(expr);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return unwrapped;
  }
  return null;
}

function nodeToFinding(
  ruleId: RuleId,
  severity: Severity,
  message: string,
  file: ParsedFileRecord,
  node: ts.Node
): Finding {
  const startPos = node.getStart(file.sourceFile);
  const endPos = node.getEnd();
  const startLoc = file.sourceFile.getLineAndCharacterOfPosition(startPos);
  const endLoc = file.sourceFile.getLineAndCharacterOfPosition(endPos);

  return {
    ruleId,
    severity,
    message,
    file: file.displayPath,
    line: startLoc.line + 1,
    column: startLoc.character + 1,
    endLine: endLoc.line + 1,
    endColumn: endLoc.character + 1,
  };
}

export function analyzeSources(
  sources: readonly SourceInput[],
  options: AnalyzerOptions = {}
): readonly Finding[] {
  let nextServerId = 1;
  const allServers: ServerEntity[] = [];
  const fileRecords: ParsedFileRecord[] = [];
  const fileLookup = new Map<string, ParsedFileRecord>();

  function createServerEntity(framework: ServerFramework): ServerEntity {
    const entity: ServerEntity = {
      id: nextServerId,
      framework,
      keepAliveTimeout: { state: 'unset' },
      headersTimeout: { state: 'unset' },
      listenSites: [],
    };
    nextServerId += 1;
    allServers.push(entity);
    return entity;
  }

  for (const src of sources) {
    const sf = ts.createSourceFile(
      src.displayPath,
      src.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(src.displayPath)
    );
    const record: ParsedFileRecord = {
      absolutePath: src.absolutePath,
      displayPath: src.displayPath,
      sourceFile: sf,
      imports: new Map(),
      requireHelperNames: new Set(['require']),
      processAliases: new Set(['process']),
      exportedConsts: new Map(),
      localFunctions: new Map(),
      exportedFunctions: new Map(),
      varToServer: new Map(),
      exportedServers: new Map(),
      factoryReturnServers: new Map(),
      exportedFactories: new Map(),
      signalRegistrations: [],
    };
    fileRecords.push(record);
    fileLookup.set(normalizeLookupKey(src.absolutePath), record);
  }

  function resolveRelativeFile(fromFile: ParsedFileRecord, specifier: string): ParsedFileRecord | undefined {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      return undefined;
    }
    const baseDir = path.dirname(fromFile.absolutePath);
    const rawTarget = path.resolve(baseDir, specifier);

    const strippedCandidates = [rawTarget];
    const lower = rawTarget.toLowerCase();
    if (lower.endsWith('.js') || lower.endsWith('.jsx')) {
      strippedCandidates.push(rawTarget.slice(0, rawTarget.lastIndexOf('.')));
    } else if (lower.endsWith('.mjs')) {
      strippedCandidates.push(`${rawTarget.slice(0, -4)}.mts`, rawTarget.slice(0, -4));
    } else if (lower.endsWith('.cjs')) {
      strippedCandidates.push(`${rawTarget.slice(0, -4)}.cts`, rawTarget.slice(0, -4));
    }

    for (const stem of strippedCandidates) {
      for (const suffix of CANDIDATE_RELATIVE_EXTENSIONS) {
        const candidate = `${stem}${suffix}`;
        const hit = fileLookup.get(normalizeLookupKey(candidate));
        if (hit !== undefined) {
          return hit;
        }
      }
    }
    return undefined;
  }

  // Pass 1A: Collect imports, const exports, and function declarations across all files
  for (const record of fileRecords) {
    const sf = record.sourceFile;
    let createRequireIdent: string | null = null;

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        const clause = stmt.importClause;
        if (!clause) {
          continue;
        }
        if (clause.name) {
          record.imports.set(clause.name.text, { moduleSpecifier: spec, importedName: 'default' });
          if (PROCESS_SPECIFIERS.has(spec)) {
            record.processAliases.add(clause.name.text);
          }
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            const localName = clause.namedBindings.name.text;
            record.imports.set(localName, { moduleSpecifier: spec, importedName: '*' });
            if (PROCESS_SPECIFIERS.has(spec)) {
              record.processAliases.add(localName);
            }
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              const imported = element.propertyName ? element.propertyName.text : element.name.text;
              const local = element.name.text;
              record.imports.set(local, { moduleSpecifier: spec, importedName: imported });
              if (MODULE_SPECIFIERS.has(spec) && imported === 'createRequire') {
                createRequireIdent = local;
              }
            }
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const fnRec: FunctionRecord = { file: record, node: stmt };
        record.localFunctions.set(stmt.name.text, fnRec);
        if (hasExportModifier(stmt)) {
          record.exportedFunctions.set(stmt.name.text, fnRec);
          if (hasDefaultModifier(stmt)) {
            record.exportedFunctions.set('default', fnRec);
          }
        }
      } else if (ts.isVariableStatement(stmt)) {
        const isExported = hasExportModifier(stmt);
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;

        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer) {
            const unwrappedInit = unwrapExpression(decl.initializer);

            // Detect const req = createRequire(...)
            if (
              createRequireIdent !== null &&
              ts.isIdentifier(decl.name) &&
              ts.isCallExpression(unwrappedInit) &&
              ts.isIdentifier(unwrappedInit.expression) &&
              unwrappedInit.expression.text === createRequireIdent
            ) {
              record.requireHelperNames.add(decl.name.text);
            }

            // Detect CommonJS / createRequire imports: const x = require('...') or const { a } = require('...')
            if (
              ts.isCallExpression(unwrappedInit) &&
              ts.isIdentifier(unwrappedInit.expression) &&
              record.requireHelperNames.has(unwrappedInit.expression.text) &&
              unwrappedInit.arguments.length === 1 &&
              ts.isStringLiteral(unwrappedInit.arguments[0]!)
            ) {
              const spec = unwrappedInit.arguments[0]!.text;
              if (ts.isIdentifier(decl.name)) {
                record.imports.set(decl.name.text, { moduleSpecifier: spec, importedName: '*' });
                if (PROCESS_SPECIFIERS.has(spec)) {
                  record.processAliases.add(decl.name.text);
                }
              } else if (ts.isObjectBindingPattern(decl.name)) {
                for (const elem of decl.name.elements) {
                  if (ts.isIdentifier(elem.name)) {
                    const imported =
                      elem.propertyName && ts.isIdentifier(elem.propertyName)
                        ? elem.propertyName.text
                        : elem.name.text;
                    record.imports.set(elem.name.text, {
                      moduleSpecifier: spec,
                      importedName: imported,
                    });
                    if (MODULE_SPECIFIERS.has(spec) && imported === 'createRequire') {
                      createRequireIdent = elem.name.text;
                    }
                  }
                }
              }
            }

            if (ts.isIdentifier(decl.name)) {
              if (isConst && isExported) {
                record.exportedConsts.set(decl.name.text, decl.initializer);
              }
              const fnInit = isFunctionLikeInit(decl.initializer);
              if (fnInit !== null) {
                const fnRec: FunctionRecord = { file: record, node: fnInit };
                record.localFunctions.set(decl.name.text, fnRec);
                if (isExported) {
                  record.exportedFunctions.set(decl.name.text, fnRec);
                }
              }
            }
          }
        }
      } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const elem of stmt.exportClause.elements) {
          const localName = elem.propertyName ? elem.propertyName.text : elem.name.text;
          const exportedName = elem.name.text;
          const localFn = record.localFunctions.get(localName);
          if (localFn) {
            record.exportedFunctions.set(exportedName, localFn);
          }
          const localConst = findConstInitializerInScope(localName, sf);
          if (localConst) {
            record.exportedConsts.set(exportedName, localConst);
          }
        }
      } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const expr = unwrapExpression(stmt.expression);
        if (ts.isIdentifier(expr)) {
          const localFn = record.localFunctions.get(expr.text);
          if (localFn) {
            record.exportedFunctions.set('default', localFn);
          }
        } else {
          const fnInit = isFunctionLikeInit(expr);
          if (fnInit) {
            record.exportedFunctions.set('default', { file: record, node: fnInit });
          }
        }
      }
    }

    // Also collect nested function declarations / const arrow functions inside functions or blocks
    function collectScopedFunctions(node: ts.Node): void {
      if (node !== sf) {
        if (ts.isFunctionDeclaration(node) && node.name && !record.localFunctions.has(node.name.text)) {
          record.localFunctions.set(node.name.text, { file: record, node });
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const fnInit = isFunctionLikeInit(node.initializer);
          if (fnInit !== null && !record.localFunctions.has(node.name.text)) {
            record.localFunctions.set(node.name.text, { file: record, node: fnInit });
          }
        }
      }
      ts.forEachChild(node, collectScopedFunctions);
    }
    collectScopedFunctions(sf);
  }

  function makeExportedConstResolver(
    record: ParsedFileRecord,
    visitedFiles: Set<ParsedFileRecord> = new Set()
  ): (identName: string) => ts.Expression | undefined {
    return (identName: string): ts.Expression | undefined => {
      if (visitedFiles.has(record)) {
        return undefined;
      }
      const binding = record.imports.get(identName);
      if (!binding) {
        return undefined;
      }
      const targetFile = resolveRelativeFile(record, binding.moduleSpecifier);
      if (!targetFile) {
        return undefined;
      }
      visitedFiles.add(record);
      return targetFile.exportedConsts.get(binding.importedName);
    };
  }

  function evalTimeoutExpr(record: ParsedFileRecord, expr: ts.Expression, reportNode: ts.Node): TimeoutSetting {
    const val = evaluateNumericExpression(expr, makeExportedConstResolver(record));
    if (val !== null) {
      return { state: 'numeric', value: val, file: record, node: reportNode };
    }
    return { state: 'dynamic', file: record, node: reportNode };
  }

  function applyServerOptionsObject(
    record: ParsedFileRecord,
    entity: ServerEntity,
    argExpr: ts.Expression
  ): void {
    let objExpr: ts.ObjectLiteralExpression | null = null;
    const unwrapped = unwrapExpression(argExpr);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      objExpr = unwrapped;
    } else if (ts.isIdentifier(unwrapped)) {
      const constInit = findConstInitializerInScope(
        unwrapped.text,
        unwrapped,
        makeExportedConstResolver(record)
      );
      if (constInit) {
        const unwrappedInit = unwrapExpression(constInit);
        if (ts.isObjectLiteralExpression(unwrappedInit)) {
          objExpr = unwrappedInit;
        }
      }
    }
    if (!objExpr) {
      return;
    }

    for (const prop of objExpr.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = getStaticPropertyName(prop.name);
        if (key === 'keepAliveTimeout') {
          entity.keepAliveTimeout = evalTimeoutExpr(record, prop.initializer, prop);
        } else if (key === 'headersTimeout') {
          entity.headersTimeout = evalTimeoutExpr(record, prop.initializer, prop);
        } else if (key === 'http' && entity.framework === 'fastify') {
          const nested = unwrapExpression(prop.initializer);
          if (ts.isObjectLiteralExpression(nested)) {
            applyServerOptionsObject(record, entity, nested);
          }
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const key = prop.name.text;
        if (key === 'keepAliveTimeout') {
          entity.keepAliveTimeout = evalTimeoutExpr(record, prop.name, prop);
        } else if (key === 'headersTimeout') {
          entity.headersTimeout = evalTimeoutExpr(record, prop.name, prop);
        }
      }
    }
  }

  function isInlineRequireOf(
    record: ParsedFileRecord,
    expr: ts.Expression,
    specifierPred: (spec: string) => boolean
  ): boolean {
    const unwrapped = unwrapExpression(expr);
    if (
      ts.isCallExpression(unwrapped) &&
      ts.isIdentifier(unwrapped.expression) &&
      record.requireHelperNames.has(unwrapped.expression.text) &&
      unwrapped.arguments.length === 1 &&
      ts.isStringLiteral(unwrapped.arguments[0]!)
    ) {
      return specifierPred(unwrapped.arguments[0]!.text);
    }
    return false;
  }

  function detectDirectServerCreation(
    record: ParsedFileRecord,
    expr: ts.Expression
  ): ServerEntity | null {
    const node = unwrapExpression(expr);
    if (!ts.isCallExpression(node)) {
      return null;
    }
    const callee = unwrapExpression(node.expression);

    // Case 1: http.createServer(...) / https.createServer(...) / require('http').createServer(...)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createServer') {
      const recv = unwrapExpression(callee.expression);
      if (ts.isIdentifier(recv)) {
        const imp = record.imports.get(recv.text);
        if (imp && HTTP_SPECIFIERS.has(imp.moduleSpecifier)) {
          const entity = createServerEntity('http');
          if (node.arguments[0]) {
            applyServerOptionsObject(record, entity, node.arguments[0]);
          }
          return entity;
        }
        if (imp && HTTPS_SPECIFIERS.has(imp.moduleSpecifier)) {
          const entity = createServerEntity('https');
          if (node.arguments[0]) {
            applyServerOptionsObject(record, entity, node.arguments[0]);
          }
          return entity;
        }
      } else if (isInlineRequireOf(record, recv, (s) => HTTP_SPECIFIERS.has(s))) {
        const entity = createServerEntity('http');
        if (node.arguments[0]) {
          applyServerOptionsObject(record, entity, node.arguments[0]);
        }
        return entity;
      } else if (isInlineRequireOf(record, recv, (s) => HTTPS_SPECIFIERS.has(s))) {
        const entity = createServerEntity('https');
        if (node.arguments[0]) {
          applyServerOptionsObject(record, entity, node.arguments[0]);
        }
        return entity;
      }
    }

    // Case 2: fastify.fastify(...)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fastify') {
      const recv = unwrapExpression(callee.expression);
      if (ts.isIdentifier(recv)) {
        const imp = record.imports.get(recv.text);
        if (imp && imp.moduleSpecifier === 'fastify') {
          const entity = createServerEntity('fastify');
          if (node.arguments[0]) {
            applyServerOptionsObject(record, entity, node.arguments[0]);
          }
          return entity;
        }
      }
    }

    // Case 3: createServer(...) / express() / fastify(...)
    if (ts.isIdentifier(callee)) {
      const imp = record.imports.get(callee.text);
      if (imp) {
        if (HTTP_SPECIFIERS.has(imp.moduleSpecifier) && imp.importedName === 'createServer') {
          const entity = createServerEntity('http');
          if (node.arguments[0]) {
            applyServerOptionsObject(record, entity, node.arguments[0]);
          }
          return entity;
        }
        if (HTTPS_SPECIFIERS.has(imp.moduleSpecifier) && imp.importedName === 'createServer') {
          const entity = createServerEntity('https');
          if (node.arguments[0]) {
            applyServerOptionsObject(record, entity, node.arguments[0]);
          }
          return entity;
        }
        if (imp.moduleSpecifier === 'express') {
          return createServerEntity('express');
        }
        if (imp.moduleSpecifier === 'fastify') {
          const entity = createServerEntity('fastify');
          if (node.arguments[0]) {
            applyServerOptionsObject(record, entity, node.arguments[0]);
          }
          return entity;
        }
      }
    }

    // Case 4: require('express')() / require('fastify')(opts)
    if (isInlineRequireOf(record, callee, (s) => s === 'express')) {
      return createServerEntity('express');
    }
    if (isInlineRequireOf(record, callee, (s) => s === 'fastify')) {
      const entity = createServerEntity('fastify');
      if (node.arguments[0]) {
        applyServerOptionsObject(record, entity, node.arguments[0]);
      }
      return entity;
    }

    return null;
  }

  function isProcessReceiver(record: ParsedFileRecord, expr: ts.Expression): boolean {
    const node = unwrapExpression(expr);
    if (ts.isIdentifier(node)) {
      return record.processAliases.has(node.text);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'process' &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'global' || node.expression.text === 'globalThis')
    ) {
      return true;
    }
    // Chained process.on('SIGTERM', h).on('SIGINT', h)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'on' ||
        node.expression.name.text === 'once' ||
        node.expression.name.text === 'addListener')
    ) {
      return isProcessReceiver(record, node.expression.expression);
    }
    return false;
  }

  // Pass 1B: Collect local servers, factories, exports, timeout mutations, and signal handlers
  // Note: To resolve cross-file server imports regardless of file order, we run server creation + exports first,
  // link cross-file server bindings, and then collect .listen() + property mutations + signal registrations.
  for (const record of fileRecords) {
    const sf = record.sourceFile;

    function scanServerCreations(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const direct = detectDirectServerCreation(record, node.initializer);
        if (direct !== null) {
          record.varToServer.set(node.name.text, direct);
          const parentStmt = node.parent?.parent;
          if (parentStmt && ts.isVariableStatement(parentStmt) && hasExportModifier(parentStmt)) {
            record.exportedServers.set(node.name.text, direct);
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const direct = detectDirectServerCreation(record, node.right);
        if (direct !== null) {
          record.varToServer.set(node.left.text, direct);
        }
      }
      ts.forEachChild(node, scanServerCreations);
    }

    scanServerCreations(sf);

    // Detect factory functions returning a tracked server variable or inline createServer()
    for (const [fnName, fnRec] of record.localFunctions.entries()) {
      const fnNode = fnRec.node;
      let returnedEntity: ServerEntity | null = null;
      if (fnNode.body) {
        if (!ts.isBlock(fnNode.body)) {
          returnedEntity = detectDirectServerCreation(record, fnNode.body);
          if (returnedEntity === null && ts.isIdentifier(fnNode.body)) {
            returnedEntity = record.varToServer.get(fnNode.body.text) ?? null;
          }
        } else {
          fnNode.body.forEachChild(function checkReturn(n): void {
            if (returnedEntity !== null) {
              return;
            }
            if (ts.isFunctionLike(n)) {
              return;
            }
            if (ts.isReturnStatement(n) && n.expression) {
              const unwrappedRet = unwrapExpression(n.expression);
              if (ts.isIdentifier(unwrappedRet)) {
                returnedEntity = record.varToServer.get(unwrappedRet.text) ?? null;
              } else {
                returnedEntity = detectDirectServerCreation(record, unwrappedRet);
              }
            } else {
              ts.forEachChild(n, checkReturn);
            }
          });
        }
      }
      if (returnedEntity !== null) {
        record.factoryReturnServers.set(fnName, returnedEntity);
        if (record.exportedFunctions.has(fnName)) {
          record.exportedFactories.set(fnName, returnedEntity);
          if (record.exportedFunctions.get('default')?.node === fnNode) {
            record.exportedFactories.set('default', returnedEntity);
          }
        }
      }
    }

    // Record named / default server exports: export { server }, export default server
    for (const stmt of sf.statements) {
      if (
        ts.isExportDeclaration(stmt) &&
        !stmt.moduleSpecifier &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const elem of stmt.exportClause.elements) {
          const localName = elem.propertyName ? elem.propertyName.text : elem.name.text;
          const exportedName = elem.name.text;
          const srv = record.varToServer.get(localName);
          if (srv) {
            record.exportedServers.set(exportedName, srv);
          }
          const fac = record.factoryReturnServers.get(localName);
          if (fac) {
            record.exportedFactories.set(exportedName, fac);
          }
        }
      } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const unwrapped = unwrapExpression(stmt.expression);
        if (ts.isIdentifier(unwrapped)) {
          const srv = record.varToServer.get(unwrapped.text);
          if (srv) {
            record.exportedServers.set('default', srv);
          }
        } else {
          const direct = detectDirectServerCreation(record, unwrapped);
          if (direct) {
            record.exportedServers.set('default', direct);
          }
        }
      }
    }
  }

  // Cross-file link step: link imported servers and factory calls across scanned files
  for (const record of fileRecords) {
    for (const [localName, binding] of record.imports.entries()) {
      const targetFile = resolveRelativeFile(record, binding.moduleSpecifier);
      if (!targetFile) {
        continue;
      }
      const importedServer = targetFile.exportedServers.get(binding.importedName);
      if (importedServer) {
        record.varToServer.set(localName, importedServer);
      }
    }

    // Bind variables initialized from local or imported factory calls: const app = createApp()
    function bindFactoryCalls(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (!record.varToServer.has(node.name.text)) {
          const init = unwrapExpression(node.initializer);
          if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
            const calleeName = init.expression.text;
            const localFac = record.factoryReturnServers.get(calleeName);
            if (localFac) {
              record.varToServer.set(node.name.text, localFac);
            } else {
              const imp = record.imports.get(calleeName);
              if (imp) {
                const targetFile = resolveRelativeFile(record, imp.moduleSpecifier);
                const extFac = targetFile?.exportedFactories.get(imp.importedName);
                if (extFac) {
                  record.varToServer.set(node.name.text, extFac);
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, bindFactoryCalls);
    }
    bindFactoryCalls(record.sourceFile);
  }

  // Pass 1C: Collect .listen(...) sites, const srv = app.listen(...), timeout assignments, and signal handlers
  const recordedListenNodes = new Set<ts.CallExpression>();

  function resolveServerReceiver(record: ParsedFileRecord, expr: ts.Expression): ServerEntity | null {
    const node = unwrapExpression(expr);
    if (ts.isIdentifier(node)) {
      return record.varToServer.get(node.text) ?? null;
    }
    // fastifyApp.server
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'server' &&
      ts.isIdentifier(node.expression)
    ) {
      return record.varToServer.get(node.expression.text) ?? null;
    }
    // Inline creation: http.createServer(...).listen(...) / express().listen(...) / fastify(...).listen(...)
    const inlineCreated = detectDirectServerCreation(record, node);
    if (inlineCreated !== null) {
      return inlineCreated;
    }
    return null;
  }

  for (const record of fileRecords) {
    const loopSignals = new Map<string, readonly string[]>();
    const exportedConstResolver = makeExportedConstResolver(record);

    function visit(node: ts.Node): void {
      // Track for (const sig of ['SIGTERM', 'SIGINT'])
      if (ts.isForOfStatement(node)) {
        let boundIdent: string | null = null;
        if (ts.isVariableDeclarationList(node.initializer)) {
          const firstDecl = node.initializer.declarations[0];
          if (firstDecl && ts.isIdentifier(firstDecl.name)) {
            boundIdent = firstDecl.name.text;
          }
        }
        if (boundIdent !== null) {
          const sigs = evaluateStringValues(node.expression, loopSignals, exportedConstResolver);
          if (sigs.length > 0) {
            const prev = loopSignals.get(boundIdent);
            loopSignals.set(boundIdent, sigs);
            visit(node.statement);
            if (prev !== undefined) {
              loopSignals.set(boundIdent, prev);
            } else {
              loopSignals.delete(boundIdent);
            }
            return;
          }
        }
      }

      // Track ['SIGTERM', 'SIGINT'].forEach((sig) => { ... })
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'forEach' &&
        node.arguments.length >= 1
      ) {
        const cb = unwrapExpression(node.arguments[0]!);
        if ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length >= 1) {
          const param = cb.parameters[0]!;
          if (ts.isIdentifier(param.name)) {
            const sigs = evaluateStringValues(
              node.expression.expression,
              loopSignals,
              exportedConstResolver
            );
            if (sigs.length > 0) {
              const paramName = param.name.text;
              const prev = loopSignals.get(paramName);
              loopSignals.set(paramName, sigs);
              visit(cb.body);
              if (prev !== undefined) {
                loopSignals.set(paramName, prev);
              } else {
                loopSignals.delete(paramName);
              }
              return;
            }
          }
        }
      }

      // Bind const server = app.listen(...) or const server = http.createServer(...).listen(...)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const unwrappedInit = unwrapExpression(node.initializer);
        const maybeCall = ts.isAwaitExpression(unwrappedInit)
          ? unwrapExpression(unwrappedInit.expression)
          : unwrappedInit;
        if (
          ts.isCallExpression(maybeCall) &&
          ts.isPropertyAccessExpression(maybeCall.expression) &&
          maybeCall.expression.name.text === 'listen'
        ) {
          const srv = resolveServerReceiver(record, maybeCall.expression.expression);
          if (srv !== null) {
            record.varToServer.set(node.name.text, srv);
            if (!recordedListenNodes.has(maybeCall)) {
              recordedListenNodes.add(maybeCall);
              srv.listenSites.push({ file: record, node: maybeCall });
            }
          }
        }
      }

      // Bind server = app.listen(...)
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const rhs = unwrapExpression(node.right);
        const maybeCall = ts.isAwaitExpression(rhs) ? unwrapExpression(rhs.expression) : rhs;
        if (
          ts.isCallExpression(maybeCall) &&
          ts.isPropertyAccessExpression(maybeCall.expression) &&
          maybeCall.expression.name.text === 'listen'
        ) {
          const srv = resolveServerReceiver(record, maybeCall.expression.expression);
          if (srv !== null) {
            record.varToServer.set(node.left.text, srv);
            if (!recordedListenNodes.has(maybeCall)) {
              recordedListenNodes.add(maybeCall);
              srv.listenSites.push({ file: record, node: maybeCall });
            }
          }
        }
      }

      // Standalone or awaited .listen(...)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'listen' &&
        !recordedListenNodes.has(node)
      ) {
        const srv = resolveServerReceiver(record, node.expression.expression);
        if (srv !== null) {
          recordedListenNodes.add(node);
          srv.listenSites.push({ file: record, node });
        }
      }

      // Object.assign(server, { keepAliveTimeout, headersTimeout })
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Object' &&
        node.expression.name.text === 'assign' &&
        node.arguments.length >= 2
      ) {
        const srv = resolveServerReceiver(record, node.arguments[0]!);
        if (srv !== null) {
          applyServerOptionsObject(record, srv, node.arguments[1]!);
        }
      }

      // server.keepAliveTimeout = ... / server.headersTimeout = ... / app.server.keepAliveTimeout = ...
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left)
      ) {
        const propName = node.left.name.text;
        if (propName === 'keepAliveTimeout' || propName === 'headersTimeout') {
          const srv = resolveServerReceiver(record, node.left.expression);
          if (srv !== null) {
            const setting = evalTimeoutExpr(record, node.right, node);
            if (propName === 'keepAliveTimeout') {
              srv.keepAliveTimeout = setting;
            } else {
              srv.headersTimeout = setting;
            }
          }
        }
      }

      // Signal handler registrations: process.on / process.once / process.addListener
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const methodName = node.expression.name.text;
        if (
          (methodName === 'on' || methodName === 'once' || methodName === 'addListener') &&
          node.arguments.length >= 2 &&
          isProcessReceiver(record, node.expression.expression)
        ) {
          const resolvedSignals = evaluateStringValues(
            node.arguments[0]!,
            loopSignals,
            exportedConstResolver
          );
          const shutdownSignals = resolvedSignals.filter(
            (s) => s === 'SIGTERM' || s === 'SIGINT'
          );
          if (shutdownSignals.length > 0) {
            record.signalRegistrations.push({
              file: record,
              callNode: node,
              signals: shutdownSignals,
              handlerArg: node.arguments[1]!,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(record.sourceFile);
  }

  // Helper resolution across local & relative-imported functions
  function resolveFunctionReference(
    fromFile: ParsedFileRecord,
    expr: ts.Expression,
    visitedFiles: Set<ParsedFileRecord> = new Set()
  ): FunctionRecord | null {
    const node = unwrapExpression(expr);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return { file: fromFile, node };
    }
    if (ts.isIdentifier(node)) {
      const local = fromFile.localFunctions.get(node.text);
      if (local) {
        return local;
      }
      if (visitedFiles.has(fromFile)) {
        return null;
      }
      const imp = fromFile.imports.get(node.text);
      if (imp) {
        const targetFile = resolveRelativeFile(fromFile, imp.moduleSpecifier);
        if (targetFile) {
          visitedFiles.add(fromFile);
          return targetFile.exportedFunctions.get(imp.importedName) ?? null;
        }
      }
    }
    return null;
  }

  function isProcessExitCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    const callee = unwrapExpression(node.expression);
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'exit' &&
      isProcessReceiver(file, callee.expression)
    );
  }

  function isProcessExitOrAbortCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    const callee = unwrapExpression(node.expression);
    return (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === 'exit' || callee.name.text === 'abort') &&
      isProcessReceiver(file, callee.expression)
    );
  }

  function isSetTimeoutCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    const callee = unwrapExpression(node.expression);
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'setTimeout') {
        return true;
      }
      const imp = file.imports.get(callee.text);
      return Boolean(imp && TIMERS_SPECIFIERS.has(imp.moduleSpecifier) && imp.importedName === 'setTimeout');
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'setTimeout') {
      const recv = unwrapExpression(callee.expression);
      if (ts.isIdentifier(recv)) {
        if (recv.text === 'global' || recv.text === 'globalThis') {
          return true;
        }
        const imp = file.imports.get(recv.text);
        return Boolean(imp && TIMERS_SPECIFIERS.has(imp.moduleSpecifier));
      }
    }
    return false;
  }

  function isDeferredTimerCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    if (isSetTimeoutCall(file, node)) {
      return true;
    }
    const callee = unwrapExpression(node.expression);
    if (ts.isIdentifier(callee)) {
      return callee.text === 'setInterval' || callee.text === 'setImmediate';
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === 'setInterval' || callee.name.text === 'setImmediate') &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === 'global' || callee.expression.text === 'globalThis')
    ) {
      return true;
    }
    return false;
  }

  function isCloseCall(node: ts.CallExpression): boolean {
    const callee = unwrapExpression(node.expression);
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'close';
  }

  function resolveConstInit(
    fromFile: ParsedFileRecord,
    identNode: ts.Identifier
  ): { readonly file: ParsedFileRecord; readonly expr: ts.Expression } | undefined {
    const localInit = findConstInitializerInScope(identNode.text, identNode);
    if (localInit !== undefined) {
      return { file: fromFile, expr: localInit };
    }
    const binding = fromFile.imports.get(identNode.text);
    if (!binding) {
      return undefined;
    }
    const targetFile = resolveRelativeFile(fromFile, binding.moduleSpecifier);
    if (!targetFile) {
      return undefined;
    }
    const exportedInit = targetFile.exportedConsts.get(binding.importedName);
    if (exportedInit === undefined) {
      return undefined;
    }
    return { file: targetFile, expr: exportedInit };
  }

  function isPromisifyCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    const callee = unwrapExpression(node.expression);
    if (ts.isIdentifier(callee)) {
      const imp = file.imports.get(callee.text);
      if (imp) {
        return UTIL_SPECIFIERS.has(imp.moduleSpecifier) && imp.importedName === 'promisify';
      }
      return callee.text === 'promisify';
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify') {
      const recv = unwrapExpression(callee.expression);
      if (ts.isIdentifier(recv)) {
        const imp = file.imports.get(recv.text);
        if (imp) {
          return (
            UTIL_SPECIFIERS.has(imp.moduleSpecifier) &&
            (imp.importedName === 'default' || imp.importedName === '*')
          );
        }
        return recv.text === 'util';
      }
      if (isInlineRequireOf(file, recv, (s) => UTIL_SPECIFIERS.has(s))) {
        return true;
      }
    }
    return false;
  }

  function isCloseMethodRef(
    file: ParsedFileRecord,
    expr: ts.Expression,
    visitedConsts: Set<string> = new Set()
  ): boolean {
    const node = unwrapExpression(expr);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'close') {
      return true;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
        return isCloseMethodRef(file, callee.expression, visitedConsts);
      }
    }
    if (ts.isIdentifier(node)) {
      const key = `${file.absolutePath}::${node.text}`;
      if (visitedConsts.has(key)) {
        return false;
      }
      const resolved = resolveConstInit(file, node);
      if (resolved !== undefined) {
        const nextVisited = new Set(visitedConsts);
        nextVisited.add(key);
        return isCloseMethodRef(resolved.file, resolved.expr, nextVisited);
      }
    }
    return false;
  }

  function isBoundCloseFn(
    file: ParsedFileRecord,
    expr: ts.Expression,
    visitedConsts: Set<string> = new Set()
  ): boolean {
    const node = unwrapExpression(expr);
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
        return isCloseMethodRef(file, callee.expression, visitedConsts);
      }
    }
    if (ts.isIdentifier(node)) {
      const key = `${file.absolutePath}::${node.text}`;
      if (visitedConsts.has(key)) {
        return false;
      }
      const resolved = resolveConstInit(file, node);
      if (resolved !== undefined) {
        const nextVisited = new Set(visitedConsts);
        nextVisited.add(key);
        return isBoundCloseFn(resolved.file, resolved.expr, nextVisited);
      }
    }
    return false;
  }

  function isPromisifiedCloseFn(
    file: ParsedFileRecord,
    expr: ts.Expression,
    visitedConsts: Set<string> = new Set()
  ): boolean {
    const node = unwrapExpression(expr);
    if (ts.isCallExpression(node)) {
      if (isPromisifyCall(file, node) && node.arguments.length >= 1) {
        return isCloseMethodRef(file, node.arguments[0]!, visitedConsts);
      }
      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
        return isPromisifiedCloseFn(file, callee.expression, visitedConsts);
      }
    }
    if (ts.isIdentifier(node)) {
      const key = `${file.absolutePath}::${node.text}`;
      if (visitedConsts.has(key)) {
        return false;
      }
      const resolved = resolveConstInit(file, node);
      if (resolved !== undefined) {
        const nextVisited = new Set(visitedConsts);
        nextVisited.add(key);
        return isPromisifiedCloseFn(resolved.file, resolved.expr, nextVisited);
      }
    }
    return false;
  }

  function isBoundCloseCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    return isBoundCloseFn(file, node.expression);
  }

  function isPromisifiedCloseCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    return isPromisifiedCloseFn(file, node.expression);
  }

  function isRecognizedCloseCall(file: ParsedFileRecord, node: ts.CallExpression): boolean {
    return (
      isCloseCall(node) ||
      isBoundCloseCall(file, node) ||
      isPromisifiedCloseCall(file, node)
    );
  }

  function expressionContainsClose(
    file: ParsedFileRecord,
    expr: ts.Expression,
    visitedFns: Set<FunctionLikeTarget> = new Set(),
    visitedIdents: Set<string> = new Set()
  ): boolean {
    let found = false;

    function scan(n: ts.Node): void {
      if (found) {
        return;
      }
      if (ts.isCallExpression(n)) {
        if (isRecognizedCloseCall(file, n)) {
          found = true;
          return;
        }
        const targetFn = resolveFunctionReference(file, n.expression);
        if (targetFn && !visitedFns.has(targetFn.node)) {
          visitedFns.add(targetFn.node);
          if (functionContainsClose(targetFn, visitedFns)) {
            found = true;
            return;
          }
        }
      } else if (ts.isIdentifier(n)) {
        const identKey = `${file.absolutePath}::${n.text}`;
        if (!visitedIdents.has(identKey)) {
          const resolved = resolveConstInit(file, n);
          if (resolved !== undefined) {
            visitedIdents.add(identKey);
            if (expressionContainsClose(resolved.file, resolved.expr, visitedFns, visitedIdents)) {
              found = true;
              return;
            }
          }
        }
      }
      ts.forEachChild(n, scan);
    }

    scan(expr);
    return found;
  }

  function functionContainsClose(
    fnRec: FunctionRecord,
    visitedFns: Set<FunctionLikeTarget> = new Set()
  ): boolean {
    if (!fnRec.node.body) {
      return false;
    }
    let found = false;

    function scan(n: ts.Node): void {
      if (found) {
        return;
      }
      if (n !== fnRec.node.body && ts.isFunctionLike(n)) {
        // Inspect nested callbacks passed into new Promise(...) or .close(...), skip standalone declarations
        if (ts.isFunctionDeclaration(n)) {
          return;
        }
      }
      if (ts.isCallExpression(n)) {
        if (isRecognizedCloseCall(fnRec.file, n)) {
          found = true;
          return;
        }
        const helper = resolveFunctionReference(fnRec.file, n.expression);
        if (helper && !visitedFns.has(helper.node)) {
          visitedFns.add(helper.node);
          if (functionContainsClose(helper, visitedFns)) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(n, scan);
    }

    scan(fnRec.node.body);
    return found;
  }

  function functionCallsExitOrAbort(
    fnRec: FunctionRecord,
    visitedFns: Set<FunctionLikeTarget> = new Set()
  ): boolean {
    if (!fnRec.node.body) {
      return false;
    }
    let found = false;

    function scan(n: ts.Node): void {
      if (found) {
        return;
      }
      if (ts.isFunctionDeclaration(n)) {
        return;
      }
      if (ts.isCallExpression(n)) {
        if (isProcessExitOrAbortCall(fnRec.file, n)) {
          found = true;
          return;
        }
        const helper = resolveFunctionReference(fnRec.file, n.expression);
        if (helper && !visitedFns.has(helper.node)) {
          visitedFns.add(helper.node);
          if (functionCallsExitOrAbort(helper, visitedFns)) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(n, scan);
    }

    scan(fnRec.node.body);
    return found;
  }

  // Pass 2: Evaluate exact 5 v1 rules (SDG001 - SDG005)
  const rawFindings: Finding[] = [];

  const allSignalRegistrations: SignalRegistration[] = [];
  for (const record of fileRecords) {
    allSignalRegistrations.push(...record.signalRegistrations);
  }

  const listeningServers = allServers.filter((s) => s.listenSites.length > 0);

  // Rule SDG001: .listen() server with NO SIGTERM/SIGINT handler anywhere in scanned project
  if (allSignalRegistrations.length === 0) {
    for (const srv of listeningServers) {
      for (const site of srv.listenSites) {
        rawFindings.push(
          nodeToFinding(
            'SDG001',
            'medium',
            `HTTP/${srv.framework} server calls .listen() with no SIGTERM or SIGINT handler anywhere in the scanned project.`,
            site.file,
            site.node
          )
        );
      }
    }
  }

  // Rule SDG002: headersTimeout <= keepAliveTimeout when both resolve to static numbers on the same server
  for (const srv of allServers) {
    if (
      srv.keepAliveTimeout.state === 'numeric' &&
      srv.headersTimeout.state === 'numeric' &&
      srv.headersTimeout.value <= srv.keepAliveTimeout.value
    ) {
      rawFindings.push(
        nodeToFinding(
          'SDG002',
          'high',
          `Server headersTimeout (${srv.headersTimeout.value}ms) must be strictly greater than keepAliveTimeout (${srv.keepAliveTimeout.value}ms) to prevent keep-alive header race disconnects.`,
          srv.headersTimeout.file,
          srv.headersTimeout.node
        )
      );
    }
  }

  // Rule SDG003: keepAliveTimeout unset (Node 5000ms vs Fastify 72000ms default) or <= lbIdleTimeout * 1000
  const lbIdleSec = options.lbIdleTimeoutSec;
  for (const srv of listeningServers) {
    const defaultKeepAliveMs = srv.framework === 'fastify' ? 72_000 : 5_000;
    if (lbIdleSec === undefined) {
      if (srv.keepAliveTimeout.state === 'unset' && srv.framework !== 'fastify') {
        const primarySite = srv.listenSites[0]!;
        rawFindings.push(
          nodeToFinding(
            'SDG003',
            'info',
            `Server calls .listen() without explicitly configuring keepAliveTimeout (defaults to 5000ms in Node.js).`,
            primarySite.file,
            primarySite.node
          )
        );
      }
    } else {
      const lbIdleMs = lbIdleSec * 1000;
      if (srv.keepAliveTimeout.state === 'unset') {
        if (defaultKeepAliveMs <= lbIdleMs) {
          const primarySite = srv.listenSites[0]!;
          const defaultDesc =
            srv.framework === 'fastify' ? '72000ms Fastify default' : '5000ms default';
          rawFindings.push(
            nodeToFinding(
              'SDG003',
              'medium',
              `Server keepAliveTimeout is unset (${defaultDesc}), which is <= load balancer idle timeout (${lbIdleMs}ms / ${lbIdleSec}s).`,
              primarySite.file,
              primarySite.node
            )
          );
        }
      } else if (
        srv.keepAliveTimeout.state === 'numeric' &&
        srv.keepAliveTimeout.value <= lbIdleMs
      ) {
        rawFindings.push(
          nodeToFinding(
            'SDG003',
            'medium',
            `Server keepAliveTimeout (${srv.keepAliveTimeout.value}ms) must exceed load balancer idle timeout (${lbIdleMs}ms / ${lbIdleSec}s).`,
            srv.keepAliveTimeout.file,
            srv.keepAliveTimeout.node
          )
        );
      }
    }
  }

  // Rules SDG004 & SDG005 on every SIGTERM/SIGINT handler
  interface FlowState {
    hasCompletedClose: boolean;
    sawAwaitClose: boolean;
  }

  function evaluateSdg004OnFunction(
    fnRec: FunctionRecord,
    initialState: FlowState,
    visitedFns: Set<FunctionLikeTarget>
  ): void {
    const body = fnRec.node.body;
    if (!body) {
      return;
    }
    const file = fnRec.file;

    function walkExpr(expr: ts.Node, state: FlowState): void {
      if (ts.isFunctionDeclaration(expr)) {
        return;
      }
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        // Standalone uninvoked callback expression does not run synchronously here
        return;
      }

      if (ts.isAwaitExpression(expr)) {
        walkExpr(expr.expression, state);
        if (expressionContainsClose(file, expr.expression)) {
          state.hasCompletedClose = true;
          state.sawAwaitClose = true;
        }
        return;
      }

      if (ts.isCallExpression(expr)) {
        // 1. Timer registration: setTimeout(() => process.exit(1), 10000)
        if (isDeferredTimerCall(file, expr)) {
          // Do not treat callback argument as synchronous execution; only inspect non-callback args
          for (let i = 1; i < expr.arguments.length; i += 1) {
            walkExpr(expr.arguments[i]!, state);
          }
          return;
        }

        // 2. .close(callback): callback executes AFTER close completes
        if (isCloseCall(expr) || isBoundCloseCall(file, expr)) {
          walkExpr(expr.expression, state);
          for (const arg of expr.arguments) {
            const cbTarget = resolveFunctionReference(file, arg);
            if (cbTarget !== null) {
              if (!visitedFns.has(cbTarget.node)) {
                const nextVisited = new Set(visitedFns);
                nextVisited.add(cbTarget.node);
                evaluateSdg004OnFunction(
                  cbTarget,
                  { hasCompletedClose: true, sawAwaitClose: state.sawAwaitClose },
                  nextVisited
                );
              }
            } else {
              walkExpr(arg, state);
            }
          }
          return;
        }

        // 3. <closePromise>.then(cb) / .catch(cb) / .finally(cb)
        const callee = unwrapExpression(expr.expression);
        if (
          ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === 'then' ||
            callee.name.text === 'catch' ||
            callee.name.text === 'finally') &&
          expressionContainsClose(file, callee.expression)
        ) {
          walkExpr(callee.expression, state);
          for (const arg of expr.arguments) {
            const cbTarget = resolveFunctionReference(file, arg);
            if (cbTarget !== null) {
              if (!visitedFns.has(cbTarget.node)) {
                const nextVisited = new Set(visitedFns);
                nextVisited.add(cbTarget.node);
                evaluateSdg004OnFunction(
                  cbTarget,
                  { hasCompletedClose: true, sawAwaitClose: state.sawAwaitClose },
                  nextVisited
                );
              }
            } else {
              walkExpr(arg, state);
            }
          }
          return;
        }

        // 4. Synchronous process.exit(...) check
        if (isProcessExitCall(file, expr)) {
          for (const arg of expr.arguments) {
            walkExpr(arg, state);
          }
          if (!state.hasCompletedClose) {
            rawFindings.push(
              nodeToFinding(
                'SDG004',
                'medium',
                'Signal handler calls process.exit() synchronously before any awaited or callback .close() completes.',
                file,
                expr
              )
            );
          }
          return;
        }

        // 5. new Promise((resolve) => server.close(resolve)) or helper call
        walkExpr(expr.expression, state);
        for (const arg of expr.arguments) {
          walkExpr(arg, state);
        }

        const helperFn = resolveFunctionReference(file, expr.expression);
        if (helperFn !== null && !visitedFns.has(helperFn.node)) {
          const nextVisited = new Set(visitedFns);
          nextVisited.add(helperFn.node);
          const innerState: FlowState = {
            hasCompletedClose: state.hasCompletedClose,
            sawAwaitClose: false,
          };
          evaluateSdg004OnFunction(helperFn, innerState, nextVisited);
        }
        return;
      }

      if (ts.isNewExpression(expr)) {
        // Walk executor callback of new Promise((resolve) => { ... }) synchronously
        if (ts.isIdentifier(expr.expression) && expr.expression.text === 'Promise' && expr.arguments?.[0]) {
          const execTarget = resolveFunctionReference(file, expr.arguments[0]);
          if (execTarget && !visitedFns.has(execTarget.node)) {
            const nextVisited = new Set(visitedFns);
            nextVisited.add(execTarget.node);
            evaluateSdg004OnFunction(execTarget, state, nextVisited);
            return;
          }
        }
      }

      ts.forEachChild(expr, (child) => walkExpr(child, state));
    }

    function walkStmt(stmt: ts.Statement, state: FlowState): void {
      if (ts.isFunctionDeclaration(stmt)) {
        return;
      }
      if (ts.isBlock(stmt)) {
        for (const child of stmt.statements) {
          walkStmt(child, state);
        }
        return;
      }
      if (ts.isIfStatement(stmt)) {
        walkExpr(stmt.expression, state);
        const thenState: FlowState = { ...state };
        walkStmt(stmt.thenStatement, thenState);
        if (stmt.elseStatement) {
          const elseState: FlowState = { ...state };
          walkStmt(stmt.elseStatement, elseState);
          state.hasCompletedClose =
            state.hasCompletedClose ||
            (thenState.hasCompletedClose && elseState.hasCompletedClose);
          state.sawAwaitClose =
            state.sawAwaitClose || thenState.sawAwaitClose || elseState.sawAwaitClose;
        }
        return;
      }
      if (ts.isTryStatement(stmt)) {
        const tryState: FlowState = {
          hasCompletedClose: state.hasCompletedClose,
          sawAwaitClose: false,
        };
        walkStmt(stmt.tryBlock, tryState);

        if (stmt.catchClause) {
          const catchState: FlowState = {
            hasCompletedClose: state.hasCompletedClose || tryState.sawAwaitClose,
            sawAwaitClose: tryState.sawAwaitClose,
          };
          walkStmt(stmt.catchClause.block, catchState);
        }

        if (stmt.finallyBlock) {
          const finallyState: FlowState = {
            hasCompletedClose: tryState.hasCompletedClose || tryState.sawAwaitClose,
            sawAwaitClose: tryState.sawAwaitClose,
          };
          walkStmt(stmt.finallyBlock, finallyState);
          state.hasCompletedClose =
            tryState.hasCompletedClose || finallyState.hasCompletedClose;
          state.sawAwaitClose = state.sawAwaitClose || finallyState.sawAwaitClose;
        } else {
          state.hasCompletedClose = tryState.hasCompletedClose;
          state.sawAwaitClose = state.sawAwaitClose || tryState.sawAwaitClose;
        }
        return;
      }

      ts.forEachChild(stmt, (child) => {
        if (ts.isStatement(child)) {
          walkStmt(child, state);
        } else {
          walkExpr(child, state);
        }
      });
    }

    if (ts.isBlock(body)) {
      walkStmt(body, initialState);
    } else {
      walkExpr(body, initialState);
    }
  }

  function evaluateSdg005OnHandler(rootFn: FunctionRecord): void {
    const visitedFns = new Set<FunctionLikeTarget>([rootFn.node]);
    const queue: FunctionRecord[] = [rootFn];
    let firstCloseSite: { file: ParsedFileRecord; node: ts.CallExpression } | null = null;
    let hasFallbackTimer = false;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const body = current.node.body;
      if (!body) {
        continue;
      }

      function inspectNode(n: ts.Node): void {
        if (n !== body && ts.isFunctionDeclaration(n)) {
          return;
        }
        if (ts.isCallExpression(n)) {
          if (isRecognizedCloseCall(current.file, n) && firstCloseSite === null) {
            firstCloseSite = { file: current.file, node: n };
          }
          if (isSetTimeoutCall(current.file, n) && n.arguments.length >= 1) {
            const timerCb = resolveFunctionReference(current.file, n.arguments[0]!);
            if (timerCb !== null && functionCallsExitOrAbort(timerCb, new Set([timerCb.node]))) {
              hasFallbackTimer = true;
            }
          }
          const calledHelper = resolveFunctionReference(current.file, n.expression);
          if (calledHelper !== null && !visitedFns.has(calledHelper.node)) {
            visitedFns.add(calledHelper.node);
            queue.push(calledHelper);
          }
        }
        ts.forEachChild(n, inspectNode);
      }

      inspectNode(body);
    }

    if (firstCloseSite !== null && !hasFallbackTimer) {
      const closeTarget: { file: ParsedFileRecord; node: ts.CallExpression } = firstCloseSite;
      rawFindings.push(
        nodeToFinding(
          'SDG005',
          'low',
          'Signal handler calls .close() without a forced-exit fallback setTimeout calling process.exit() or process.abort().',
          closeTarget.file,
          closeTarget.node
        )
      );
    }
  }

  for (const reg of allSignalRegistrations) {
    const resolvedRoot = resolveFunctionReference(reg.file, reg.handlerArg);
    if (resolvedRoot === null) {
      continue;
    }

    evaluateSdg004OnFunction(
      resolvedRoot,
      { hasCompletedClose: false, sawAwaitClose: false },
      new Set([resolvedRoot.node])
    );

    evaluateSdg005OnHandler(resolvedRoot);
  }

  // Deduplicate findings at identical (ruleId, file, line, column) and sort deterministically
  const seenKeys = new Set<string>();
  const uniqueFindings: Finding[] = [];
  for (const f of rawFindings) {
    const key = `${f.ruleId}|${f.file}|${f.line}|${f.column}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueFindings.push(f);
    }
  }

  uniqueFindings.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    if (a.column !== b.column) {
      return a.column - b.column;
    }
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });

  return uniqueFindings;
}
