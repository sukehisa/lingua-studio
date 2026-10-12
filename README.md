# LinguaStudio (中国語 & 英語学習スタジオ)

中国語・英語の対訳教材を用いて、センテンス単位のリスニングと発音・スピーキング特訓が行える Web アプリケーションです。

## 主な機能

- **リスニング特訓**: 音声合成（Web Speech API）、センテンス同期ハイライト、速度変更、リピート再生
- **スピーキング特訓**: 音声認識、タイマー練習、リアルタイム文字起こし
- **教材カタログ & 個人ライブラリ**:
  - Google SSO (OAuth 2.0 / Google Identity Services) によるログイン
  - ユーザーごとの個人教材ライブラリ（クラウド保存 & 端末間同期）
  - 初回ログイン時に標準教材セットを自動シード（個別編集・削除も可能）
  - 独自教材の追加・編集・削除
  - 未ログイン時のゲストモード（ローカルストレージ保持）対応
  - JSONインポート / エクスポート

## 技術スタック

- **フロントエンド**: HTML5, Tailwind CSS, Vanilla JavaScript, Google Identity Services
- **バックエンド**: Cloudflare Workers
- **データベース**: Cloudflare D1 (SQLite)

## ローカル開発環境の起動

```bash
# 依存関係のインストール（初回のみ）
npm install

# ローカルD1データベースのマイグレーション適用
npm run migrate:local

# ローカル開発サーバーの起動 (http://localhost:8787)
npm run dev
```

> **Note**: 開発環境では `DEV_MODE=true` が有効になっており、Google Client ID が未設定の場合でも「デモユーザーとしてログイン」ボタンからすぐにユーザー機能（教材の追加・編集・削除・ユーザー間データ分離）をテスト可能です。

## 本番環境（Cloudflare Workers + D1）のデプロイ手順

### 1. Cloudflare D1 データベースの作成

```bash
# D1 データベースを作成
npx wrangler d1 create lingua_studio_db
```

出力された `database_id` を `wrangler.json` の `d1_databases` に設定します：

```json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "lingua_studio_db",
    "database_id": "<取得したUUID>",
    "migrations_dir": "migrations"
  }
]
```

リモートデータベースにマイグレーションを適用します：

```bash
npm run migrate:remote
```

### 2. Google OAuth 2.0 クライアントの設定

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスし、プロジェクトを作成または選択します。
2. 「APIとサービス」 > 「認証情報」 > 「認証情報を作成」 > 「OAuth クライアント ID」を選択します。
3. アプリケーションの種類: **ウェブ アプリケーション** を選択します。
4. **承認済みの JavaScript 生成元** に本番URL（および必要に応じて開発URL）を追加します：
   - `https://lingua-studio.sukehisa.workers.dev`
   - `http://localhost:8787`
5. 作成された **クライアント ID** を `wrangler.json` の `vars.GOOGLE_CLIENT_ID` に設定するか、Cloudflare のシークレットとして登録します：

```bash
# wrangler.json またはシークレットに設定
npx wrangler secret put GOOGLE_CLIENT_ID
```

### 3. デプロイ

Cloudflare GitHub 連携により、GitHub リポジトリへ push / PR マージすることで自動デプロイされます。手動デプロイも可能です：

```bash
npm run build
npx wrangler deploy
```
