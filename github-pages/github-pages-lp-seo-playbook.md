# GitHubリポジトリ向け GitHub Pages LP / SEO 運用ベストプラクティス

> 対象ケース: GitHub上に多数のリポジトリがあるが、Google検索でリポジトリやプロダクトが拾われにくい。各リポジトリに GitHub Pages の静的LPを用意し、検索エンジン・人間・AIクローラーの両方に伝わる公開ページを標準化する。

---

## 0. このPlaybookの目的

このPlaybookは、`GitHub Pages + Jekyll` でリポジトリ単位のLPを構築・運用するときの標準手順である。

目的は次の4つ。

1. **公開まで最短で進める**  
   毎回同じディレクトリ構成・ビルド・確認手順で進める。

2. **GitHub Pages特有の事故を防ぐ**  
   project pages の `baseurl`、`docs/` 配信、アセット404、source/artifact混在を防止する。

3. **Googleに発見・理解されやすいLPにする**  
   title、description、H1、構造化データ、canonical、sitemap、robots、内部リンクを標準化する。

4. **Search Console運用まで含めて完了扱いにする**  
   技術SEOの実装だけではなく、URL検査・sitemap送信・インデックス状態確認までDefinition of Doneに含める。

参考:

- Google Search Central: SEO Starter Guide  
  https://developers.google.com/search/docs/fundamentals/seo-starter-guide
- Google Search Central: Ask Google to recrawl your URLs  
  https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl
- Google Search Central: JavaScript SEO basics  
  https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- GitHub Docs: GitHub Pages documentation  
  https://docs.github.com/pages
- GitHub Docs: Configuring a publishing source for GitHub Pages  
  https://docs.github.com/articles/configuring-a-publishing-source-for-github-pages

---

## 1. 基本方針

### 1.1 GitHub repoを直接SEO対象にしすぎない

GitHubリポジトリのREADMEは重要だが、検索流入のLPとしては制約がある。

- ページ構造やメタタグを細かく制御しづらい
- OGP画像、canonical、JSON-LD、manifestなどを十分に管理しづらい
- GitHub UI内のページなので、プロダクト専用の訴求導線を作りづらい
- READMEの主目的は開発者向け説明であり、検索流入ユーザー向けの価値提案とは異なる

そのため、各重要リポジトリには **GitHub Pages LP** を用意し、READMEとは役割を分ける。

### 1.2 LPとREADMEの役割分担

| 領域 | 主な対象 | 目的 |
|---|---|---|
| GitHub Pages LP | 検索ユーザー、評価者、非開発者、AIクローラー | 何を解決するプロダクトかを短時間で伝える |
| README | 開発者、導入検討者、コントリビューター | install、usage、architecture、API、contributionを説明する |
| Docs | 実利用者、運用者 | 詳細仕様、チュートリアル、FAQ、トラブルシュートを説明する |

LPは「検索結果から来た人に、最初の30秒で価値を伝えるページ」として設計する。

---

## 2. テンプレート変数

複数リポジトリへ横展開するため、固有値は必ずテンプレート変数として扱う。

```md
<owner>              = ugnoguchigxp
<repo-name>          = contextStill
<product-name>       = contextStill
<primary-keyword>    = contextStill / adaptive knowledge compilation / knowledge distillation など
<github-url>         = https://github.com/<owner>/<repo-name>
<pages-url>          = https://<owner>.github.io/<repo-name>/
<baseurl>            = ""
<local-baseurl>      = ""
```

例:

```md
<owner>        = ugnoguchigxp
<repo-name>    = contextStill
<pages-url>    = https://contextstill.com/
<baseurl>      = ""
```

---

## 2.1 汎用とrepo固有を分離する

このPlaybookは汎用手順として使う。
実運用時は、以下だけをrepoごとに差し替える。

- `<owner>`
- `<repo-name>`
- `<pages-url>`
- `<baseurl>`
- `<asset-dir>`（推奨: `img`）
- `<manifest-path>`（推奨: `/site.webmanifest`）
- Lighthouseしきい値

運用ルール:

- 汎用本文はテンプレート変数で保持する
- `contextStill` 固有値は「例」として明示する
- 実装差分が出たら、まず `scripts/` と workflow の実装値を正とする

