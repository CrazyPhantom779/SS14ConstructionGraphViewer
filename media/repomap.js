// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('mapCanvas');
  const canvasWrap = document.getElementById('mapCanvasWrap');
  const loading = document.getElementById('mapLoading');
  const legend = document.getElementById('mapLegend');
  const statsEl = document.getElementById('mapStats');
  const searchEl = document.getElementById('mapSearch');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let transform = { x: 0, y: 0, k: 1 };
  let sim = null; // { nodes, links, byKey, anchors }

  vscode.postMessage({ type: 'ready' });
  document.getElementById('mapRescanBtn').addEventListener('click', () => {
    loading.classList.remove('hidden');
    loading.textContent = 'Rescanning workspace…';
    vscode.postMessage({ type: 'rescan' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'mapData') {
      loading.classList.add('hidden');
      buildSimulation(msg.index);
      runSimulation();
      render();
      fitToView();
    }
  });

  const CATEGORY_COLORS = [
    '#3794ff', '#4ec9b0', '#e2a03f', '#c586c0', '#b180d7',
    '#f14c4c', '#6a9955', '#569cd6', '#d7ba7d', '#9cdcfe',
  ];
  function colorForCategory(cat) {
    if (!cat) return '#888888';
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
    return CATEGORY_COLORS[h % CATEGORY_COLORS.length];
  }

  function buildSimulation(index) {
    const nodes = [];
    const byKey = new Map();
    const links = [];

    const graphsById = new Map(); // id -> [graph nodes] (could be >1 across files)
    index.constructionGraphs.forEach((g) => {
      const key = `g:${g.file}::${g.id}`;
      const node = {
        key,
        type: 'graph',
        id: g.id,
        file: g.file,
        nodeCount: g.nodeCount,
        category: null, // filled in once we see prototypes referencing it
        x: Math.random() * 800,
        y: Math.random() * 600,
        vx: 0,
        vy: 0,
        r: Math.min(34, 9 + Math.sqrt(g.nodeCount) * 3.2),
      };
      nodes.push(node);
      byKey.set(key, node);
      if (!graphsById.has(g.id)) graphsById.set(g.id, []);
      graphsById.get(g.id).push(node);
    });

    index.constructionPrototypes.forEach((p) => {
      const key = `p:${p.file}::${p.id}`;
      const node = {
        key,
        type: 'proto',
        id: p.id,
        graph: p.graph,
        category: p.category,
        startNode: p.startNode,
        targetNode: p.targetNode,
        file: p.file,
        range: p.range,
        x: Math.random() * 800,
        y: Math.random() * 600,
        vx: 0,
        vy: 0,
        r: 4,
      };
      nodes.push(node);
      byKey.set(key, node);

      const targets = graphsById.get(p.graph) || [];
      targets.forEach((gNode) => {
        links.push({ a: node, b: gNode });
        if (!gNode.category && p.category) gNode.category = p.category;
      });
    });

    // category anchors, arranged around a big circle
    const categories = Array.from(
      new Set(index.constructionPrototypes.map((p) => p.category).filter(Boolean))
    );
    const anchorR = 260 + categories.length * 18;
    const anchors = new Map();
    categories.forEach((cat, i) => {
      const angle = (i / Math.max(1, categories.length)) * Math.PI * 2;
      anchors.set(cat, { x: Math.cos(angle) * anchorR, y: Math.sin(angle) * anchorR });
    });

    sim = { nodes, links, byKey, anchors };
  }

  function runSimulation() {
    const { nodes, links, anchors } = sim;
    const n = nodes.length;
    if (!n) return;
    const iterations = n > 500 ? 120 : 220;
    for (let iter = 0; iter < iterations; iter++) {
      const damping = 0.86;
      // repulsion (brute force - fine at this scale)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const d = Math.sqrt(d2);
          const minDist = a.r + b.r + (a.type === 'graph' && b.type === 'graph' ? 50 : 22);
          if (d < minDist * 4) {
            const force = (2200 / d2) * (d < minDist ? 3 : 1);
            const fx = (dx / d) * force;
            const fy = (dy / d) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
          }
        }
      }
      // springs along links
      links.forEach((l) => {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const ideal = 60;
        const force = (d - ideal) * 0.04;
        const fx = (dx / d) * force, fy = (dy / d) * force;
        l.a.vx += fx; l.a.vy += fy;
        l.b.vx -= fx; l.b.vy -= fy;
      });
      // category anchor pull (prototypes only - graphs follow via springs)
      nodes.forEach((node) => {
        if (node.type === 'proto' && node.category && anchors.has(node.category)) {
          const anchor = anchors.get(node.category);
          node.vx += (anchor.x - node.x) * 0.0025;
          node.vy += (anchor.y - node.y) * 0.0025;
        } else {
          // weak centering so orphans don't drift to infinity
          node.vx += -node.x * 0.0008;
          node.vy += -node.y * 0.0008;
        }
      });
      nodes.forEach((node) => {
        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
      });
    }
  }

  function el(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (children) children.forEach((c) => c && node.appendChild(c));
    return node;
  }

  function render() {
    svg.innerHTML = '';
    if (!sim) return;
    const { nodes, links } = sim;

    statsEl.textContent = `${sim.nodes.filter((n) => n.type === 'graph').length} graphs · ${sim.nodes.filter((n) => n.type === 'proto').length} construction prototypes`;

    const g = el('g', { transform: `translate(${transform.x},${transform.y}) scale(${transform.k})`, id: 'mapViewport' });

    const linkLayer = el('g');
    links.forEach((l) => {
      linkLayer.appendChild(
        el('line', { class: 'map-link', x1: l.a.x, y1: l.a.y, x2: l.b.x, y2: l.b.y })
      );
    });
    g.appendChild(linkLayer);

    const query = (searchEl.value || '').trim().toLowerCase();

    const protoLayer = el('g');
    const graphLayer = el('g');
    nodes.forEach((node) => {
      if (node.type === 'proto') {
        const dot = el('circle', {
          class: 'map-proto-node',
          cx: node.x,
          cy: node.y,
          r: node.r,
        });
        dot.addEventListener('click', () => {
          vscode.postMessage({ type: 'openUsage', file: node.file, range: node.range });
        });
        dot.addEventListener('mouseenter', (ev) =>
          showTooltip(ev, `${node.id}\n${node.startNode || '?'} → ${node.targetNode || '?'}${node.category ? '\n' + node.category : ''}`)
        );
        dot.addEventListener('mouseleave', hideTooltip);
        protoLayer.appendChild(dot);
      } else {
        const matched = query && node.id.toLowerCase().includes(query);
        const dimmed = query && !matched;
        const wrap = el('g', { class: `map-graph-node${matched ? ' matched' : ''}${dimmed ? ' dimmed' : ''}` });
        wrap.appendChild(
          el('circle', {
            cx: node.x,
            cy: node.y,
            r: node.r,
            fill: colorForCategory(node.category),
            'fill-opacity': '0.35',
          })
        );
        const label = el('text', { x: node.x, y: node.y + node.r + 12, class: 'map-graph-label' });
        label.textContent = node.id;
        wrap.appendChild(label);
        wrap.addEventListener('click', () => {
          vscode.postMessage({ type: 'openGraph', file: node.file, id: node.id });
        });
        wrap.addEventListener('mouseenter', (ev) =>
          showTooltip(ev, `${node.id}\n${node.nodeCount} nodes${node.category ? '\n' + node.category : '\n(no construction prototype found)'}`)
        );
        wrap.addEventListener('mouseleave', hideTooltip);
        graphLayer.appendChild(wrap);
      }
    });
    g.appendChild(protoLayer);
    g.appendChild(graphLayer);
    svg.appendChild(g);

    renderLegend();
  }

  function renderLegend() {
    legend.innerHTML = '';
    const categories = new Set();
    sim.nodes.forEach((n) => {
      if (n.type === 'proto' && n.category) categories.add(n.category);
    });
    if (!categories.size) {
      legend.style.display = 'none';
      return;
    }
    legend.style.display = 'block';
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.marginBottom = '4px';
    title.textContent = 'Categories';
    legend.appendChild(title);
    Array.from(categories).sort().forEach((cat) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const sw = document.createElement('div');
      sw.className = 'legend-swatch';
      sw.style.background = colorForCategory(cat);
      const label = document.createElement('span');
      label.textContent = cat;
      row.appendChild(sw);
      row.appendChild(label);
      legend.appendChild(row);
    });
  }

  let tooltip = null;
  function showTooltip(ev, text) {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'mapTooltip';
      document.body.appendChild(tooltip);
    }
    tooltip.textContent = text;
    tooltip.style.display = 'block';
    const rect = canvasWrap.getBoundingClientRect();
    tooltip.style.left = ev.clientX - rect.left + 14 + 'px';
    tooltip.style.top = ev.clientY - rect.top + 10 + 'px';
  }
  function hideTooltip() {
    if (tooltip) tooltip.style.display = 'none';
  }

  searchEl.addEventListener('input', render);

  // pan & zoom (same pattern as the node editor)
  let isPanning = false;
  let panStart = null;
  svg.addEventListener('mousedown', (ev) => {
    if (ev.target !== svg && ev.target.id !== 'mapViewport') return;
    isPanning = true;
    panStart = { x: ev.clientX, y: ev.clientY, tx: transform.x, ty: transform.y };
    svg.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (ev) => {
    if (!isPanning) return;
    transform.x = panStart.tx + (ev.clientX - panStart.x);
    transform.y = panStart.ty + (ev.clientY - panStart.y);
    applyTransformOnly();
  });
  window.addEventListener('mouseup', () => {
    isPanning = false;
    svg.classList.remove('grabbing');
  });
  svg.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const factor = ev.deltaY < 0 ? 1.1 : 0.9;
      const newK = Math.max(0.05, Math.min(3, transform.k * factor));
      transform.x = mx - ((mx - transform.x) * newK) / transform.k;
      transform.y = my - ((my - transform.y) * newK) / transform.k;
      transform.k = newK;
      applyTransformOnly();
    },
    { passive: false }
  );
  function applyTransformOnly() {
    const vp = document.getElementById('mapViewport');
    if (vp) vp.setAttribute('transform', `translate(${transform.x},${transform.y}) scale(${transform.k})`);
  }

  function fitToView() {
    if (!sim || !sim.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    sim.nodes.forEach((n) => {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    });
    const rect = canvasWrap.getBoundingClientRect();
    const bw = maxX - minX + 100;
    const bh = maxY - minY + 100;
    const k = Math.max(0.05, Math.min(1.2, Math.min(rect.width / bw, rect.height / bh)));
    transform.k = k;
    transform.x = rect.width / 2 - ((minX + maxX) / 2) * k;
    transform.y = rect.height / 2 - ((minY + maxY) / 2) * k;
    applyTransformOnly();
  }
})();
