# icon

- 正本: `icon.svg`（正式のアイコン。1024×1024 の viewBox）。
- 書き出し: `icon-512.png`（512×512。mcpb の manifest の `icon` など）、`social-preview-1280x640.png`（GitHub の social preview。1280×640。明るい背景の中央にアイコンを置く）。
- 書き出し直すときは、`icon.svg` から同じ大きさで書き出す（例: `rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png`）。
- Claude・Anthropic のロゴ（放射状の線・星形）に似せない。
