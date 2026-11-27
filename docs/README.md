# Docs: Images and Diagrams

> **Every image the READMEs and the site use, and the sources that draw them.**

## Files

| File | What it is | Used in |
|---|---|---|
| `logo.svg` | The Leash mark: a mint rounded square with a handle loop, a lead and a snap clip | Same drawing as `frontend/src/Mark.tsx` and `frontend/public/favicon.svg` |
| `wordmark-dark.png`, `wordmark-light.png` | The mark plus "leash" in Poppins 800 and the tagline; light text for GitHub's dark mode, dark text for light mode | The root README's header, inside `<picture>` |
| `hero.png` | A screenshot of the landing page's hero | Kept for sharing; no README embeds it now |
| `diagrams/leash.png`, `.svg` | The whole system: who acts, the hook's parts, Uniswap v4, the app | Root README, header |
| `diagrams/leash-architecture.excalidraw` | The same system as an editable Excalidraw scene: open it at excalidraw.com (File › Open) | Slides, talks, edits by hand |
| `diagrams/src/` | The sources: `leash.html` and `wordmark.html`, `lib.js` (rough.js shapes), the Excalifont and Virgil fonts, and `render.mjs` | Re-render after any change |

The README's other three diagrams (the life of a mandate, where the money can go, the mispricing attack) are Mermaid blocks in [`../README.md`](../README.md), rendered by GitHub. Edit them there.

## Re-rendering

Each page draws an SVG (rough.js for the diagram). `render.mjs` serves `docs/diagrams/src/`, opens the page in headless Chrome, screenshots it at 2x and, for the diagram, saves the SVG with its fonts embedded.

```bash
node docs/diagrams/src/render.mjs leash.html docs/diagrams/leash.png docs/diagrams/leash.svg
node docs/diagrams/src/render.mjs wordmark.html docs/wordmark-dark.png --transparent   # see wordmark.html for the light variant
```

It needs Google Chrome at `/Applications/Google Chrome.app`. Open the PNG after rendering: the script reports text that overflows its box, but not arrows that point the wrong way.
