/* Hue Tap stats HUD — a self-contained add-on (Borgo).
 * Include after the game's main <script>:  <script src="hud.js"></script>
 * It only READS window.__hue; it never writes game state, and its overlay is
 * pointer-events:none, so it can't steal taps, gestures or corner-dot drags.
 * Shows: the dominant colour (area-weighted) as a swatch + name + share, a
 * stacked bar of the top colours, and counts of hunters, chasers and circles.
 * Debug/test handle: window.__hueHud = { stats, config, start(), stop(), update() }.
 */
(function () {
  'use strict';
  if (window.__hueHud) return;                       // never load twice

  // ---- Adapter: the only place that knows the game's field names. ----------
  // Tweak here if window.__hue changes. Each getter must tolerate missing data.
  const A = {
    root:     () => window.__hue,
    circles:  (h) => h.circles,                      // array, mutated in place by the game
    hunters:  (h) => h.hunters,                      // red; count = length
    chasers:  (h) => h.chasers,                      // blue "seekers"; count = length
    emitters: (h) => h.dots,                         // black emitter dots
    hueOf:    (c) => c.hue,                          // white circles have no hue -> skipped
    radiusOf: (c) => c.r,                            // screen px (also present on {big:true} circles)
  };

  // ---- Config ---------------------------------------------------------------
  const config = {
    updateMs: 250,          // recompute stats ~4x per second
    weight: 'area',         // 'area' (pi r^2, capped at one screenful) or 'count'
    topN: 4,                // colours shown in the stacked bar
    showEmitters: false,    // add a black-dot emitter count
    margin: 10,             // px from the top-right safe-area corner
  };

  // 12 named 30-degree bins centred on 0, 30, 60 ... (hue h -> bin round(h/30) % 12)
  const NAMES = ['Red', 'Orange', 'Yellow', 'Lime', 'Green', 'Mint',
                 'Cyan', 'Sky', 'Blue', 'Violet', 'Magenta', 'Pink'];
  const NB = NAMES.length, BIN = 360 / NB;
  const wSum = new Float64Array(NB), cSum = new Float64Array(NB), sSum = new Float64Array(NB);
  const nSum = new Uint32Array(NB);
  const D2R = Math.PI / 180;

  // ---- DOM -------------------------------------------------------------------
  const css = `
#huehud{position:fixed;z-index:2147483000;pointer-events:none;
  top:calc(${config.margin}px + env(safe-area-inset-top,0px));right:calc(${config.margin}px + env(safe-area-inset-right,0px));
  width:108px;box-sizing:border-box;padding:7px 9px 7px;border-radius:14px;background:rgba(0,0,0,.34);
  color:#fff;font:600 12px/1.15 -apple-system,system-ui,Roboto,sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.5);
  -webkit-user-select:none;user-select:none;opacity:0;transition:opacity .3s;contain:layout paint}
#huehud.on{opacity:.92}
#huehud *{pointer-events:none}
#huehud .row{display:flex;align-items:center;gap:5px;white-space:nowrap}
#huehud .sw{flex:none;width:14px;height:14px;border-radius:50%;border:1.5px solid rgba(255,255,255,.9);box-sizing:border-box;background:transparent}
#huehud .nm{flex:1;overflow:hidden;text-overflow:ellipsis}
#huehud .pc{flex:none;opacity:.8;font-weight:500;font-size:11px}
#huehud .bar{display:flex;height:5px;margin:5px 0 6px;border-radius:3px;overflow:hidden;background:rgba(255,255,255,.18)}
#huehud .bar i{display:block;height:100%}
#huehud .cnt{justify-content:space-between;font-size:12px;font-variant-numeric:tabular-nums}
#huehud .cnt span{display:flex;align-items:center;gap:3px}
#huehud .dot{width:8px;height:8px;border-radius:50%;box-sizing:border-box;border:1px solid rgba(255,255,255,.85)}
#huehud .dot.r{background:#e8322e}#huehud .dot.b{background:#2e6be8}#huehud .dot.k{background:#000}
#huehud .dot.c{background:transparent;border:1.5px solid #fff}
.muted #huehud .dot.r{background:#f2968c}.muted #huehud .dot.b{background:#8cb2f0}.muted #huehud .dot.k{background:#464a50}`;

  let root = null, el = {};
  function build() {
    if (root || !document.body) return !!root;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'huehud'; root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<div class="row"><span class="sw"></span><span class="nm">–</span><span class="pc"></span></div>' +
      '<div class="bar"></div>' +
      '<div class="row cnt">' +
        '<span title="hunters"><i class="dot r"></i><b class="nh">0</b></span>' +
        '<span title="chasers"><i class="dot b"></i><b class="nc">0</b></span>' +
        '<span title="emitters" class="em" style="display:none"><i class="dot k"></i><b class="ne">0</b></span>' +
        '<span title="circles"><i class="dot c"></i><b class="nt">0</b></span>' +
      '</div>';
    document.body.appendChild(root);
    const q = (s) => root.querySelector(s);
    el = { sw: q('.sw'), nm: q('.nm'), pc: q('.pc'), bar: q('.bar'), nh: q('.nh'), nc: q('.nc'),
           ne: q('.ne'), nt: q('.nt'), em: q('.em') };
    return true;
  }

  // ---- Stats -----------------------------------------------------------------
  const len = (a) => (a && typeof a.length === 'number') ? a.length : null;
  const stats = { ok: false, hunters: 0, chasers: 0, emitters: 0, circles: 0, coloured: 0,
                  dominant: null, top: [], computeMs: 0, updates: 0 };

  function compute() {
    const t0 = performance.now();
    const h = A.root();
    const circles = h && A.circles(h);
    if (!h || len(circles) === null) { stats.ok = false; return stats; }
    wSum.fill(0); cSum.fill(0); sSum.fill(0); nSum.fill(0);
    const cap = Math.max(1, innerWidth * innerHeight), byArea = config.weight !== 'count';
    let total = 0, coloured = 0;
    for (let i = 0, n = circles.length; i < n; i++) {
      const c = circles[i]; if (!c) continue;
      const hue = A.hueOf(c);
      if (typeof hue !== 'number' || hue !== hue) continue;      // white / unknown: skip
      let w = 1;
      if (byArea) { const r = +A.radiusOf(c) || 0; w = Math.PI * r * r; if (w > cap) w = cap; }
      if (!(w > 0)) continue;
      const hh = ((hue % 360) + 360) % 360, b = Math.round(hh / BIN) % NB, a = hh * D2R;
      wSum[b] += w; cSum[b] += Math.cos(a) * w; sSum[b] += Math.sin(a) * w; nSum[b]++;
      total += w; coloured++;
    }
    const order = [];
    for (let b = 0; b < NB; b++) if (wSum[b] > 0) order.push(b);
    order.sort((x, y) => wSum[y] - wSum[x]);
    stats.top = order.slice(0, config.topN).map((b) => {
      let mean = Math.atan2(sSum[b], cSum[b]) / D2R; if (mean < 0) mean += 360;   // weighted circular mean
      return { bin: b, name: NAMES[b], hue: Math.round(mean) % 360, share: wSum[b] / total, n: nSum[b] };
    });
    stats.dominant = stats.top[0] || null;
    stats.circles = circles.length; stats.coloured = coloured;
    stats.hunters = len(A.hunters(h)) || 0; stats.chasers = len(A.chasers(h)) || 0;
    stats.emitters = len(A.emitters(h)) || 0;
    stats.ok = true; stats.updates++;
    stats.computeMs = performance.now() - t0;
    return stats;
  }

  // ---- Render (only touches the DOM when something changed) -----------------
  let shown = '';
  // v40: pastel when the game's muted theme is on (<html class="muted">)
  const isMuted = () => document.documentElement.classList.contains('muted');
  const col = (h) => isMuted() ? `hsl(${h},45%,78%)` : `hsl(${h},70%,55%)`;
  function render() {
    if (!stats.ok) { if (root) root.classList.remove('on'); shown = ''; return; }
    const d = stats.dominant;
    const key = [d ? d.hue + d.name + Math.round(d.share * 100) : '-', stats.top.map((t) => t.bin + ':' + Math.round(t.share * 100)).join(','),
                 stats.hunters, stats.chasers, stats.emitters, stats.circles, config.showEmitters, isMuted()].join('|');
    if (key !== shown) {
      shown = key;
      el.sw.style.background = d ? col(d.hue) : 'transparent';
      el.nm.textContent = d ? d.name : 'No colour';
      el.pc.textContent = d ? Math.round(d.share * 100) + '%' : '';
      el.bar.innerHTML = stats.top.map((t) => `<i style="width:${(t.share * 100).toFixed(1)}%;background:${col(t.hue)}"></i>`).join('');
      el.nh.textContent = stats.hunters; el.nc.textContent = stats.chasers; el.nt.textContent = stats.circles;
      el.ne.textContent = stats.emitters; el.em.style.display = config.showEmitters ? '' : 'none';
    }
    root.classList.add('on');
  }

  // ---- Loop: rAF, throttled; waits patiently for __hue to appear ------------
  let running = false, last = -1e9, raf = 0;
  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (now - last < config.updateMs) return;
    last = now;
    try { if (build()) { compute(); render(); } }
    catch (e) { stats.ok = false; if (root) root.classList.remove('on'); }
  }
  function start() { if (!running) { running = true; last = -1e9; raf = requestAnimationFrame(tick); } }
  function stop() { running = false; cancelAnimationFrame(raf); if (root) root.classList.remove('on'); }
  function update() { if (build()) { compute(); render(); } return stats; }

  window.__hueHud = { stats, config, adapter: A, names: NAMES, start, stop, update };
  start();
})();