---

## 3. ディレクトリ責務

### 3.1 標準構成

```txt
<repo-root>/
  README.md
  package.json
  github-pages/
    README.md
    SEO_CHECKLIST.md
    _config.yml
    _config.local.yml
    build-preview.sh
    build-dist.sh
    site/
      index.md
      robots.txt
      assets/
        css/
          lp.css
        img/
          hero.webp
          og-image.jpg
      _layouts/
        default.html
      _includes/
        head-seo.html
        jsonld-software.html
    docs/
      index.html
      robots.txt
      sitemap.xml
      assets/
        css/
        img/
    .preview/
    reports/
      lighthouse.json
    scripts/
      assert-lighthouse.ts
```

### 3.2 不変ルール

- `github-pages/site/` = Jekyll source
- `github-pages/docs/` = build artifact / GitHub Pages配信用
- `github-pages/.preview/` = ローカルプレビュー用artifact
- `github-pages/_config.yml` = 本番設定
- `github-pages/_config.local.yml` = ローカル設定
- `docs/` は手編集しない
- LPの編集は必ず `site/` で行う

### 3.3 命名衝突の回避

GitHub Pagesでは `docs/` が公開元としてよく使われる。したがって、ドキュメント置き場としての `docs/` と配信artifactとしての `docs/` が衝突しやすい。

このPlaybookでは、`github-pages/docs/` は **配信artifact専用** とする。人間向けの補足ドキュメントは以下に置く。

```txt
github-pages/README.md
github-pages/SEO_CHECKLIST.md
docs/architecture.md        # repo root側に通常ドキュメントを置く場合
```

---

## 4. GitHub Pages公開方式

### 4.1 推奨方式

基本は以下を推奨する。

- Branch: `main`
- Folder: `/github-pages/docs` が選べない場合は、Pages専用ブランチまたはGitHub Actionsを使う
- 可能なら GitHub Actions でJekyll build artifactをPagesへpublishする

GitHub PagesのUIで `/docs` しか選べない場合、repo root直下の `docs/` が前提になることがある。その場合は次のどちらかを選ぶ。

#### Option A: repo root直下の `docs/` を配信artifactにする

```txt
<repo-root>/
  github-pages/site/
  docs/                 # Pages配信用artifact
```

メリット:

- GitHub Pages UIで設定しやすい

デメリット:

- root直下の `docs/` が通常ドキュメント置き場として使えなくなる

#### Option B: GitHub ActionsでPagesへdeployする

```txt
<repo-root>/
  github-pages/site/
  github-pages/docs/    # build artifact
```

メリット:

- source/artifactを明確に分離できる
- repo rootの `docs/` を通常ドキュメント用に残せる
- CI品質ゲートと統合しやすい

デメリット:

- Actions workflowの管理が必要

複数リポジトリへ横展開するなら **Option B** を推奨する。

---

## 5. Jekyll設定

### 5.1 本番設定 `_config.yml`

```yml
# github-pages/_config.yml
title: "contextStill"
description: "A practical adaptive knowledge compiler for knowledge workflows."
url: "https://contextstill.com"
baseurl: ""

source: "site"
destination: "docs"

lang: "en"
timezone: "Asia/Tokyo"

# verification tokens; empty by default
google_verification_token: ""
bing_verification_token: ""

exclude:
  - README.md
  - SEO_CHECKLIST.md
  - scripts
  - reports
  - node_modules
  - package.json
  - bun.lockb
```

### 5.2 ローカル設定 `_config.local.yml`

```yml
# github-pages/_config.local.yml
baseurl: ""
destination: ".preview"
```

### 5.3 URL生成の原則

Jekyll内では、アセットURLや内部リンクに `relative_url` / `absolute_url` を使う。

```liquid
<link rel="stylesheet" href="{{ '/assets/css/lp.css' | relative_url }}">
<link rel="canonical" href="{{ page.url | absolute_url }}">
<img src="{{ '/assets/img/hero.webp' | relative_url }}" alt="...">
```

禁止:

```html
<link rel="stylesheet" href="/assets/css/lp.css">
<img src="/assets/img/hero.webp">
```

