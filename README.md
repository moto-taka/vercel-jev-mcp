# Vercel Jev MCP

**Hono製のリモートMCPサーバーです。Vercelにデプロイし、1つのURLを複数のAIクライアントで共有できます。JevのAPIキーは不要です。**

```text
Cursor / Claude Code / Codex
  └─ HTTPS + 自分で決めたBearerトークン
       └─ Hono /mcp
            └─ Vercel AI Gateway（APIキーまたはVercel OIDC認証）
                 └─ TypeSafe Jev（Gateway管理の資格情報で利用）
```

Jevへの薄い中継です。独自の要約・スコア補正・候補削除・自動操作は行いません。`state`と`questions`を評価APIに渡し、回答と確率分布を返します。ローカルのstdioサーバー、Redis、DB、ユーザー登録、トークン発行APIは不要です。MCP用オブジェクトはリクエストごとに作成しますが、AIクライアントごとのOSプロセスは起動しません。

## 1. Vercelへデプロイ

Vercelの **Add New → Project** でこのリポジトリをImportしてください。

| 項目 | 設定 |
| --- | --- |
| Repository | `moto-taka/vercel-jev-mcp` |
| Framework Preset | **Hono** |
| Root Directory | リポジトリのルート |
| Node.js | **22.x** |
| Build Command | `npm run build`（設定済み） |
| Output Directory | 上書きしません |

`src/index.ts`のdefault exportをVercelのHonoランタイムが使用します。`src/dev.ts`はローカル開発専用です。

### 環境変数

まず手元で、MCP接続専用のランダムな秘密文字列を作ってください。

```sh
openssl rand -hex 32
```

**生成結果はこのリポジトリやチャットへ貼らず、VercelのEnvironment Variablesと、自分のクライアント設定に保存してください。** サーバーには発行機能を実装していません。

| 変数 | 設定内容 |
| --- | --- |
| `MCP_BEARER_TOKEN` | 上で作成した64文字のトークン。`Bearer `は付けず値だけを保存します |
| `AI_GATEWAY_API_KEY` | Vercel AI GatewayのAPIキー。クライアントへ配布しません。Vercel OIDCを利用する場合は省略できます |

