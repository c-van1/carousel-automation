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
  "size": "post | story | square(可省略,預設 post)",
  "style": "green | band(可省略,預設 green)",
  "bandRight": "band 頁首條右邊的字,如「全店五折」(可省略)",
  "prices": "prices.json(用了 sku 才需要)",
  "promo": { "discount": 0.5 },
  "slides": [
    { "type": "cover", "title": "…", "subtitle": "…", "image": "可省略" },
    { "type": "title-paragraph", "title": "…", "body": "…", "image": "可省略" },
    { "type": "numbered", "title": "…", "intro": "可省略", "items": ["…", "…"], "note": "可省略" },
    { "type": "bullets", "title": "…", "items": ["…"], "note": "可省略" },
    { "type": "statement", "text": "一句話", "note": "可省略" },
    { "type": "product", "sku": "R1030", "name": "標題,可省略(省略用 Odoo 產品名)", "meta": "30 ml(可省略)", "image": "去背圖", "badge": true, "body": "可省略" },
    { "type": "products", "title": "…", "body": "可省略", "join": "plus | steps | none",
      "items": [ { "sku": "R1007", "image": "去背圖", "label": "可省略,如「先用」" }, { "sku": "R1030", "image": "…" } ],
      "total": "可省略;plus、steps 預設顯示合共", "totalLabel": "可省略,兩款預設「兩款合共」", "totalNote": "可省略" },
    { "type": "end", "cta": "可省略,預設用定稿結尾卡原字" }
  ]
}
```

- 頁數由 `slides` 決定,沒有固定頁數。
- 每頁可用 `"chip"` 覆寫系列標籤,`"chip": false` 隱藏。
- 可省略的欄位沒有內容就整塊不出現;`image` 找不到時改用無相片版本並記入 `report.json`。
- 正文放不下會自動縮字(下限 34px);仍放不下則回報超字,結束碼為 2。

## 尺寸

- `post`:1080×1350(4:5,預設)。
- `story`:1080×1920(9:16),頂部 250px、底部 340px 留作平台介面安全區,文字不會放進去。
- `square`:1080×1080(1:1),字級與相片高度自動收細。
- 高度取自設計系統 `--social-h`、`--social-h-reel`、`--social-h-square`。
- 設計系統只有 4:5 結尾卡;story、square 的 end 頁以綠底置中顯示並在 report 提示,自訂 `cta` 會被忽略。

## 樣式

- `green`:綠底、淺綠圓形裝飾、左上 chip(原有樣式)。
- `band`:米白頁首條。米白底、頂部綠色頁首條(左邊是 chip 文字,右邊是 `bandRight`)、綠色標題、淺鼠尾草面板;封面上半綠色大標題區。由全店五折 Post2 提煉,顏色全部用設計系統 token。
- 整份用 `"style"` 設定,單頁可用 `"style"` 覆寫(例如 band 系列中插一頁 green)。
- 每頁可加 `"footnote"`(左下小字,如「先說清楚:……」)。

## 價錢與折扣徽章

- 價錢不寫在內容 JSON。產品頁寫 `"sku"`,數字由 `"prices"` 價錢檔提供;價錢檔由 Hermes 從 Odoo 匯出:
  `python3 tools/sku_prices.py R1030 R1004 -o <資料夾>/prices.json`(Hermes repo,唯讀)。
- 價錢檔沒有該 SKU、或用了 sku 卻沒指定價錢檔,一律中止出圖,不會猜價錢。
- `"promo": { "discount": 0.5 }`:discount 是減去的比例,0.5 = 五折(50% OFF),0.2 = 八折(20% OFF)。
  折後價 = 原價 ×(1 − discount),非整數會四捨五入並在 report 提示。原價刪線顯示。
- 貨幣符號預設 `HK$`(跟設計系統 PriceTag 一致),可用 `"currency"` 改。
- 徽章:8 瓣花形(`templates/jsk/flower.svg`,由品牌花形 PNG 量度重繪,待併入設計系統),米白底綠字。
  有 promo 時封面自動顯示;產品頁要 `"badge": true`;任何頁 `"badge": false` 隱藏。
  徽章字由 discount 計出,可用 `promo.badgeTop` / `promo.badgeBottom` 覆寫。

## 多產品陳列(products)

- 1 至 5 款並排在淺鼠尾草面板,每款下面是價錢(由 sku 對價錢檔),最後一列是合共(程式加總,不手寫)。
- `join`:`plus` 兩款之間加號(搭配使用)、`steps` 加 1、2 圓點與箭咀(使用次序)、`none` 只並排(如補貨頁,預設)。
- 5 款時不顯示產品名,只顯示價錢;字級按款數自動收細。放不下會回報超字,請刪字、減少產品或分頁。