project pagesでは本番URLが `/<repo-name>/` 配下になるため、ルート絶対パスを直接書くと404の原因になる。

---

## 6. LP情報設計

### 6.1 ファーストビュー要件

1スクロール目で次を伝える。

1. プロダクト名
2. 誰のためのものか
3. 何の課題を解決するか
4. 既存手段と何が違うか
5. すぐ試すためのCTA

### 6.2 推奨セクション構成

```md
# <product-name>: <primary value proposition>

Hero:
- one-liner
- primary CTA: View on GitHub / Quick Start
- secondary CTA: Read docs / See examples

Problem:
- どのような課題があるか

Solution:
- このプロダクトがどう解決するか

Use Cases:
- 3〜5個の具体例

How It Works:
- 3ステップ程度で仕組みを説明

Key Features:
- 4〜6個

Quick Start:
- 最短導入コマンド

Architecture / Design Notes:
- 開発者が評価できる技術的根拠

Comparison / Why Not X:
- 代替手段との差分

FAQ:
- 検索意図を拾う質問形式

CTA:
- GitHub repo
- README
- Quick Start
- Examples
```

### 6.3 READMEとの差別化

LPにREADMEをそのまま貼らない。

LPは以下を重視する。

- 検索意図に沿った見出し
- 短い段落
- 価値提案
- 導入前の疑問解消
- 視覚的な比較・導線

READMEは以下を重視する。

- install
- usage
- API
- configuration
- development
- contribution
- license

---

## 7. コンテンツSEO

### 7.1 title設計

`<title>` は検索結果のタイトル候補になるため、ページ内容と一致させる。

推奨パターン:

```txt
<product-name> - <primary value proposition>
<product-name>: <keyword> for <target user/use case>
<product-name> | <short technical category>
```

例:

```txt
contextStill - Adaptive Knowledge Compilation for Knowledge Distillation Workflows
contextStill: Practical Adaptive Knowledge Compilation for AI Knowledge Systems
```

避ける:

```txt
Home
GitHub Pages LP
contextStill Docs
```

### 7.2 meta description

`meta description` はランキングを直接保証するものではないが、検索結果スニペットの候補になる。ページ内容と一致した自然文にする。

推奨:

```txt
contextStill is a practical adaptive knowledge compiler for knowledge workflows, designed to organize, retrieve, and reuse distilled context across AI-assisted development.
```

ルール:

- 1〜2文
- ページ内容と一致
- キーワードを詰め込まない
- 誰に何の価値があるかを明確化

### 7.3 H1/H2設計

H1は原則1つにする。

```md
# contextStill: Adaptive Knowledge Compilation for Knowledge Workflows
```

H2は検索意図を拾える表現にする。

```md
## What is contextStill?
## Why adaptive knowledge compilation matters
## How contextStill works
## Use cases
## Quick start
## FAQ
```

### 7.4 冒頭200〜300文字

LP冒頭に、検索エンジン・人間・AIクローラーが要約しやすい説明を置く。

例:

```md
contextStill is a lightweight adaptive knowledge compiler for AI-assisted knowledge workflows. It helps teams organize reusable context, route relevant knowledge to the right task, and reduce repeated prompting or fragmented project memory.
```

### 7.5 FAQの活用

FAQは検索意図を拾いやすい。

例:

```md
## FAQ

### Is contextStill a database?
No. It is a routing layer for reusable context and knowledge artifacts. It can work with files, embeddings, or other storage backends depending on the implementation.

### Who is contextStill for?
It is designed for developers and teams building AI-assisted workflows where project memory, reusable context, and knowledge distillation matter.
```

### 7.6 薄いLPを避ける

Googleに拾われたいだけの薄いページは作らない。

最低限、以下を含める。

- 何をするものか
- 誰に向いているか
- 何が新しいか
- 使い方
- 具体ユースケース
- README / GitHub repo / examples への導線
- FAQ

---

## 8. 技術SEO

### 8.1 必須meta

`site/_includes/head-seo.html` などに集約する。

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ page.title | default: site.title }}</title>
<meta name="description" content="{{ page.description | default: site.description }}">
<link rel="canonical" href="{{ page.url | absolute_url }}">

