# 肌本 (Just Skincare) 版型

內容 JSON 加 `"brand": "jsk"` 即使用肌本版型,出 1080×1350 PNG、PDF 與 `report.json`。

設計系統是唯一的事實來源:顏色、字型、Logo、結尾卡都從
`Just Skincare Design System/` 讀取(位置見 `src/jsk.js` 的 `findDesignSystem`,
可用環境變數 `JSK_DESIGN_SYSTEM` 指定)。本 repo 只存版面結構。
`templates/jsk/jsk.css` 頂部的 `--jsk-*` 呼吸感數值待併入設計系統 `tokens/social.css`。

```bash
node src/render.js path/to/deck.json --output path/to/out
```

## 內容格式

```json
{
  "brand": "jsk",
  "title": "#14 Argireline是什麼",
  "series": "認識護膚成分 ・ #14",
  "pageNumbers": true,
  "slides": [
    { "type": "cover", "title": "…", "subtitle": "…", "image": "可省略" },
    { "type": "title-paragraph", "title": "…", "body": "…", "image": "可省略" },
    { "type": "numbered", "title": "…", "intro": "可省略", "items": ["…", "…"], "note": "可省略" },
    { "type": "bullets", "title": "…", "items": ["…"], "note": "可省略" },
    { "type": "statement", "text": "一句話", "note": "可省略" },
    { "type": "product", "name": "…", "meta": "HK$688 ・ 30 ml", "image": "去背圖", "body": "可省略" },
    { "type": "end", "cta": "可省略,預設用定稿結尾卡原字" }
  ]
}
```

- 頁數由 `slides` 決定,沒有固定頁數。
- 每頁可用 `"chip"` 覆寫系列標籤,`"chip": false` 隱藏。
- 可省略的欄位沒有內容就整塊不出現;`image` 找不到時改用無相片版本並記入 `report.json`。
- 正文放不下會自動縮字(下限 34px);仍放不下則回報超字,結束碼為 2。
