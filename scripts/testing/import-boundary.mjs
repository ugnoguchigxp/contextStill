import path from "node:path";
import ts from "typescript";

export function inspectBoundary(root) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  if (!configPath) throw new Error("tsconfig not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const edges = [];
  for (const file of program.getSourceFiles()) {
    const from = path.relative(root, file.fileName).split(path.sep).join("/");
    if (!/^(src|api|web)\//.test(from) || file.isDeclarationFile) continue;
    function add(specifier, typeOnly) {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const resolved = ts.resolveModuleName(
        specifier.text,
        file.fileName,
        parsed.options,
        ts.sys,
      ).resolvedModule;
      if (!resolved) return;
      const to = path.relative(root, resolved.resolvedFileName).split(path.sep).join("/");
      if (/^(src|api|web)\//.test(to)) edges.push({ from, to, typeOnly });
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const onlyNamedTypes =
          !clause?.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((e) => e.isTypeOnly);
        add(node.moduleSpecifier, Boolean(clause?.isTypeOnly || onlyNamedTypes));
      } else if (ts.isExportDeclaration(node)) {
        const named = node.exportClause;
        add(
          node.moduleSpecifier,
          Boolean(
            node.isTypeOnly ||
              (named &&
                ts.isNamedExports(named) &&
                named.elements.length > 0 &&
                named.elements.every((e) => e.isTypeOnly)),
          ),
        );
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        add(node.arguments[0], false);
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  const adjacency = new Map();
  for (const edge of edges.filter((e) => !e.typeOnly)) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from).add(edge.to);
  }
  // A cycle edge is stable even when another cycle is added inside the same component.
  const reaches = (start, target) => {
    const seen = new Set();
    const pending = [start];
    while (pending.length) {
      const current = pending.pop();
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    return false;
  };
  const cycles = [
    ...new Set(
      edges.filter((e) => !e.typeOnly && reaches(e.to, e.from)).map((e) => `${e.from} -> ${e.to}`),
    ),
  ].sort();
  return {
    edges,
    cycles,
    violations: edges.filter((e) => e.from.startsWith("src/") && e.to.startsWith("api/")),
  };
}
