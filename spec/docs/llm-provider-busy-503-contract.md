# LLM Provider busy 503 contract

## Purpose

LLM Provider がすでに別作業中で新しい生成リクエストを受けられない場合、queue 側に一時的な受け入れ不可として伝えるための契約です。queue はこの 503 を恒久障害として扱わず、待機後に同じ job を再試行します。

## Provider response

Provider は busy 時に `503 Service Unavailable` を返してください。

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 30
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "error": "llm_busy",
  "message": "LLM worker is currently busy. Retry later.",
  "retryable": true,
  "retryAfterSeconds": 30
}
```

## Queue behavior

- `503` は LLM Provider の一時的な busy として扱います。
- `Retry-After` がある場合はその秒数を使います。
- `Retry-After` がない場合は 30 秒後に再試行します。
- job は `pending` に戻し、`next_run_at` を待機後の時刻に設定します。
- `last_outcome_kind` は `provider_unavailable_retry` とします。

## Non-goals

- `429 Too Many Requests` の意味づけは変更しません。
- `400` 系の入力エラーは retry 対象にしません。
- Provider transport failure と Provider busy を同じ分類にしません。
- queue 側で job を完了扱いにしてから再実行する運用にはしません。
