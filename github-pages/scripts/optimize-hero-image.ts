const sourcePath = "github-pages/site/assets/img/knowledge-distillation-hero.png";
const webpPath = "github-pages/site/assets/img/knowledge-distillation-hero.webp";
const ogJpegPath = "github-pages/site/assets/img/og-image.jpg";

const source = Bun.file(sourcePath);
if (!(await source.exists())) {
  throw new Error(`Source image not found: ${sourcePath}`);
}

const sourceSize = source.size;
const pipeline = source.image();
const meta = await pipeline.metadata();

await source.image().webp({ quality: 90 }).write(webpPath);
await source.image().jpeg({ quality: 85, progressive: true }).write(ogJpegPath);

const webp = Bun.file(webpPath);
const webpSize = webp.size;
const webpReduced = sourceSize - webpSize;
const webpRatio = ((webpSize / sourceSize) * 100).toFixed(1);

const ogJpeg = Bun.file(ogJpegPath);
const ogJpegSize = ogJpeg.size;
const ogReduced = sourceSize - ogJpegSize;
const ogRatio = ((ogJpegSize / sourceSize) * 100).toFixed(1);

console.log(
  [
    `source: ${sourcePath}`,
    `webp:   ${webpPath}`,
    `ogjpg:  ${ogJpegPath}`,
    `dimensions: ${meta.width}x${meta.height}`,
    `source bytes: ${sourceSize}`,
    `webp bytes:   ${webpSize}`,
    `webp saved:   ${webpReduced}`,
    `webp ratio:   ${webpRatio}%`,
    `og jpg bytes: ${ogJpegSize}`,
    `og jpg saved: ${ogReduced}`,
    `og jpg ratio: ${ogRatio}%`,
  ].join("\n"),
);
