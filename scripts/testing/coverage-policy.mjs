import path from "node:path";
export function lcovLines(text) {
  const files = new Map();
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = line.slice(3);
      if (!files.has(current)) files.set(current, new Map());
    }
    if (line.startsWith("DA:") && current) {
      const [number, count] = line.slice(3).split(",").map(Number);
      const lines = files.get(current);
      lines.set(number, Math.max(lines.get(number) ?? 0, count));
    }
  }
  return files;
}
export function summarizeLines(files, root = process.cwd()) {
  const result = {};
  for (const [name, lines] of files) {
    const relative = path.isAbsolute(name) ? path.relative(root, name) : name;
    const area = relative.replaceAll("\\", "/").split("/")[0];
    if (!["src", "api", "web", "crates"].includes(area)) continue;
    result[area] ??= { covered: 0, total: 0 };
    result[area].total += lines.size;
    result[area].covered += [...lines.values()].filter((n) => n > 0).length;
  }
  for (const area of Object.values(result))
    area.percent = area.total ? (100 * area.covered) / area.total : 0;
  return result;
}
export function checkCoverage(actual, baseline) {
  const failures = [];
  for (const [surface, areas] of Object.entries(baseline))
    for (const [area, minimum] of Object.entries(areas)) {
      const measured = actual[surface]?.[area];
      if (!measured?.total || !Number.isFinite(measured.percent))
        failures.push(`${surface}/${area}: report missing or empty`);
      else if (measured.percent < minimum)
        failures.push(`${surface}/${area}: ${measured.percent.toFixed(2)} < ${minimum}`);
    }
  return failures;
}

export function changedLines(diff) {
  const files = new Map();
  let current;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = line.slice(6);
      files.set(current, new Set());
    } else if (line === "+++ /dev/null") current = undefined;
    else if (current && line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let offset = 0; offset < count; offset++) files.get(current).add(start + offset);
    }
  }
  return files;
}

export function summarizeChangedLines(files, changes, root = process.cwd()) {
  const selected = new Map();
  for (const [name, lines] of files) {
    const relative = (path.isAbsolute(name) ? path.relative(root, name) : name).replaceAll(
      "\\",
      "/",
    );
    const changed = changes.get(relative);
    if (changed) selected.set(name, new Map([...lines].filter(([line]) => changed.has(line))));
  }
  return summarizeLines(selected, root);
}
