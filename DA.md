# Dodgeball Australia (DA) brand

Add `"brand": "da"` to a content JSON to use the DA layouts. Output is 1080×1350 PNGs, `carousel.pdf` and `report.json`.

The DA design system is the single source of truth for colours, fonts, logos and scrims. `src/da.js` finds it via
`DA_DESIGN_SYSTEM`, or falls back to iCloud `DesignStuff/DodgeballAustralia/04-Design-System` (then the older `Dodgeball Australia Design System` folder).
This repo holds layout structure only (`templates/da/`). The design system has no social-scale type tokens yet,
so the canvas type scale lives in `templates/da/da.css` as `--da-*`.

```bash
node src/render.js path/to/post.json --output path/to/out
```

## Content format

```json
{
  "brand": "da",
  "title": "Internal name",
  "series": "Footer label, e.g. Pride in Sport · PSI 2026–27 (optional)",
  "pageNumbers": true,
  "theme": "green | black | white (optional; otherwise per-type default)",
  "slides": [
    { "type": "cover", "title": "Have your\nsay.", "label": "optional", "subtitle": "optional", "image": "photo.jpg (optional)", "focus": "object-position, optional" },
    { "type": "title-paragraph", "title": "…", "body": "text or [\"para 1\", \"para 2\"]", "label": "optional", "note": "optional" },
    { "type": "bullets", "title": "…", "items": ["…"], "label": "optional", "note": "optional" },
    { "type": "cta", "title": "…", "qr": "https://exact-url", "stat": { "label": "Survey closes", "value": "18 Dec." }, "body": "optional", "note": "optional" }
  ]
}
```

- Default themes: cover black (photo + scrim), title-paragraph white, bullets green, cta black. Override with `"theme"` on a slide.
- Display type is uppercase. A full stop that ends a display line turns gold (green on white grounds). This is the brand's "3K PLAYERS." device.
- `"rule": false` hides the gold rule under the label; `"pageNumbers": false` hides page numbers.
- The lockup is pinned top-left on every slide: black text on white, full colour on solid black, and all white on green and photos (brand guide pp. 5, 10, 11).

## QR codes

`"qr"` encodes the URL exactly as written. Partner links (e.g. the Pride in Sport survey) must not be altered.
The QR is always black on a white tile so it scans. Decode a render to confirm before posting.

## Photo framing

A cover photo can take a `"photo"` block. The limits keep the photo covering its area, so out-of-range values are clamped with a warning:

```json
"image": "photos/group.jpg",
"photo": { "mode": "band", "zoom": 1.2, "x": 10, "y": 110, "brightness": 1.2 }
```

- `fill` (default): full-bleed. `zoom` 1–2.5 scales about the focus point; `x`/`y` −100 to 100 pan the crop.
- `band`: a landscape photo across the slide on black, faded top and bottom. `zoom` is width × canvas; `x` shifts it as a % of canvas width (limited so no black edge shows); `y` is the top offset in px.
- `brightness` 0.7–1.4. Without `"photo"`, the older `"focus"` (object-position) still works.

## da-design-check

Every DA render runs the `design-check` skill with the DA profile and saves `design-check.json` beside the images. Must-fix issues set `ok: false` and exit code 2, but the images are still written. If the skill isn't installed, the render finishes with a "did not run" warning, which is not a pass. Set `DESIGN_CHECK_SCRIPT` to use a different copy.

## Automatic checks (report.json)

- Content overflowing its box: exit code 2. Cut copy or split the slide (no auto-shrink).
- Text under 24px, WCAG AA contrast, and hard-coded colours in templates (use tokens; mark exceptions `allow-hardcoded`).
- Text over a photo can't be contrast-checked automatically and is listed as "check by eye".
