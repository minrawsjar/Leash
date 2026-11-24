# Docs: README Images

> **Two image files used by the top-level README.**

This folder holds the images the repository's [`../README.md`](../README.md) embeds. Nothing in the build reads from it.

## Files

| File | Format | Used in | What it shows |
|---|---|---|---|
| [`logo.svg`](logo.svg) | SVG, 64x64 viewBox | `README.md` line 1, at `width="64"` | The Leash mark: a handle loop, a slack lead and a snap clip, dark strokes (`#0b0d1f`) on a rounded mint square (`#4ef0b0`) |
| [`hero.png`](hero.png) | PNG, 1440 x 900, about 200 KB | `README.md` line 9 | A screenshot of the landing page: the headline "Keep the leash." beside a live mandate chart, price and TWAP inside the range, with the bond on the line |

## Copies Elsewhere

- `frontend/public/favicon.svg` is a byte-identical copy of `logo.svg`, served as the app's favicon by `frontend/index.html`. Change both together.
- The landing page itself does not load `hero.png`; the screenshot is only for the README. The live page is in [`../frontend/`](../frontend/README.md).
