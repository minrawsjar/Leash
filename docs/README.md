# Docs: Images and Diagrams

> **Every image the READMEs and the site use, and the source that draws the wordmark.**

## Files

| File | What it is | Used in |
|---|---|---|
| `logo.svg` | The Leash mark: a mint rounded square with a handle loop, a lead and a snap clip | Same drawing as `frontend/src/Mark.tsx` and `frontend/public/favicon.svg` |
| `wordmark-dark.png`, `wordmark-light.png` | The mark plus "leash" in Poppins 800 and the tagline; light text for GitHub's dark mode, dark text for light mode | The root README's header, inside `<picture>` |
| `hero.png` | A screenshot of the landing page's hero | Kept for sharing; no README embeds it now |
| `src/wordmark.html`, `src/render.mjs` | The page that draws the wordmark, and the script that renders it to PNG | Re-render after any change |

The README's four diagrams (the system, the life of a mandate, where the money can go, the mispricing attack) are Mermaid blocks in [`../README.md`](../README.md), rendered by GitHub. Edit them there.

## Re-rendering the wordmark

`render.mjs` serves `docs/src/`, opens the page in headless Chrome and screenshots it at 2x.

```bash
node docs/src/render.mjs wordmark.html docs/wordmark-dark.png --transparent   # see wordmark.html for the light variant
```

It needs Google Chrome at `/Applications/Google Chrome.app`.
