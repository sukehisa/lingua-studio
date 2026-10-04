# LinguaStudio 教材カタログアセット管理ガイド

このディレクトリは、LinguaStudio の教材（中国語・英語の対訳コンテンツ）アセットを管理するディレクトリです。  
**AI Skill やエージェントが新しい教材を追加する際の手順** と **データスキーマ** について説明します。

---

## 1. 構成概要

```
data/
├── materials/                  # 各教材の個別JSONファイル
│   ├── manifest.json           # 教材ファイル一覧（自動生成または手動更新）
│   ├── sample-1.json           # カフェでの注文と会話
│   ├── sample-2.json           # 習慣と生活リズム
│   └── sample-3.json           # ビジネス提携の協議
├── catalog.js                  # オフライン & file:// プロトコル用バンドルファイル
└── README.md                   # 本ドキュメント
```

- **HTTP/HTTPS またはローカルサーバー（Live Server等）実行時**: `data/materials/manifest.json` および各教材 JSON を動的に読み込みます。
- **直接ファイルを開いた場合（`file:///.../index.html`）**: CORS 制限に対応するため、バンドルファイル `data/catalog.js` から教材を読み込みます。

---

## 2. AI Skill による新しい教材の追加手順

AI Skill（エージェント）が教材を 1 つ追加する手順は以下の **2 ステップ** です。

### ステップ 1: 新しい教材 JSON を作成する
`data/materials/{固有のファイル名}.json` を作成します（例: `data/materials/airport-checkin.json`）。

### ステップ 2: カタログを同期する
以下のいずれかのコマンドを 1 回実行します（マニフェストと catalog.js が自動更新されます）：

```bash
# Node.js 環境の場合
node scripts/sync-catalog.js

# または Python 環境の場合
python3 scripts/sync-catalog.py
```

> **Note**: コマンド実行ができない環境の場合でも、`data/materials/manifest.json` の配列に `"airport-checkin.json"` を追加するだけで HTTP 実行環境では即座に認識されます。

---

## 3. 教材 JSON スキーマ仕様

教材ファイルは純粋な JSON 形式です。

### 必須フィールド & 任意フィールド

| フィールド名 | 型 | 必須 | 説明 | 例 |
|---|---|:---:|---|---|
| `id` | `string` | **必須** | 一意の教材ID（英数字・ハイフン推奨） | `"travel-airport-checkin"` |
| `title` | `string` | **必須** | 中国語タイトル（日本語補足をつけても可） | `"机场办理登机手续 (空港でのチェックイン)"` |
| `titleEn` | `string` | **必須** | 英語タイトル | `"Airport Check-in and Boarding"` |
| `tag` | `string` | **必須** | カテゴリー・タグ | `"日常会話"` / `"ビジネス"` / `"HSK4"` / `"HSK5"` / `"旅行"` など |
| `chinese` | `string` | **必須** | 中国語本文（句読点 `。` `！` `？` 等で自動的にセンテンス分割されます） | `"您好，我要办理登机手续。请出示您的护照和机票。"` |
| `english` | `string` | **必須** | 英語本文（ピリオド `.` `!` `?` 等で自動的にセンテンス分割されます） | `"Hello, I would like to check in. Please show your passport and ticket."` |
| `translation` | `string` | 任意 | 日本語対訳 | `"こんにちは、チェックインをお願いします。パスポートと航空券をご提示ください。"` |
| `createdAt` | `string` | 任意 | 作成日（YYYY-MM-DD） | `"2026-10-04"` |

### JSON テンプレート例

```json
{
  "id": "hotel-checkin",
  "title": "酒店入住与退房 (ホテルのチェックインとチェックアウト)",
  "titleEn": "Hotel Check-in and Check-out",
  "tag": "旅行",
  "chinese": "您好，我预订了一间大床房，这是我的预订确认单。好的，请出示您的身份证件。请问房间包含早餐吗？是的，早餐在二楼餐厅，时间是早上七点到十点。这是您的房卡，电梯在左手边。",
  "english": "Hello, I have booked a double room. Here is my reservation confirmation. Sure, please show me your ID. Does the room include breakfast? Yes, breakfast is at the restaurant on the second floor, from 7 AM to 10 AM. Here is your room keycard, the elevator is on your left.",
  "translation": "こんにちは、ダブルルームを予約しています。こちらが予約確認書です。かしこまりました、身分証明書をご提示ください。お部屋に朝食は付いていますか？はい、2階のレストランで朝7時から10時までご利用いただけます。こちらがルームキーです、エレベーターは左手にございます。",
  "createdAt": "2026-10-04"
}
```

---

## 4. 作成時のベストプラクティス (AI Skill 向け指示)

1. **センテンスの対応関係**: 中国語のセンテンス数と英語のセンテンス数を揃えると、リスニングとスピーキングの切り替え時に文単位の同期がスムーズになります。
2. **句読点**:
   - 中国語は全角の `。` `！` `？` で区切る。
   - 英語は半角の `.` `!` `?` の後にスペースを設けて区切る。
3. **タグの統一性**: UI フィルターに標準で用意されているタグ（`日常会話`, `ビジネス`, `HSK4`, `HSK5`）または新しいカテゴリー名を設定してください。