<meta property="og:type" content="website">
<meta property="og:title" content="{{ page.title | default: site.title }}">
<meta property="og:description" content="{{ page.description | default: site.description }}">
<meta property="og:url" content="{{ page.url | absolute_url }}">
<meta property="og:image" content="{{ '/assets/img/og-image.jpg' | absolute_url }}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{{ page.title | default: site.title }}">
<meta name="twitter:description" content="{{ page.description | default: site.description }}">
<meta name="twitter:image" content="{{ '/assets/img/og-image.jpg' | absolute_url }}">

{% if site.google_verification_token %}
<meta name="google-site-verification" content="{{ site.google_verification_token }}">
{% endif %}

{% if site.bing_verification_token %}
<meta name="msvalidate.01" content="{{ site.bing_verification_token }}">
{% endif %}
```

### 8.2 canonical

project pagesではcanonicalが特に重要。

正:

```html
<link rel="canonical" href="https://contextstill.com/">
```

誤:

```html
<link rel="canonical" href="https://ugnoguchigxp.github.io/">
<link rel="canonical" href="http://localhost:4000/">
```

Googleはcanonical指定を重複URL統合のヒントとして扱う。`robots.txt` をcanonical目的で使わない。

参考:  
https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls

### 8.3 robots.txt

`site/robots.txt`:

```txt
User-agent: *
Allow: /

Sitemap: https://contextstill.com/sitemap.xml
```

注意:

- 公開したいLPで `Disallow: /` を使わない
- stagingやprivate情報が混ざる場合は、公開artifactに含めない
- robotsはクロール制御であり、canonicalや秘匿の代替ではない

### 8.4 sitemap.xml

Jekyll pluginを使うか、静的生成する。

最低限:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://contextstill.com/</loc>
    <lastmod>2026-05-28</lastmod>
  </url>
</urlset>
```

複数ページ化する場合は、全公開URLを含める。

### 8.5 JSON-LD

ソフトウェア系リポジトリLPでは、`SoftwareSourceCode` または `SoftwareApplication` を検討する。

例:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  "name": "contextStill",
  "description": "A practical adaptive knowledge compiler for knowledge workflows.",
  "codeRepository": "<github-url>",
  "url": "https://contextstill.com/",
  "programmingLanguage": "TypeScript",
  "license": "<github-url>/blob/main/LICENSE"
}
</script>
```

Googleは構造化データをリッチリザルト等に利用することがあるが、マークアップしたから必ず特別表示されるわけではない。ページ内容と一致する情報のみを書く。

参考:  
https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data

### 8.6 favicon / manifest

最低限:

```html
<link rel="icon" href="{{ '/assets/img/favicon.svg' | relative_url }}" type="image/svg+xml">
<link rel="manifest" href="{{ '/site.webmanifest' | relative_url }}">
<meta name="theme-color" content="#111827">
```

`site.webmanifest`:

```json
{
  "name": "contextStill",
  "short_name": "contextStill",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#111827",
  "icons": []
}
```

---

## 9. アセット最適化

### 9.1 画像方針

- hero画像: WebP推奨
- OGP画像: JPGまたはPNG、1200x630推奨
- 画像には意味のある `alt` を付ける
- 装飾画像は `alt=""` にする
- 不要に巨大なスクリーンショットを置かない

### 9.2 Bun.Image最適化タスク

例:

```json
{
  "scripts": {
    "lp:optimize-image": "bun run github-pages/scripts/optimize-hero-image.ts"
  }
}
```

出力例:

```txt
github-pages/site/assets/img/hero.webp
github-pages/site/assets/img/og-image.jpg
```

### 9.3 画像チェック

```bash
find github-pages/site/assets/img -type f -maxdepth 1 -print -exec du -h {} \;
```

目安:

- hero image: 300KB以下を目標
- og-image: 500KB以下を目標
- favicon類: 必要最小限

---

## 10. ビルドとプレビュー

### 10.1 画像最適化

```bash
cd <repo-root>
bun run lp:optimize-image
```

### 10.2 ローカルプレビュー

```bash
cd <repo-root>/github-pages
./build-preview.sh
cd .preview
npx serve .
```

ローカル確認URL:

```txt
http://localhost:3000/
```

### 10.3 本番artifact更新

```bash
cd <repo-root>/github-pages
./build-dist.sh
```

### 10.4 本番プレビュー相当の確認

`baseurl: ""` の挙動を本番同様に見たい場合、配信ルートを調整する。

例:

```bash
cd <repo-root>/github-pages
./build-dist.sh
cd docs
npx serve .
```

ただし、リポジトリ直下など誤ったルートで配信すると `/assets/...` が見つからず404になることがある。再現性を重視するなら `.preview` を使う。

---

## 11. よくある詰まりどころと再発防止

### 11.1 `npx serve .` でCSS/画像が404になる

原因:

- 本番ビルドは `baseurl: ""` 前提
- リポジトリ直下で `npx serve .` すると `/assets/...` が存在しない

対策:

```bash
cd github-pages
./build-preview.sh
cd .preview
npx serve .
```

再発防止:

- READMEにプレビュー手順を固定する
- 本番ビルドとローカルビルドを分ける
- HTMLに `/assets/...` を直書きしない

### 11.2 `site/` と `docs/` が混ざる

原因:

- `site/` を配信対象と誤認する
- `docs/` を人間向けドキュメント置き場として編集する

対策:

- `site/` のみ編集
- `docs/` はartifactとして再生成
- PRでは `site/` と `docs/` の差分を分けて見る

### 11.3 CTAが開発者向けリンクに流れる

原因:

- 最終CTAが `/tree/main/github-pages` のような実装ディレクトリ向けになる

対策:

LP CTAは次の順で設計する。

1. Quick Start
2. GitHub repository home
3. README
4. Examples
5. Issues / Discussions

### 11.4 SEOを「実装だけ」で完了扱いにする

原因:

- meta、sitemap、robotsが揃った時点で完了と誤認する

対策:

- Search Consoleでプロパティ登録
- sitemap送信
- URL検査
- インデックス状態の確認
- 必要ならコンテンツ・内部リンク・canonicalを見直す

### 11.5 Googleにすぐ出ない

前提:

- クロールやインデックス登録は即時保証されない
- 数日から数週間かかることがある
- 同じURLへの再クロール依頼を繰り返しても早くなるとは限らない

対策:

- Search Consoleで状態を確認する
- sitemapを送る
- READMEやGitHub repo metadataからLPへリンクする
- 低品質な薄いページではなく、有用な内容を増やす

参考:  
https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl

---

## 12. GitHub側のSEO導線

LPだけでなく、GitHubリポジトリ側も整える。

### 12.1 Repository metadata

GitHub repo設定で以下を整える。

- Description: 検索されたい主要語を自然文で含める
- Website: GitHub Pages LP URLを設定
- Topics: 技術カテゴリ、用途、言語、関連領域を設定

例:

```txt
Description:
Adaptive knowledge compiler for reusable AI knowledge workflows.

Website:
https://contextstill.com/

Topics:
ai, memory, knowledge-management, knowledge-distillation, developer-tools
```

### 12.2 README冒頭

READMEの冒頭にLPへのリンクを置く。

```md
# contextStill

A practical adaptive knowledge compiler for reusable AI knowledge workflows.