**通常はこの2つを設定してDeployしてください。`JEV_API_KEY`は設定不要です。** モデルは`typesafe-ai/jev`に固定し、Gateway管理の資格情報で利用します。TypeSafeへの直接接続や、独自のチャットAPIへの変換は行いません。[公式のEvaluationの使用例](https://vercel.com/docs/ai-gateway/modalities/evaluation)も、JevキーやBYOK指定なしで利用する形です。

Vercel上で[OIDC認証](https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc)を利用する場合は、`AI_GATEWAY_API_KEY`も省略できます。その場合でも、外部からのMCPアクセスを制限する`MCP_BEARER_TOKEN`は必要です。最初はGatewayキーを明示設定すると、認証設定を確認しやすくなります。

利用料金はGateway側のモデル料金に従います。現在の料金は[Jevのモデルページ](https://vercel.com/ai-gateway/models/jev)で確認してください。無料表示やキャンペーン料金を恒久的な無料利用とは扱わず、Gatewayの予算・利用上限を設定してください。

#### 任意: 自分のTypeSafeキーを使う場合だけBYOKを設定

`JEV_API_KEY`に空でない値を設定した場合だけ、`providerOptions.gateway.byok['typesafe-ai']`で、そのキーをGatewayに渡します。GatewayのBYOK画面へ別途登録する必要はありません。**通常のGateway利用をする場合は、この環境変数を未設定にしてください。以前設定済みの場合も、削除して再デプロイすればリクエスト単位のBYOK指定をやめられます。**

BYOKはGateway認証の代わりにはならず、この場合もGatewayキーまたはOIDCが必要です。BYOKを利用するチームには購入済みのAI Gatewayクレジットが必要で、プロバイダー側費用はGateway予算の対象外です。GatewayはBYOK失敗時に管理側資格情報へフォールバックする場合があります。本サーバーの`only: ['typesafe-ai']`はプロバイダー制限であり、資格情報のフォールバック禁止ではありません。BYOKを使う場合だけ、TypeSafe側の利用制限も確認してください。[BYOKの公式仕様](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok)

環境変数を変更した場合は再デプロイしてください。通常利用するProduction環境に値が設定されていることも確認してください。

### 接続URL

```text
https://YOUR-PROJECT.vercel.app/mcp
```

**VercelのDeployment Protectionと、このアプリのBearer認証は別です。** Vercelログイン画面が返る場合、Production URLへのアクセスをDeployment Protectionが遮断していないか確認してください。Preview保護は維持できます。アプリ自体はBearer認証を必須にしているため、Vercelログインなしで到達できるProduction URLでも匿名のJev利用はできません。

## 2. ローカルのAIクライアントから接続

クライアント側に必要なのは **MCPのURLと`MCP_BEARER_TOKEN`の値だけ**です。Gatewayキーや任意のBYOK用Jevキーは渡しません。以下ではクライアント側の環境変数名を`JEV_MCP_TOKEN`としています。

### Cursor

`~/.cursor/mcp.json`などの設定に追加してください。

```json
{
  "mcpServers": {
    "jev": {
      "url": "https://YOUR-PROJECT.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer ${env:JEV_MCP_TOKEN}"
      }
    }
  }
}
```

Cursorのプロセスから`JEV_MCP_TOKEN`が読める状態で起動してください。設定後は再接続・再起動してください。GUI起動で環境変数が継承されない場合は、ユーザー用設定ファイルのヘッダーに実際の値を保存する方法もあります。その場合、設定ファイルをGitで共有しないでください。`command`、`npx`、ローカル中継プロセスは使いません。

### Claude Code

```sh
claude mcp add --transport http --scope user jev \
  https://YOUR-PROJECT.vercel.app/mcp \
  --header "Authorization: Bearer ${JEV_MCP_TOKEN}"
```

`JEV_MCP_TOKEN`はコマンド実行前に自分の環境へ設定してください。このコマンドはヘッダーをローカルのClaude設定へ保存します。トークンを更新した場合はその登録も更新してください。

### Codex

`~/.codex/config.toml`の例です。

```toml
[mcp_servers.jev]
url = "https://YOUR-PROJECT.vercel.app/mcp"
bearer_token_env_var = "JEV_MCP_TOKEN"
```

Codexのプロセスが`JEV_MCP_TOKEN`を読める必要があります。同じURLとトークンを複数クライアントで共有できます。

## 3. 接続テスト

このリポジトリを取得した端末で実行します。スモークテスト自体にはnpm依存関係のインストールは不要です（Node.js 22以上）。

```sh
export JEV_MCP_URL='https://YOUR-PROJECT.vercel.app/mcp'
# JEV_MCP_TOKENには、自分の秘密情報管理方法でトークンを設定してください。
node scripts/smoke.mjs
```

匿名リクエストが401になること、初期化、4つのツールの一覧取得を確認します。**この段階ではJev推論を実行しないため、Gateway認証の有効性はまだ検証しません。**

次のコマンドはJevへの評価を**1回実行**し、GatewayとJevまでの接続を確認します。モデルの利用料金が発生する可能性があります。

```sh
node scripts/smoke.mjs --live
```

`GET /healthz`は公開の軽い生存確認です。認証や上流キーの有効性は示しません。`GET /mcp`が405なのは正常です。評価とMCP通信にはPOSTを使用します。

## 提供ツール

| ツール | 入力 | 返却 |
| --- | --- | --- |
| `jev_ask` | `state`, `questions` | 複数の独立した判断を1回で評価します |
| `jev_classify` | `state`, `instructions`, `criteria` | 指定した候補から選択します |
| `jev_score` | `state`, `instructions`, `criteria` | 順序付き評価軸に対するスコアを返します |
| `jev_check` | `state`, `instructions`, 任意の`criteria` | 命題が成立する確率を返します |

単一質問ツールの答えは`answers.result`に入ります。すべてのツールはMCPの`structuredContent`と、互換用のJSONテキストを返します。同じstateを評価する質問は`jev_ask`にまとめてください。

### `jev_ask`の例

```json
{
  "state": {
    "goal": "問い合わせフォームの入力欄を見つける",
    "elements": [
      { "id": "e1", "role": "textbox", "label": "メールアドレス" },
      { "id": "e2", "role": "link", "label": "会社概要" }
    ]
  },
  "questions": {
    "target": {
      "type": "choice",
      "instructions": "メールアドレス入力欄のIDを選んでください。",
      "criteria": { "e1": "メールアドレス入力欄", "e2": "会社概要へのリンク" }
    },
    "has_email": {
      "type": "boolean",
      "instructions": "メールアドレス入力欄が観測されていますか。"
    },
    "relevance": {
      "type": "score",
      "instructions": "観測された要素が現在の目的にどの程度関係するか評価してください。",
      "criteria": ["無関係", "補助的", "次の操作に必要"]
    }
  }
}
```

`state`と`instructions`は文字列・オブジェクト・配列を受け付けます。`criteria`の説明は同じ型または`null`です。`boolean.criteria`の`true`と`false`は任意です。質問のIDは結果を識別するキーで、質問文そのものではありません。判定に必要な対象や目的は`instructions`にも記載してください。

**Gatewayの質問型は`choice` / `score` / `boolean`です。** TypeSafe直結APIの`noul`は、ここでは`boolean`を使用します。Gatewayの評価モデル用スキーマに従うため、TypeSafe直結レスポンスとバイト単位で同じではありません。Gatewayが提供しない`confidence`や`legend`は生成しません。`none`候補の追加、act/review判定、yes/noへの丸めも行いません。

リクエストは切り詰めず、上限超過ならエラーを返します。質問1..64件、Choice1..255候補、Score2..10段階、HTTP本文256 KiB、評価入力240 KiB、JSONネスト40段です。これはローカルの濫用防止上限であり、モデルのトークン上限内に収まる保証ではありません。

## hooks / ハーネスから通常のHTTPで呼ぶ

同じ認証で`POST /v1/evaluate`も利用できます。本文は`jev_ask`と同じです。MCPのJSON-RPCで包まずに送信します。`evaluate.json`へ上の入力例を保存した場合:

```sh
curl --fail-with-body https://YOUR-PROJECT.vercel.app/v1/evaluate \
  -H "Authorization: Bearer ${JEV_MCP_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @evaluate.json
```

これは評価APIであり、自動圧縮APIではありません。browser/computer useの結果を主LLMに届く前に渡すには、呼び出し元のhooks・ハーネスで接続する必要があります。

## セキュリティと運用

すべての`/mcp`・`/v1/evaluate`リクエストでBearerを検証します。未設定・短すぎる・不正なサーバートークンでは503となり、匿名公開へ切り替わりません。比較はSHA-256の固定長ダイジェストと`timingSafeEqual`を使用します。URLクエリのトークンやBasic認証は受け付けません。

サーバーは入力・APIキー・生の上流エラーを保存またはログ出力しません。ただし入力はVercel AI GatewayとTypeSafeへ送信されるため、両サービスのログ・データ保持設定は別途確認してください。ツール入力からモデル、上流URL、キーを変更することはできません。自動リトライは0回、推論の締切は既定20秒です。

Bearerを持つ人は評価APIを利用できます。**このアプリ単体に分散レート制限・課金のハード上限はありません。** Vercel Firewall側のレート制限とGateway側の費用管理を併用し、BYOK利用時はTypeSafe側の費用管理も設定してください。プロセスメモリ上のカウンターを全インスタンス共通の制限とは扱いません。

| 任意の環境変数 | 用途 |
| --- | --- |
| `JEV_API_KEY` | 自分のTypeSafeキーをBYOKで使う場合だけ設定します。未設定・空文字・空白のみならリクエストにBYOKを含めません |
| `MCP_BEARER_TOKEN_PREVIOUS` | 更新中だけ旧トークンも受け付けます。移行後は削除して再デプロイしてください |
| `MCP_ALLOWED_ORIGINS` | Originヘッダーの完全一致許可リスト（カンマ区切り）。OriginなしのネイティブMCPクライアントでは不要です。ブラウザ向けCORSプロキシ機能ではありません |
| `JEV_TIMEOUT_MS` | 上流の締切。1000..55000の整数、既定20000です |

statelessなStreamable HTTPを使用します。Redis・セッション保存は不要です。2025世代のStreamable HTTPクライアントもMCPハンドラーの互換経路で処理します。古いHTTP+SSE専用クライアントと`/sse`には対応していません。

## ローカル開発とテスト

```sh
npm ci
cp .env.example .env
# .envにMCP_BEARER_TOKENとAI_GATEWAY_API_KEYを設定します。Jevキーは不要です。
npm run dev
```

開発URLは`http://127.0.0.1:3000/mcp`です。複数AIから使う場合も開発サーバーは1つだけ起動してください。本番の各AIには、この開発サーバーを起動させずVercelのURLを登録します。

```sh
npm run typecheck
npm test
npm run build
```

テストはHono、実際のMCPハンドラー、実際のAI SDKを使用し、GatewayへのHTTP送信だけをスタンドインへ差し替えます。認証、実バイト数制限、スキーマ、MCP初期化、Jevキーなしのツール実行・REST評価、任意のBYOKの送信先、上流キーとMCPトークンの分離、不正な回答の拒否、締切、同時リクエストの分離を検証します。GitHub Actionsの通常テストにAPIキーは必要ありません。ライブ接続検証とは区別してください。

## 参考・仕様

- [参考実装: rashedInt32/jev-mcp](https://github.com/rashedInt32/jev-mcp) — ツールの分け方を参考にしています。API引数の完全互換ではありません。
- [Vercel AI Gateway Evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation) — AI SDK 7以降の評価APIです。チャット互換APIは使用しません。
- [Gateway認証](https://vercel.com/docs/ai-gateway/authentication-and-byok)
- [Gateway OIDC認証](https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc)
- [Gateway request-scoped BYOK（任意）](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok)
- [Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono)
- [Vercel MCP deployment](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Cursor MCP](https://cursor.com/docs/mcp)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex MCP](https://developers.openai.com/codex/mcp)
