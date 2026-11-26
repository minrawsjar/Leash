// Tiny Excalidraw-look drawing helper on top of rough.js. Each diagram page calls sketch(...),
// draws with box/panel/arrow/text, then done(). render.mjs screenshots it and saves the SVG.
const KINDS = {
  mint: ['#d9fbec', '#1fbf86'],
  mintStrong: ['#a8f2d2', '#1fbf86'],
  violet: ['#ece9ff', '#7a68f0'],
  rose: ['#ffe3ec', '#e0457a'],
  grey: ['#f1f2f6', '#4b4f63'],
  plain: ['#ffffff', '#1e1e1e'],
};
const INK = '#1e1e1e', SUB = '#5b5f73', FONT = 'Excali, Virgil, cursive';
const NS = 'http://www.w3.org/2000/svg';

function sketch({ w, h, title, sub }) {
  window.__warnings = [];
  const root = document.getElementById('root');
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'd';
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  root.appendChild(svg);
  const bg = document.createElementNS(NS, 'rect');
  Object.entries({ width: w, height: h, fill: '#ffffff' }).forEach(([k, v]) => bg.setAttribute(k, v));
  svg.appendChild(bg);
  const shapes = document.createElementNS(NS, 'g'), labels = document.createElementNS(NS, 'g');
  svg.append(shapes, labels);
  const rc = rough.svg(svg);
  let seed = 7;
  const opts = (o) => ({ roughness: 1, bowing: 1, strokeWidth: 1.7, seed: seed++, ...o });

  const textEl = (x, y, str, { size = 16, color = INK, anchor = 'start', parent = labels } = {}) => {
    const t = document.createElementNS(NS, 'text');
    Object.entries({ x, y, 'font-size': size, fill: color, 'text-anchor': anchor, 'font-family': FONT }).forEach(([k, v]) => t.setAttribute(k, v));
    t.textContent = str;
    parent.appendChild(t);
    return t;
  };
  const rr = (x, y, w, h, r) => `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;

  const api = {
    text: (x, y, str, o = {}) => String(str).split('\n').map((l, i) => textEl(x, y + i * (o.size || 16) * 1.3, l, o)),
    box(x, y, w, h, str, kind = 'plain', o = {}) {
      const [fill, stroke] = KINDS[kind];
      shapes.appendChild(rc.path(rr(x, y, w, h, Math.min(16, h / 4)), opts({ fill, stroke, fillStyle: 'solid', strokeLineDash: o.dashed ? [8, 7] : undefined, strokeWidth: o.strong ? 2.6 : 1.7 })));
      const size = o.size || 16, lines = String(str).split('\n'), lh = size * 1.32;
      const y0 = y + h / 2 - ((lines.length - 1) * lh) / 2 + size * 0.34;
      lines.forEach((l, i) => {
        const left = o.align === 'left';
        const t = textEl(left ? x + 16 : x + w / 2, y0 + i * lh, l, { size: i === 0 && o.head ? size + 2 : size, anchor: left ? 'start' : 'middle' });
        if (t.getComputedTextLength() > w - 20) window.__warnings.push(`overflow: "${l}" ${Math.round(t.getComputedTextLength())} > ${w - 20}`);
      });
      if (lines.length * lh > h - 8) window.__warnings.push(`tall: "${lines[0]}"`);
    },
    panel(x, y, w, h, label, kind = 'plain', o = {}) {
      const [fill, stroke] = KINDS[kind];
      shapes.appendChild(rc.path(rr(x, y, w, h, 18), opts({ fill: o.fill || (kind === 'plain' ? '#ffffff' : fill), stroke, fillStyle: 'solid', strokeWidth: 1.9 })));
      if (label) {
        const t = textEl(x + 16, y + 28, label, { size: o.size || 17, color: INK });
        if (t.getComputedTextLength() > w - 30) window.__warnings.push(`panel overflow: "${label}"`);
      }
    },
    arrow(pts, o = {}) {
      const color = o.color || INK;
      const line = rc.linearPath(pts, opts({ stroke: color, strokeWidth: 1.7, roughness: 0.7, strokeLineDash: o.dashed ? [8, 7] : undefined }));
      shapes.appendChild(line);
      const head = (a, b) => {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 15;
        for (const s of [-1, 1]) {
          const p = [b[0] - L * Math.cos(ang + s * 0.45), b[1] - L * Math.sin(ang + s * 0.45)];
          shapes.appendChild(rc.line(b[0], b[1], p[0], p[1], opts({ stroke: color, strokeWidth: 1.7, roughness: 0.5 })));
        }
      };
      head(pts[pts.length - 2], pts[pts.length - 1]);
      if (o.both) head(pts[1], pts[0]);
      if (o.label) {
        let lx = o.lx, ly = o.ly;
        if (lx === undefined) { const [a, b] = [pts[0], pts[1]]; lx = (a[0] + b[0]) / 2; ly = (a[1] + b[1]) / 2; }
        const size = o.size || 15, lines = o.label.split('\n');
        const g = document.createElementNS(NS, 'g');
        labels.appendChild(g);
        const ts = lines.map((l, i) => textEl(lx, ly + size * 0.34 + (i - (lines.length - 1) / 2) * size * 1.25, l, { size, anchor: 'middle', parent: g, color: o.labelColor || INK }));
        const bb = g.getBBox();
        const r = document.createElementNS(NS, 'rect');
        Object.entries({ x: bb.x - 4, y: bb.y - 1, width: bb.width + 8, height: bb.height + 2, fill: '#ffffff' }).forEach(([k, v]) => r.setAttribute(k, v));
        g.insertBefore(r, ts[0]);
      }
    },
    async done() {
      await document.fonts.ready;
      window.__done = true;
    },
  };
  textEl(32, 54, title, { size: 32 });
  if (sub) api.text(32, 88, sub, { size: 17, color: SUB });
  return api;
}

const b64 = async (url) => { const buf = new Uint8Array(await (await fetch(url)).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); };
window.__svg = async () => {
  const svg = document.getElementById('d').cloneNode(true);
  const style = document.createElementNS(NS, 'style');
  style.textContent = `@font-face{font-family:Excali;src:url(data:font/woff2;base64,${await b64('Excalifont.woff2')}) format("woff2")}@font-face{font-family:Virgil;src:url(data:font/woff2;base64,${await b64('Virgil.woff2')}) format("woff2")}`;
  svg.insertBefore(style, svg.firstChild);
  return new XMLSerializer().serializeToString(svg);
};
