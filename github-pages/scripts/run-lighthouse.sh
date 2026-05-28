#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="$ROOT_DIR/reports"
PORT="${PORT:-4499}"

mkdir -p "$REPORT_DIR"

"$ROOT_DIR/build-preview.sh" >/dev/null

cd "$ROOT_DIR/.preview"
npx serve . -l "$PORT" >/tmp/memoryrouter-lp-serve.log 2>&1 &
SERVE_PID=$!

cleanup() {
  kill "$SERVE_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sleep 2

npx --yes lighthouse "http://127.0.0.1:${PORT}/" \
  --quiet \
  --chrome-flags="--headless=new --no-sandbox" \
  --only-categories=performance,accessibility,best-practices,seo \
  --output=json \
  --output-path="$REPORT_DIR/lighthouse.json"

cd "$ROOT_DIR"
bun -e '
const report = JSON.parse(await Bun.file("'"$REPORT_DIR"'/lighthouse.json").text());
const score = (name) => Math.round((report.categories[name]?.score ?? 0) * 100);
const audits = report.audits ?? {};
const metric = (id) => audits[id]?.displayValue ?? "n/a";
console.log([
  `Lighthouse summary (${report.finalUrl})`,
  `Performance: ${score("performance")}`,
  `Accessibility: ${score("accessibility")}`,
  `Best Practices: ${score("best-practices")}`,
  `SEO: ${score("seo")}`,
  `LCP: ${metric("largest-contentful-paint")}`,
  `CLS: ${metric("cumulative-layout-shift")}`,
  `INP: ${metric("interaction-to-next-paint")}`,
].join("\n"));
'
