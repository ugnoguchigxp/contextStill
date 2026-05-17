# Node.js / Bun における Graceful Shutdown（優雅なシャットダウン）とゾンビプロセス防止ガイド

本ドキュメントでは、Node.js や Bun を利用したサーバーアプリケーションにおいて、プロセスが正常に終了せずバックグラウンドに「ゾンビプロセス」として残ってしまう問題の原因と、その具体的な解決手法（Graceful Shutdown）について解説します。

---

## 1. 問題の背景と原因

### ゾンビプロセスが発生する理由
Node.js や Bun のランタイムは、**「イベントループにアクティブなハンドル（監視対象）が存在する限り、プロセスを終了しない」**という仕様を持っています。

よくあるアクティブなハンドルの例：
1. **HTTP サーバー of 待受ソケット** (`server.listen` 等)
2. **データベース of 接続プール** (`pg.Pool` など PostgreSQL への持続的接続)
3. 実行中の `setTimeout` や `setInterval` などのタイマー

Ctrl+C を押してプロセスを止めようとした際、HTTP サーバーだけを閉じても、**データベースとの接続（ソケット）が開いたまま放置されていると、イベントループが空にならずにプロセスがバックグラウンドに残留（ハングアップ）**します。これが繰り返されることで大量 of ゾンビプロセスが発生します。

---

## 2. 解決策：Graceful Shutdown の実装

プロセスの終了シグナル（`SIGINT` や `SIGTERM`）をキャッチし、以下の手順でリソースを順番に安全に解放します。

1. **新規リクエストの受付を停止**：HTTP サーバーのソケットを閉じる (`server.close()`)。
2. **データベース接続の解放**：データベース接続プールを閉じる (`pool.end()` / `client.end()`)。
3. **プロセスの正常終了**：`process.exit(0)` を呼び出し、終了コード `0` で安全に終了する。

---

## 3. 具体的な実装コード例

以下は、Hono (`@hono/node-server`) と PostgreSQL (`pg` / `drizzle-orm`) を使用したアプリケーションでの実装例です。

```typescript
import { serve } from "@hono/node-server";
import app, { getAppRuntime } from "./hono";
import { readAppEnv } from "./env";

const env = readAppEnv();

// 1. serve の戻り値としてサーバーインスタンスを保持する
const server = serve(
  {
    fetch: app.fetch,
    port: env.port,
  },
  (info) => {
    console.log(`Server listening on http://localhost:${info.port}`);
  }
);

// 2. シャットダウンハンドラの実装
const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  
  // 新規接続 of 受付を停止
  server.close();

  try {
    // データベース接続（pg.Pool）を取得してクローズする
    const runtime = await getAppRuntime();
    if (runtime?.dbConnection?.ownsConnection) {
      const client = runtime.dbConnection.pgClient;
      if ("end" in client && typeof client.end === "function") {
        console.log("Closing database connection pool...");
        await client.end(); // 重要：ここを閉じないとプロセスがハングします
      }
    }
    console.log("Shutdown complete.");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

// 3. 終了シグナルのリスナーを登録
process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C
process.on("SIGTERM", () => shutdown("SIGTERM")); // kill コマンドやコンテナ停止シグナル
```

---

## 4. 対策が有効かどうかの検証方法

正しく Graceful Shutdown が機能しているかは、以下の手順で実機検証できます。

### ステップ 1: サーバーの起動
通常通り、開発用または本番用サーバーを起動します。
```bash
bun run src/app/server.ts
```

### ステップ 2: プロセスID（PID）の特定
別のターミナルから、サーバーが起動しているポート番号（例: `3000` など、各プロジェクトで設定されているポート）を指定してプロセスの PID を確認します。
```bash
lsof -t -i:<PORT>
```

### ステップ 3: 終了シグナル（SIGINT）の送信
特定した PID に対して `SIGINT` (Ctrl+C に相当) を送信します。
```bash
kill -s INT <PID>
```

### ステップ 4: ログと終了ステータスの確認
サーバーのコンソール出力に以下のようなシャットダウンログが出力され、ハングすることなくプロセスが終了すれば合格です。

```text
Received SIGINT. Shutting down gracefully...
Closing database connection pool...
Shutdown complete.
```

`lsof -i:<PORT>` を再度実行し、ポートが綺麗に解放されていることを確認してください。