- Landing page: https://contextstill.com/
- Quick start: ./docs/quick-start.md
- Examples: ./examples
```

### 12.3 相互リンク

必須リンク:

```txt
LP -> GitHub repo
LP -> README
LP -> Quick Start
LP -> Examples
README -> LP
README -> GitHub Pages docs if relevant
```

検索エンジンがURLを発見しやすくなるだけでなく、ユーザーも迷いにくくなる。

---

## 13. Lighthouse / 品質ゲート

### 13.1 目標値

最低ライン:

```txt
Performance >= 90
Accessibility >= 90
Best Practices >= 90
SEO = 100
```

SEOだけ100でも不十分。LPとしてはアクセシビリティとパフォーマンスも重要。

### 13.2 実行例

```bash
cd <repo-root>
bun run lp:lighthouse
bun run github-pages/scripts/assert-lighthouse.ts github-pages/reports/lighthouse.json 90 100
```

### 13.3 assert仕様例

```txt
assert-lighthouse.ts <reportPath> <minPerformance> <minSeo>
```

注記:

- 現在の `contextStill` 実装は `performance` と `seo` の2指標をゲート化している
- `accessibility` と `best-practices` もゲート化したい場合は `assert-lighthouse.ts` を拡張する

例:

```bash
bun run github-pages/scripts/assert-lighthouse.ts github-pages/reports/lighthouse.json 90 100
```

### 13.4 Lighthouseだけでは足りないチェック

Lighthouseは便利だが、以下は別途確認する。

- canonicalが本番URLになっているか
- sitemapに本番URLが入っているか
- robots.txtが公開をブロックしていないか
- CTAリンクが壊れていないか
- OGP画像URLが200を返すか
- Search ConsoleでURL検査したか

---

## 14. CLI検証コマンド

### 14.1 HTTP status

```bash
curl -I https://contextstill.com/
```

期待:

```txt
HTTP/2 200
```

### 14.2 canonical

```bash
curl -s https://contextstill.com/ | grep -i "canonical"
```

期待:

```html
<link rel="canonical" href="https://contextstill.com/">
```

### 14.3 robots.txt

```bash
curl -s https://contextstill.com/robots.txt
```

期待:

```txt
User-agent: *
Allow: /
Sitemap: https://contextstill.com/sitemap.xml
```

### 14.4 sitemap.xml

```bash
curl -s https://contextstill.com/sitemap.xml | head
```

期待:

```xml
<loc>https://contextstill.com/</loc>
```

### 14.5 OGP画像

```bash
curl -I https://contextstill.com/assets/img/og-image.jpg
```

期待:

```txt
HTTP/2 200
content-type: image/jpeg
```

### 14.6 noindex検出

```bash
curl -s https://contextstill.com/ | grep -i "noindex"
```

期待:

```txt
# 何も出ない
```

### 14.7 リンク切れ

ローカルまたはCIで link checker を使う。

例:

```bash
npx broken-link-checker https://contextstill.com/ -ro
```

または:

```bash
npx linkinator https://contextstill.com/ --recurse
```

---

## 15. Search Console運用

### 15.1 対象URL

```txt
https://contextstill.com/
```

### 15.2 初回セットアップ

1. Search ConsoleでURL-prefixプロパティを追加
2. 所有権確認を行う
3. 必要に応じて `_config.yml` にverification tokenを設定
4. build-distして本番へ反映
5. URL検査でトップページを確認
6. sitemapを送信

### 15.3 sitemap送信

```txt
https://contextstill.com/sitemap.xml
```

### 15.4 URL検査

トップページを検査する。

```txt
https://contextstill.com/
```

確認項目:

- URLがGoogleに登録されているか
- クロール済みか
- インデックス登録可能か
- canonicalが意図通りか
- モバイルユーザビリティに問題がないか

### 15.5 観測スケジュール

```txt
T+0:
- Pages公開
- sitemap送信
- URL検査
- インデックス登録をリクエスト

T+1〜3日:
- URL検査で状態確認
- site:検索で確認

T+7日:
- Search Consoleのページインデックス状況を確認
- 登録されていなければ原因を記録

T+14日:
- まだ未登録なら、コンテンツ量・内部リンク・canonical・robots・HTTP statusを再点検

T+30日:
- 検索クエリ、表示回数、CTRを確認
- title / description / FAQ / README導線を改善
```

### 15.6 `site:` 検索

```txt
site:contextstill.com
site:contextstill.com contextStill
```

注意:

- `site:` 検索は診断の補助であり、Search Consoleの代替ではない
- 検索結果に出ない場合でも、Search Consoleでは登録済みの場合がある

---

## 16. GitHub Actions CI例

### 16.1 CIでやること

- Jekyll build
- link check
- Lighthouse CI
- artifact確認
- 必要ならPages deploy

### 16.2 workflow例

```yml
name: GitHub Pages LP Quality Gate

on:
  pull_request:
    paths:
      - 'github-pages/**'
      - 'package.json'
      - 'bun.lockb'
  push:
    branches:
      - main
    paths:
      - 'github-pages/**'
      - 'package.json'
      - 'bun.lockb'

