# Extension Icons

This directory needs PNG icon files for the Chrome extension:

- `icon-16.png`  - 16x16 pixels (toolbar)
- `icon-32.png`  - 32x32 pixels (Windows taskbar)
- `icon-48.png`  - 48x48 pixels (extensions page)
- `icon-128.png` - 128x128 pixels (Chrome Web Store)

## Quick Generation

Run this from the `chrome-extension` directory to generate placeholder icons
using ImageMagick (if installed):

```bash
for size in 16 32 48 128; do
  convert -size ${size}x${size} xc:"#4a6cf7" \
    -gravity center -fill white -pointsize $((size/3)) \
    -annotate 0 "MCP" \
    icons/icon-${size}.png
done
```

Or use any image editor to create icons with:
- Background: #4a6cf7 (blue)
- Foreground: white
- Text/symbol: slides/presentation icon

## Using the inline-generated icons

The `generate-icons.js` script in this directory can generate minimal valid PNG
icons without any external dependencies. Run it with Node.js:

```bash
node icons/generate-icons.js
```
