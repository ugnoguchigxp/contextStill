# GitHub Pages LP

このディレクトリは `contextStill` の LP 用 Jekyll サイトです。

## Stack

- GitHub Pages
- Jekyll
- `site/index.md`（LP本文）
- `_config.yml`
- `jekyll-seo-tag`
- `jekyll-sitemap`
- `robots.txt`

## Structure

```txt
github-pages/
├─ _config.yml
├─ _config.local.yml
├─ Gemfile
├─ site/   # Jekyll source
│  ├─ _layouts/default.html
│  ├─ assets/
│  │  ├─ css/lp.css
│  │  └─ img/
│  ├─ index.md
│  └─ robots.txt
├─ docs/      # jekyll build 出力先（Pages artifact）
└─ .preview/  # local preview 用出力（gitignore）
```

## Build

```bash
cd github-pages
bundle install
bundle exec jekyll build
```

`_config.yml` で `source: site` / `destination: docs` を指定しているため、成果物は `github-pages/docs/` に出力されます。

ローカル Ruby 環境に依存させたくない場合は Docker ビルドを使えます。

```bash
cd github-pages
./build-dist.sh
```

`build-dist.sh` は `jekyll/jekyll` コンテナで `bundle install` と `jekyll build` を実行します。

## Image Optimization

ヒーロー画像は Bun の `Bun.Image` API で WebP/JPEG を生成できます。

```bash
cd /path/to/repo
bun run github-pages/scripts/optimize-hero-image.ts
```

- `knowledge-distillation-hero.webp`（LP表示用）
- `og-image.jpg`（OG/Twitter用）

## Local Preview

`_config.yml` はカスタムドメイン `https://contextstill.com/` 向けに `baseurl: ""` を使います。
ローカル確認では `_config.local.yml` を重ね、URL だけを `http://localhost:4000` に切り替えます。

ローカル確認は以下のどちらかを使ってください。

1. Jekyll serve（推奨）

```bash
cd github-pages
bundle exec jekyll serve --config _config.yml,_config.local.yml
```

2. 静的出力を `npx serve` で確認

```bash
cd github-pages
./build-preview.sh
npx serve .preview
```

## SEO Audit

Lighthouse をローカルで実行して、主要カテゴリと CWV を確認できます。

```bash
cd /path/to/repo
github-pages/scripts/run-lighthouse.sh
```

レポートは `github-pages/reports/lighthouse.json` に出力されます。

GitHub Actions でも定期実行します:

- `.github/workflows/seo-audit.yml`
- しきい値: `Performance >= 90`, `SEO >= 100`

## Deploy

このリポジトリには `github-pages/docs` を Pages Artifact として配信する
`/.github/workflows/pages.yml` を追加しています。

1. GitHub の `Settings > Pages` で Source を `GitHub Actions` に変更
2. `main` に push すると workflow が走り、`github-pages/docs` がデプロイされる

## Search Console Ops (Manual)

クロール・インデックス運用は Search Console 側で以下を実施します。

1. プロパティ追加: `https://contextstill.com/`
2. Sitemap 送信: `https://contextstill.com/sitemap.xml`
3. URL 検査: `https://contextstill.com/` を検査してインデックス登録をリクエスト
4. カバレッジ/ページ状況の確認（数日〜数週間で反映）

Search Console / Bing の所有権確認が必要な場合は `github-pages/_config.yml` に以下を設定します。

```yml
google_verification_token: "..."
bing_verification_token: "..."
```

運用チェックリストは `github-pages/SEO_CHECKLIST.md` を参照してください。
