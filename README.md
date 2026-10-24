# NekoBrief

透過 [LINE.js 機器人 API `/api/ws`](https://github.com/JS-PACKAGE/LINE.js#機器人-apiapiws) 紀錄指定聊天室的文字訊息到 SQLite（`chatlog.db`），每小時以 Claude 依話題整理摘要，並以網頁 `/{聊天室ID}/{年月日}` 瀏覽。

## 啟動

需要 Node.js ≥ 22.13（使用內建 `node:sqlite`）、已啟用機器人 API 的 LINE.js，以及 Anthropic API key。

1. 在 LINE.js 的 `config.yaml` 設定 `api.enabled: true`，把聊天室 ID 加入 `api.chats` 後重啟；在 LINE.js 專案目錄執行 `npm run cli -- token` 取得 Bearer Token。
2. 複製 `config.example.yaml` 為 `config.yaml`，填入 `line.token`、`line.chats`、`claude.apiKey`，並執行 `chmod 600 config.yaml`。
3. 啟動：

```sh
./start.sh --check   # 只檢查本機設定
./start.sh
```

`start.sh` 會在依賴缺少時以 lockfile 安裝、編譯後啟動；`--config 路徑` 可指定其他設定檔。

## 設定

| 欄位 | 用途 |
| --- | --- |
| `line.url` | LINE.js `/api/ws`，預設 `ws://127.0.0.1:3789/api/ws`；非本機須用 `wss://` |
| `line.token` | LINE.js 產生的 Bearer Token |
| `line.chats` | 要紀錄與摘要的聊天室，格式為 `聊天室ID: 顯示名稱`；ID 須同時列在 LINE.js `api.chats`，顯示名稱會出現在網頁上方 |
| `claude.apiKey` | Anthropic API key |
| `claude.model` | 摘要模型，省略時為 `claude-haiku-5-5` |
| `claude.maxOutputTokens` | 每次摘要輸出上限，預設 4096 |
| `claude.timeoutMs` | 每次摘要請求逾時，預設 120000 |
| `web.host`／`web.port` | 網頁監聽位址，預設 `127.0.0.1:6181`；對外以反向代理提供 `nekobrief.yustellar.dev` |
| `timezone` | IANA 時區，決定紀錄時間、整點與「今天」；省略時使用系統時區 |

## 紀錄

資料庫固定為設定檔旁的 `chatlog.db`。`messages` 資料表依序為 `sent_at`（日期時間，設定時區的 `YYYY-MM-DD HH:MM:SS`）、`chat_id`（聊天室 ID）、`sender_id`（發言者 ID）、`text`（聊天內容），另有去重用的 `message_id`、摘要狀態 `summarized` 與所屬主題 `topic_id`。

- 只紀錄 `line.chats` 內的即時文字訊息（包含自己發的）；貼圖、圖片等非文字內容與無法解密的訊息不紀錄。
- 編輯會更新內容；收回會刪除該筆紀錄。已產生的摘要不會因此改寫。
- LINE.js 不重播舊訊息，NekoBrief 斷線或停止期間的訊息不會補紀錄。

## 摘要

啟動時與每個整點過後 5 秒，依序摘要各聊天室「已結束的小時」中尚未摘要的訊息（進行中的小時不處理）。

- 模型依語意把訊息分成主題，每個主題有標題、重點與時間範圍；交錯進行的不同討論分開，無實質內容的閒聊可略過。
- 送給模型的發言者以每批次的匿名代號表示，不送出也不顯示發言者 ID。
- **跨越整點的話題以開始的小時為主**：摘要某小時時，會一併提供前一小時以來仍在進行的主題；延續的訊息併入原主題並延長結束時間，不另開新主題。跨日亦同，主題顯示在開始的那天。
- 單一小時訊息過多時會分成多批（每則最多送出 2000 字），後批可延續前批的主題。
- 摘要失敗（API 錯誤、輸出格式不符等）時該聊天室停在失敗的小時，下個整點重試，確保話題延續的順序正確。

聊天內容會送往 Anthropic，請確認成員同意。

## 網頁

- `/{聊天室ID}`：導向今天；`/{聊天室ID}/{年月日}`，例如 `/c0123…/20261024`。
- 網址最後加上 `.json`（`/{聊天室ID}/{年月日}.json`）會輸出當天的 JSON 檔：聊天室名稱、日期，以及各主題的開始小時、標題、重點、時間範圍與原始對話。發言者同樣只以主題內的序號（`speaker`: 0、1、2…）表示，不含 ID。所有 JSON（含 `/api/…`）都回 `Access-Control-Allow-Origin: *`，任何網站都能直接以 `fetch` 讀取，不限來源網址。
- 上方顯示聊天室名稱，並以大字列出日期（近 30 天，今天固定在最後一格），有摘要的日期下方有圓點；切換日期與瀏覽器上一頁／下一頁都以 History API 變更路徑，不重新載入頁面。
- 以時間軸依開始的小時分組顯示主題、時間範圍與重點；沒有摘要的小時不顯示。
- 每個主題下方可展開「原始對話」，第一次展開時才載入。發言者只以該主題內的 A、B、C… 代號與顏色區分，伺服器不送出發言者 ID；已收回的訊息不會出現。歸為閒聊、未納入任何主題的訊息不顯示。
- 只提供 `line.chats` 內的聊天室，且不列出聊天室清單；但知道聊天室 ID 的人即可瀏覽摘要與原始對話，請自行在反向代理加上需要的存取控制。

## 開發

```sh
npm test
```
