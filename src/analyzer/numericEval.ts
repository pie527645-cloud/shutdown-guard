import ts from 'typescript';

export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function isScopeContainer(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node)
  );
}

function getStatementsOfScope(node: ts.Node): readonly ts.Statement[] {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }
  if (ts.isCaseBlock(node)) {
    const stmts: ts.Statement[] = [];
    for (const clause of node.clauses) {
      stmts.push(...clause.statements);
    }
    return stmts;
  }
  return [];
}

export function findConstInitializerInScope(
  name: string,
  contextNode: ts.Node,
  exportedResolver?: (identName: string) => ts.Expression | undefined
): ts.Expression | undefined {
  let current: ts.Node | undefined = contextNode;
  while (current !== undefined) {
    if (isScopeContainer(current)) {
      for (const stmt of getStatementsOfScope(current)) {
        if (!ts.isVariableStatement(stmt)) {
          continue;
        }
        const declList = stmt.declarationList;
        if ((declList.flags & ts.NodeFlags.Const) === 0) {
          continue;
        }
        for (const decl of declList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer !== undefined) {
            return decl.initializer;
          }
        }
      }
    }
    current = current.parent;
  }
  return exportedResolver?.(name);
}

function readObjectPropertyInitializer(
  obj: ts.ObjectLiteralExpression,
  propName: string,
  contextNode: ts.Node,
  exportedResolver?: (identName: string) => ts.Expression | undefined
): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = getStaticPropertyName(prop.name);
      if (key === propName) {
        return prop.initializer;
      }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === propName) {
        return findConstInitializerInScope(propName, contextNode, exportedResolver);
      }
    }
  }
  return undefined;
}

export function getStaticPropertyName(nameNode: ts.PropertyName): string | null {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  if (ts.isNoSubstitutionTemplateLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

export function evaluateNumericExpression(
  expr: ts.Expression,
  exportedResolver?: (identName: string) => ts.Expression | undefined,
  visited: Set<ts.Node> = new Set()
): number | null {
  const node = unwrapExpression(expr);
  if (visited.has(node)) {
    return null;
  }
  visited.add(node);

  if (ts.isNumericLiteral(node)) {
    const cleaned = node.text.replaceAll('_', '');
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluateNumericExpression(node.operand, exportedResolver, visited);
    if (operand === null) {
      return null;
    }
    if (node.operator === ts.SyntaxKind.PlusToken) {
      return operand;
    }
    if (node.operator === ts.SyntaxKind.MinusToken) {
      return -operand;
    }
    return null;
  }

  if (ts.isBinaryExpression(node)) {
    const left = evaluateNumericExpression(node.left, exportedResolver, visited);
    const right = evaluateNumericExpression(node.right, exportedResolver, visited);
    if (left === null || right === null) {
      return null;
    }
    let result: number;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        result = left + right;
        break;
      case ts.SyntaxKind.MinusToken:
        result = left - right;
        break;
      case ts.SyntaxKind.AsteriskToken:
        result = left * right;
        break;
      case ts.SyntaxKind.SlashToken:
        if (right === 0) {
          return null;
        }
        result = left / right;
        break;
      case ts.SyntaxKind.PercentToken:
        if (right === 0) {
          return null;
        }
        result = left % right;
        break;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        result = left ** right;
        break;
      default:
        return null;
    }
    return Number.isFinite(result) ? result : null;
  }

  if (ts.isIdentifier(node)) {
    const init = findConstInitializerInScope(node.text, node, exportedResolver);
    if (init === undefined) {
      return null;
    }
    return evaluateNumericExpression(init, exportedResolver, visited);
  }

  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const objInit = findConstInitializerInScope(node.expression.text, node, exportedResolver);
    if (objInit !== undefined) {
      const unwrappedObj = unwrapExpression(objInit);
      if (ts.isObjectLiteralExpression(unwrappedObj)) {
        const propInit = readObjectPropertyInitializer(
          unwrappedObj,
          node.name.text,
          unwrappedObj,
          exportedResolver
        );
        if (propInit !== undefined) {
          return evaluateNumericExpression(propInit, exportedResolver, visited);
        }
      }
    }
  }

  return null;
}

export function evaluateStringValues(
  expr: ts.Expression,
  loopSignals: ReadonlyMap<string, readonly string[]>,
  exportedResolver?: (identName: string) => ts.Expression | undefined,
  visited: Set<ts.Node> = new Set()
): readonly string[] {
  const node = unwrapExpression(expr);
  if (visited.has(node)) {
    return [];
  }
  visited.add(node);

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }

  if (ts.isArrayLiteralExpression(node)) {
    const values: string[] = [];
    for (const elem of node.elements) {
      if (ts.isSpreadElement(elem)) {
        values.push(...evaluateStringValues(elem.expression, loopSignals, exportedResolver, new Set(visited)));
      } else {
        values.push(...evaluateStringValues(elem, loopSignals, exportedResolver, new Set(visited)));
      }
    }
    return values;
  }

  if (ts.isIdentifier(node)) {
    const fromLoop = loopSignals.get(node.text);
    if (fromLoop !== undefined) {
      return fromLoop;
    }
    const init = findConstInitializerInScope(node.text, node, exportedResolver);
    if (init !== undefined) {
      return evaluateStringValues(init, loopSignals, exportedResolver, visited);
    }
  }

  return [];
}