jobs:
  lp-quality:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install

      - name: Optimize images
        run: bun run lp:optimize-image

      - name: Build preview
        run: |
          cd github-pages
          ./build-preview.sh

      - name: Build dist
        run: |
          cd github-pages
          ./build-dist.sh

      - name: Check generated files
        run: |
          test -f github-pages/docs/index.html
          test -f github-pages/docs/robots.txt
          test -f github-pages/docs/sitemap.xml

      - name: Link check
        run: npx linkinator github-pages/docs/index.html --silent

      - name: Lighthouse
        run: bun run lp:lighthouse

      - name: Assert Lighthouse
        run: bun run github-pages/scripts/assert-lighthouse.ts github-pages/reports/lighthouse.json 90 100
```

実際のPages deployまでCIに含める場合は、GitHub Pagesの公開方式に合わせて別jobを追加する。

---

## 17. 標準ワークフロー

### Step 0: 目的と検索意図を決める

```txt
Product:
Target user:
Primary keyword:
Secondary keywords:
Main problem:
Main CTA:
```

### Step 1: GitHub metadataを整える

- repo description
- website URL
- topics
- README冒頭のLPリンク

### Step 2: LP本文を書く

編集対象:

```txt
github-pages/site/index.md
```

必須:

- H1
- 冒頭説明
- Problem
- Solution
- Use cases
- How it works
- Quick Start
- FAQ
- CTA

### Step 3: アセットを最適化

```bash
cd <repo-root>
bun run lp:optimize-image
```

### Step 4: ローカルプレビュー

```bash
cd <repo-root>/github-pages
./build-preview.sh
cd .preview
npx serve .
```

確認:

- desktop
- mobile
- CTA
- 画像
- OGP
- no console error

### Step 5: 本番artifact更新

```bash
cd <repo-root>/github-pages
./build-dist.sh
```

### Step 6: ローカル品質ゲート

```bash
cd <repo-root>
bun run lp:lighthouse
bun run github-pages/scripts/assert-lighthouse.ts github-pages/reports/lighthouse.json 90 100
```

### Step 7: CLI検証

```bash
curl -I https://contextstill.com/
curl -s https://contextstill.com/ | grep -i canonical
curl -s https://contextstill.com/robots.txt
curl -s https://contextstill.com/sitemap.xml | head
```

### Step 8: Search Console運用

- URL-prefix property追加
- ownership verification
- sitemap送信
- URL検査
- インデックス登録リクエスト
- 7日後・14日後・30日後に確認

---

## 18. Definition of Done

LP / SEO作業は、以下を満たしたら完了とする。

### 18.1 画面品質

- [ ] desktopで崩れなし
- [ ] mobileで崩れなし
- [ ] 1スクロール目で何のプロダクトか分かる
- [ ] CTAがプロダクト導線になっている
- [ ] 画像が重すぎない
- [ ] altが適切

### 18.2 コンテンツSEO

- [ ] H1にプロダクト名と価値提案が入っている
- [ ] titleがページ内容と一致している
- [ ] meta descriptionが自然文で価値を説明している
- [ ] 冒頭200〜300文字で用途が分かる
- [ ] Problem / Solution / Use cases / Quick Start / FAQがある
- [ ] READMEの単純コピーではない
- [ ] 薄いページではなく、検索ユーザーの疑問に答えている

### 18.3 技術SEO

- [ ] canonicalが本番URLになっている
- [ ] OGP metaがある
- [ ] Twitter card metaがある
- [ ] JSON-LDがページ内容と一致している
- [ ] robots.txtが公開をブロックしていない
- [ ] sitemap.xmlに本番URLが入っている
- [ ] faviconが設定されている
- [ ] manifestが設定されている
- [ ] noindexが混入していない

### 18.4 GitHub導線

- [ ] repo descriptionが設定されている
- [ ] repo websiteにLP URLが設定されている
- [ ] topicsが設定されている
- [ ] README冒頭からLPへリンクしている
- [ ] LPからGitHub repo / README / Quick Start / Examplesへリンクしている

### 18.5 パフォーマンス / 品質

- [ ] Lighthouse Performance >= 90
- [ ] Lighthouse Accessibility >= 90
- [ ] Lighthouse Best Practices >= 90
- [ ] Lighthouse SEO = 100
- [ ] リンク切れがない
- [ ] 主要URLがHTTP 200を返す

### 18.6 Search Console運用

- [ ] URL-prefix propertyを追加した
- [ ] 所有権確認を完了した
- [ ] sitemapを送信した
- [ ] トップページURLを検査した
- [ ] インデックス登録をリクエストした
- [ ] T+7 / T+14 / T+30の確認タスクを作った

### 18.7 再現性

- [ ] 手順が `github-pages/README.md` に反映されている
- [ ] SEOチェックが `github-pages/SEO_CHECKLIST.md` に反映されている
- [ ] `site/` と `docs/` の責務が明確
- [ ] build-preview / build-distが動く
- [ ] CIで品質ゲートを再現できる

---

## 19. 変更時の最小チェックリスト

```md
- [ ] `github-pages/site/` 側のみ編集した
- [ ] `github-pages/docs/` を直接編集していない
- [ ] `bun run lp:optimize-image` を実行した
- [ ] `./build-preview.sh` でローカル確認した
- [ ] desktop/mobileを確認した
- [ ] CTAリンク先がプロダクト導線になっている
- [ ] `./build-dist.sh` でartifactを更新した
- [ ] Lighthouseを実行した
- [ ] canonical / robots / sitemapを確認した
- [ ] READMEからLPへのリンクを確認した
- [ ] Search Consoleの運用手順を実施またはタスク化した
```

---

## 20. 新規リポジトリ向けクイックテンプレート

### 20.1 初期入力

```md
Product name:
Repository:
Pages URL:
Primary audience:
Primary keyword:
Secondary keywords:
Main problem:
Main value proposition:
Primary CTA:
Secondary CTA:
```

### 20.2 LPアウトライン

````md
---
layout: default
title: "<product-name> - <primary value proposition>"
description: "<product-name> helps <target user> <solve problem> by <solution>."
---

# <product-name>: <primary value proposition>

<product-name> helps <target user> <solve problem>. It provides <key mechanism> so that <outcome>.

[View on GitHub](<github-url>)
[Quick Start](<quick-start-url>)

## The problem

...

## The solution

...

## Use cases

...

## How it works

1. ...
2. ...
3. ...

## Key features

- ...
- ...
- ...

## Quick start

```bash
...
```

## FAQ

### What is <product-name>?
...

### Who is it for?
...

### How is it different from <alternative>?
...

## Get started

- GitHub: <github-url>
- README: <readme-url>
- Examples: <examples-url>
````

---

## 21. 評価基準

このPlaybookに沿ったLPを10点満点で評価する場合の目安。

| 点数 | 状態 |
|---:|---|
| 10 | 技術SEO、コンテンツSEO、GitHub導線、Search Console運用、CI品質ゲートが揃い、横展開できる |
| 9 | 主要項目は揃っているが、CIまたはSearch Console観測ループに軽微な不足がある |
| 8 | 技術SEOと手順は良いが、コンテンツSEOまたはGitHub導線が弱い |
| 7 | LPは公開できるが、再現性・検証・運用が属人的 |
| 6以下 | metaタグや見た目中心で、検索意図・運用・検証が不足している |

---

## 22. 最終原則

1. **LPはREADMEのコピーではない**  
   検索ユーザーに価値を伝える独立ページにする。

2. **GitHub Pages project pagesではbaseurlを疑う**  
   CSS/画像404の多くは `baseurl` と配信ルートの不一致で起きる。

3. **SEOは実装と運用を分ける**  
   meta、sitemap、robotsを入れて終わりではない。Search Consoleで確認する。

4. **Google掲載は保証されない**  
   クロール依頼やsitemap送信は発見を助けるが、即時掲載や掲載自体を保証しない。

5. **高品質で有用な内容を優先する**  
   薄いLPを量産するより、リポジトリの価値・用途・導入方法が明確なページを作る。

6. **横展開できる形にする**  
   repo固有値はテンプレート変数化し、手順・DoD・CIを共通化する。
