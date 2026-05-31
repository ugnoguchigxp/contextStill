# SEO Checklist (GitHub Pages LP)

## 1. Technical SEO (implemented)

- Canonical URL (`/`)
- Open Graph / Twitter Card metadata
- JSON-LD (`WebSite`)
- `robots.txt` with sitemap URL
- `sitemap.xml` generation (`jekyll-sitemap`)
- favicon + `site.webmanifest`
- Hero image optimization (WebP + OG JPEG)
- Lighthouse automation (`.github/workflows/seo-audit.yml`)

## 2. Search Console (manual operations)

対象プロパティ:

- `https://contextstill.com/`

実施手順:

1. Search Console に URL-prefix プロパティを追加
2. サイトマップを送信
   - `https://contextstill.com/sitemap.xml`
3. URL 検査でトップページを検査
   - `https://contextstill.com/`
4. 「インデックス登録をリクエスト」を実行
5. 24-72時間後に「ページのインデックス登録」ステータスを確認

必要なら検証トークンを `_config.yml` に追加:

- `google_verification_token: "<token>"`
- `bing_verification_token: "<token>"`

## 3. Continuous SEO Ops (weekly/monthly)

毎週:

1. `seo-audit` workflow の Lighthouse レポートを確認
2. Performance 90未満 or SEO 100未満なら修正チケット化

毎月:

1. README / docs の更新差分から LP 追記候補を抽出
2. 新規ユースケース or 実績（導入・改善結果）を1件以上追加
3. 参照元リンク（技術ブログ・登壇資料・OSSディレクトリ）を最低1件追加
4. Search Console の「表示回数 / クリック / インデックス済みページ」を記録
