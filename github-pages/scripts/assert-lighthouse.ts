const reportPath = process.argv[2] ?? "github-pages/reports/lighthouse.json";
const minPerf = Number(process.argv[3] ?? 90);
const minSeo = Number(process.argv[4] ?? 100);

const report = JSON.parse(await Bun.file(reportPath).text());
const performance = Math.round((report.categories?.performance?.score ?? 0) * 100);
const seo = Math.round((report.categories?.seo?.score ?? 0) * 100);

const failures: string[] = [];
if (performance < minPerf) {
  failures.push(`Performance score ${performance} is below minimum ${minPerf}.`);
}
if (seo < minSeo) {
  failures.push(`SEO score ${seo} is below minimum ${minSeo}.`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Lighthouse gate passed: performance=${performance}, seo=${seo}`);
