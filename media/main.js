// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const svg = document.getElementById('canvas');
  const canvasWrap = document.getElementById('canvasWrap');
  const graphTitleEl = document.getElementById('graphTitle');
  const sidePanel = document.getElementById('sidePanel');
  const sidePanelTitle = document.getElementById('sidePanelTitle');
  const sidePanelBody = document.getElementById('sidePanelBody');
  // Chromium (and thus VS Code webviews) lets an unfocused <select> or
  // number <input> under the cursor "steal" the wheel event and change its
  // value instead of letting the page scroll - this is what made the edges
  // list feel unscrollable. Forward the scroll manually in that case.
  sidePanelBody.addEventListener(
    'wheel',
    (e) => {
      const t = e.target;
      const isScrollStealer =
        t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type === 'number'));
      if (isScrollStealer && document.activeElement !== t) {
        e.preventDefault();
        sidePanelBody.scrollTop += e.deltaY;
      }
    },
    { passive: false }
  );
  const errorBanner = document.getElementById('errorBanner');
  const warningsBanner = document.getElementById('warningsBanner');
  const emptyState = document.getElementById('emptyState');
  const newGraphFromEmptyBtn = document.getElementById('newGraphFromEmptyBtn');
  if (newGraphFromEmptyBtn) {
    newGraphFromEmptyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'requestNewGraph' });
    });
  }
  const searchBox = document.getElementById('searchBox');
  const graphSwitcher = document.getElementById('graphSwitcher');

  graphSwitcher.addEventListener('change', () => {
    vscode.postMessage({ type: 'selectGraph', id: graphSwitcher.value });
  });

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NODE_MIN_W = 150;
  const NODE_H = 56;
  const H_GAP = 46;
  const V_GAP = 118;
  const PADDING = 70;

  /** @type {{graph: any, allGraphIds: string[], usages: any[]}} */
  let state = { graph: null, allGraphIds: [], usages: [] };
  let selection = null; // { kind: 'node'|'edge', nodeIndex, edgeIndex }
  let transform = { x: 40, y: 40, k: 1 };
  let layoutCache = null; // {pos, layer, bounds}
  /** Manual drag overrides, keyed by node id, persisted across re-layouts
   * until "Auto-arrange" clears them or the node no longer exists. */
  let manualPositions = new Map();

  // ---------- messaging ----------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'model') {
      const prevSelectionId = getSelectedStableId();
      state.graph = msg.graph;
      state.allGraphIds = msg.allGraphIds || [];
      state.usages = [];
      showError(msg.errors && msg.errors.length ? msg.errors[0] : null);
      showWarnings(state.graph ? state.graph.warnings : null);
      layoutCache = null;
      if (msg.preserveSelection && prevSelectionId) {
        restoreSelectionByStableId(prevSelectionId);
      } else if (!msg.preserveSelection) {
        selection = null;
      }
      updateGraphSwitcher();
      if (emptyState) {
        emptyState.classList.toggle('hidden', !!state.graph);
      }
      render();
      if (!layoutCache || !layoutCache._fitted) {
        fitToView();
      }
      if (selection) {
        refreshBuilderAfterModelUpdate();
      } else {
        sidePanel.classList.add('hidden');
        openDraft = null;
      }
    } else if (msg.type === 'error') {
      showError(msg.message);
    } else if (msg.type === 'entityPrototypePicked') {
      const resolve = entityPickResolvers.get(msg.requestId);
      if (resolve) {
        resolve(msg.value || null);
        entityPickResolvers.delete(msg.requestId);
      }
    } else if (msg.type === 'usagesResult') {
      state.usages = msg.usages || [];
      showUsagesModal(state.usages);
      render();
    }
  });

  function updateGraphSwitcher() {
    if (state.allGraphIds.length > 1) {
      graphSwitcher.classList.remove('hidden');
      graphSwitcher.innerHTML = '';
      state.allGraphIds.forEach((id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        graphSwitcher.appendChild(opt);
      });
      if (state.graph) graphSwitcher.value = state.graph.id;
    } else {
      graphSwitcher.classList.add('hidden');
    }
  }

  vscode.postMessage({ type: 'ready' });

  function showError(message) {
    if (!message) {
      errorBanner.classList.add('hidden');
      errorBanner.textContent = '';
      return;
    }
    errorBanner.classList.remove('hidden');
    errorBanner.textContent = `⚠ YAML issue: ${message}`;
  }

  function showWarnings(warnings) {
    if (!warnings || !warnings.length) {
      warningsBanner.classList.add('hidden');
      warningsBanner.innerHTML = '';
      return;
    }
    warningsBanner.classList.remove('hidden');
    warningsBanner.innerHTML = '';
    const summary = document.createElement('div');
    summary.textContent = `⚠ ${warnings.length} thing${warnings.length === 1 ? '' : 's'} to check:`;
    warningsBanner.appendChild(summary);
    const ul = document.createElement('ul');
    warnings.forEach((w) => {
      const li = document.createElement('li');
      li.textContent = w.message;
      ul.appendChild(li);
    });
    warningsBanner.appendChild(ul);
  }

  function getSelectedStableId() {
    if (!selection || !state.graph) return null;
    if (selection.kind === 'node') {
      const n = state.graph.nodes[selection.nodeIndex];
      return n ? `node:${n.id}` : null;
    }
    if (selection.kind === 'edge') {
      const n = state.graph.nodes[selection.nodeIndex];
      const e = n && n.edges[selection.edgeIndex];
      return n && e ? `edge:${n.id}->${e.to}:${selection.edgeIndex}` : null;
    }
    return null;
  }

  function restoreSelectionByStableId(id) {
    if (!state.graph) return;
    if (id.startsWith('node:')) {
      const nodeId = id.slice(5);
      const idx = state.graph.nodes.findIndex((n) => n.id === nodeId);
      if (idx >= 0) selection = { kind: 'node', nodeIndex: idx };
      else selection = null;
    } else if (id.startsWith('edge:')) {
      const rest = id.slice(5);
      const [from, toAndIdx] = rest.split('->');
      const [to, idxStr] = toAndIdx.split(':');
      const nIdx = state.graph.nodes.findIndex((n) => n.id === from);
      if (nIdx >= 0) {
        const n = state.graph.nodes[nIdx];
        let eIdx = Number(idxStr);
        if (!(n.edges[eIdx] && n.edges[eIdx].to === to)) {
          eIdx = n.edges.findIndex((e) => e.to === to);
        }
        selection = eIdx >= 0 ? { kind: 'edge', nodeIndex: nIdx, edgeIndex: eIdx } : null;
      } else {
        selection = null;
      }
    }
  }

  // ---------- layout ----------
  // A layered (Sugiyama-style) auto-layout: BFS layering from `start`, then
  // several rounds of median-based crossing reduction sweeping both down
  // AND up through the layers (the original version only ever swept
  // downward, which left easily-avoidable crossings whenever a later layer
  // should have influenced an earlier one), followed by coordinate
  // "straightening" passes that pull each node toward the average x of its
  // neighbors so chains of edges become straight vertical lines instead of
  // zig-zags. Edges spanning more than one layer are routed through
  // waypoints so they read as a single deliberate bend rather than a
  // diagonal line cutting through unrelated nodes; edges that go back up
  // the graph (or sideways within a layer) are routed as a wide arc off to
  // the side instead of through the middle of the diagram.
  function computeLayout(graph) {
    const n = graph.nodes.length;
    const idToIndex = new Map(graph.nodes.map((nd, i) => [nd.id, i]));
    const adj = graph.nodes.map((nd) =>
      nd.edges.map((e) => idToIndex.get(e.to)).filter((x) => x !== undefined)
    );
    const preds = graph.nodes.map(() => []);
    adj.forEach((targets, from) => targets.forEach((to) => preds[to].push(from)));

    // ---- 1. layering (BFS distance from start) ----
    const startIdx = graph.start != null ? idToIndex.get(graph.start) : undefined;
    const layer = new Array(n).fill(-1);
    if (startIdx !== undefined && startIdx >= 0) {
      layer[startIdx] = 0;
      const queue = [startIdx];
      while (queue.length) {
        const cur = queue.shift();
        for (const nxt of adj[cur]) {
          if (layer[nxt] === -1) {
            layer[nxt] = layer[cur] + 1;
            queue.push(nxt);
          }
        }
      }
    }
    // Nodes unreachable from start (or no start at all) get bucketed into
    // extra rows below the main graph, several per row, in file order.
    let maxLayer = Math.max(0, ...layer.filter((l) => l >= 0));
    const unreached = [];
    for (let i = 0; i < n; i++) if (layer[i] === -1) unreached.push(i);
    unreached.forEach((i, k) => {
      layer[i] = maxLayer + 1 + Math.floor(k / 6);
    });
    const maxLayerFinal = Math.max(0, ...layer);

    const byLayer = [];
    for (let l = 0; l <= maxLayerFinal; l++) byLayer.push([]);
    for (let i = 0; i < n; i++) byLayer[layer[i]].push(i);

    const posInLayer = new Array(n).fill(0);
    const reindex = () => byLayer.forEach((ids) => ids.forEach((id, k) => (posInLayer[id] = k)));
    reindex();

    // ---- 2. crossing reduction: alternating down-sweeps and up-sweeps ----
    // Only "forward, adjacent-layer" edges count as neighbors for ordering
    // purposes - long-spanning and back edges are routed separately (below)
    // and shouldn't distort the ordering of layers they merely pass near.
    const adjacentSuccessors = graph.nodes.map(() => []);
    const adjacentPredecessors = graph.nodes.map(() => []);
    for (let from = 0; from < n; from++) {
      adj[from].forEach((to) => {
        if (layer[to] === layer[from] + 1) {
          adjacentSuccessors[from].push(to);
          adjacentPredecessors[to].push(from);
        }
      });
    }

    function sweep(direction) {
      const range =
        direction === 'down'
          ? { start: 1, end: maxLayerFinal, step: 1 }
          : { start: maxLayerFinal - 1, end: 0, step: -1 };
      for (let l = range.start; direction === 'down' ? l <= range.end : l >= range.end; l += range.step) {
        const neighborsOf = direction === 'down' ? adjacentPredecessors : adjacentSuccessors;
        const scored = byLayer[l].map((id) => {
          const ns = neighborsOf[id];
          const avg = ns.length
            ? ns.reduce((s, p) => s + posInLayer[p], 0) / ns.length
            : posInLayer[id];
          return { id, avg };
        });
        scored.sort((a, b) => a.avg - b.avg);
        byLayer[l] = scored.map((s) => s.id);
        byLayer[l].forEach((id, k) => (posInLayer[id] = k));
      }
    }
    for (let pass = 0; pass < 4; pass++) {
      sweep('down');
      sweep('up');
    }

    // ---- 3. sizing ----
    const measured = graph.nodes.map((nd) => {
      const w1 = measureText(nd.id, 12.5, 600);
      const w2 = nd.entity ? measureText(nd.entity, 11, 400) : 0;
      const w = Math.max(NODE_MIN_W, Math.max(w1, w2) + 28);
      return { w, h: NODE_H };
    });

    // ---- 4. initial x/y from layer order ----
    const layerWidths = byLayer.map((ids) =>
      ids.reduce((s, id) => s + measured[id].w + H_GAP, -H_GAP)
    );
    const maxWidth = Math.max(1, ...layerWidths);
    const pos = new Array(n);
    byLayer.forEach((ids, l) => {
      const totalW = layerWidths[l];
      let x = (maxWidth - totalW) / 2;
      ids.forEach((id) => {
        pos[id] = {
          x: x + measured[id].w / 2,
          y: l * V_GAP + measured[id].h / 2,
          w: measured[id].w,
          h: measured[id].h,
        };
        x += measured[id].w + H_GAP;
      });
    });

    // ---- 5. coordinate straightening ----
    // Pull each node toward the average x of its adjacent-layer neighbors
    // (both directions), re-sorting within its layer by the new target and
    // then spacing nodes apart to respect their widths. This is what turns
    // "correctly ordered but zig-zaggy" into "mostly straight lines", which
    // is the single biggest readability win for graphs with many edges.
    for (let iter = 0; iter < 6; iter++) {
      for (let l = 0; l <= maxLayerFinal; l++) {
        const ids = byLayer[l];
        const desired = ids.map((id) => {
          const neighXs = adjacentPredecessors[id]
            .concat(adjacentSuccessors[id])
            .map((p) => pos[p].x);
          const target = neighXs.length
            ? neighXs.reduce((s, x) => s + x, 0) / neighXs.length
            : pos[id].x;
          return { id, target };
        });
        // Keep the crossing-reduction order (don't let straightening
        // reorder nodes - that would undo pass 2's work) but shift each
        // node toward its target, then resolve overlaps left-to-right.
        for (let i = 0; i < desired.length; i++) {
          pos[desired[i].id].x = desired[i].target;
        }
        for (let i = 1; i < ids.length; i++) {
          const prev = pos[ids[i - 1]];
          const cur = pos[ids[i]];
          const minX = prev.x + prev.w / 2 + H_GAP + cur.w / 2;
          if (cur.x < minX) cur.x = minX;
        }
        // Re-center the layer as a whole so it doesn't drift to one edge.
        if (ids.length) {
          const first = pos[ids[0]];
          const last = pos[ids[ids.length - 1]];
          const layerSpan = last.x + last.w / 2 - (first.x - first.w / 2);
          const shift = (maxWidth - layerSpan) / 2 - (first.x - first.w / 2);
          ids.forEach((id) => (pos[id].x += shift));
        }
      }
    }

    // ---- 6. apply manual drag overrides (persist across re-layouts) ----
    graph.nodes.forEach((nd, i) => {
      const manual = manualPositions.get(nd.id);
      if (manual) {
        pos[i].x = manual.x;
        pos[i].y = manual.y;
      }
    });

    let maxX = 0;
    let maxY = 0;
    pos.forEach((p) => {
      maxX = Math.max(maxX, p.x + p.w / 2);
      maxY = Math.max(maxY, p.y + p.h / 2);
    });

    return { pos, layer, adjacentSuccessors, bounds: { w: maxX, h: maxY } };
  }

  let measureCtx = null;
  function measureText(text, size, weight) {
    if (!measureCtx) {
      const c = document.createElement('canvas');
      measureCtx = c.getContext('2d');
    }
    measureCtx.font = `${weight} ${size}px var(--vscode-font-family, sans-serif)`;
    return measureCtx.measureText(text || '').width;
  }

  // ---------- rendering ----------
  function el(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k in attrs) node.setAttribute(k, attrs[k]);
    }
    if (children) children.forEach((c) => c && node.appendChild(c));
    return node;
  }

  function stepKindColor(kind) {
    return (
      {
        tool: '#3794ff',
        material: '#4ec9b0',
        component: '#e2a03f',
        prototype: '#c586c0',
        tag: '#b180d7',
        multiTag: '#b180d7',
      }[kind] || '#888'
    );
  }

  function render() {
    svg.innerHTML = '';
    const graph = state.graph;
    if (!graph) {
      graphTitleEl.textContent = 'No construction graph';
      return;
    }
    graphTitleEl.textContent = `${graph.id}${graph.start ? '  ·  start: ' + graph.start : ''}`;

    const layout = computeLayout(graph);
    layoutCache = layout;

    const g = el('g', {
      transform: `translate(${transform.x},${transform.y}) scale(${transform.k})`,
      id: 'viewport',
    });

    // defs: arrow markers
    const defs = el('defs', null, [
      el('marker', {
        id: 'arrow',
        viewBox: '0 0 10 10',
        refX: '9',
        refY: '5',
        markerWidth: '7',
        markerHeight: '7',
        orient: 'auto-start-reverse',
      }, [el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--vscode-charts-blue, #3794ff)' })]),
      el('marker', {
        id: 'arrow-selected',
        viewBox: '0 0 10 10',
        refX: '9',
        refY: '5',
        markerWidth: '7',
        markerHeight: '7',
        orient: 'auto-start-reverse',
      }, [el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--vscode-focusBorder, #007acc)' })]),
    ]);
    g.appendChild(defs);

    const edgeLayer = el('g', { id: 'edgeLayer' });
    const nodeLayer = el('g', { id: 'nodeLayer' });

    // --- edges ---
    let backSlotCounter = 0;
    graph.nodes.forEach((node, ni) => {
      const groups = groupByTarget(node.edges);
      Object.keys(groups).forEach((toId) => {
        const idxs = groups[toId];
        const toIdx = graph.nodes.findIndex((x) => x.id === toId);
        const isBack = toIdx !== -1 && layout.layer[toIdx] <= layout.layer[ni] && toIdx !== ni;
        const backSlot = isBack ? backSlotCounter++ : 0;
        idxs.forEach((edgeIndex, k) => {
          const edge = node.edges[edgeIndex];
          const curveOffset = (k - (idxs.length - 1) / 2) * 26;
          const path = buildEdgePath(layout, ni, toIdx, curveOffset, backSlot);
          if (!path) return;
          const isSelected =
            selection && selection.kind === 'edge' && selection.nodeIndex === ni && selection.edgeIndex === edgeIndex;

          const pathEl = el('path', {
            class: `edge-path${isBack ? ' back' : ''}${isSelected ? ' selected' : ''}${toIdx === -1 ? ' dangling' : ''}`,
            d: path.d,
            'marker-end': isSelected ? 'url(#arrow-selected)' : 'url(#arrow)',
          });
          const hitEl = el('path', { class: 'edge-hit', d: path.d });
          const wrap = el('g', {}, [pathEl, hitEl]);
          wrap.addEventListener('click', (ev) => {
            ev.stopPropagation();
            selection = { kind: 'edge', nodeIndex: ni, edgeIndex };
            render();
            showSidePanelForSelection();
          });
          edgeLayer.appendChild(wrap);

          // label: first step summary or step count (computed backend-side)
          const label = edge.label;
          if (label) {
            const lw = measureText(label, 10.5, 400) + 10;
            const bg = el('rect', {
              x: path.mid.x - lw / 2,
              y: path.mid.y - 8,
              width: lw,
              height: 16,
              rx: 4,
              class: 'edge-label-bg',
            });
            const txt = el('text', {
              x: path.mid.x,
              y: path.mid.y + 4,
              class: `edge-label${isSelected ? ' selected' : ''}`,
            });
            txt.textContent = label;
            edgeLayer.appendChild(bg);
            edgeLayer.appendChild(txt);
          }
        });
      });
    });

    // --- nodes ---
    graph.nodes.forEach((node, ni) => {
      const p = layout.pos[ni];
      if (!p) return;
      const isStart = graph.start && node.id === graph.start;
      const isSelected = selection && selection.kind === 'node' && selection.nodeIndex === ni;
      const isDeadEnd = node.edges.length === 0;
      const matches = searchMatches(node);
      const usageHits = (state.usages || []).filter(
        (u) => u.startNode === node.id || u.targetNode === node.id
      );

      const classes = [
        'node-box',
        isStart ? 'start' : '',
        isSelected ? 'selected' : '',
        matches ? 'match' : '',
        isDeadEnd ? 'dead-end' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const box = el('rect', {
        x: p.x - p.w / 2,
        y: p.y - p.h / 2,
        width: p.w,
        height: p.h,
        rx: 8,
        class: classes,
      });
      const label = el('text', {
        x: p.x,
        y: p.y - (node.entity ? 4 : -2),
        class: 'node-label',
        'text-anchor': 'middle',
      });
      label.textContent = node.id;

      const children = [box, label];
      if (node.entity) {
        const sub = el('text', {
          x: p.x,
          y: p.y + 14,
          class: 'node-sub',
          'text-anchor': 'middle',
        });
        sub.textContent = node.entity;
        children.push(sub);
      }
      if (node.edges.length > 0) {
        const badge = el('circle', {
          cx: p.x + p.w / 2 - 4,
          cy: p.y - p.h / 2 + 4,
          r: 8,
          class: 'node-badge',
        });
        const badgeText = el('text', {
          x: p.x + p.w / 2 - 4,
          y: p.y - p.h / 2 + 7,
          class: 'node-badge-text',
        });
        badgeText.textContent = String(node.edges.length);
        children.push(badge, badgeText);
      }
      if (usageHits.length) {
        const roleText = usageHits
          .map((u) => (u.startNode === node.id ? '▶ start' : '🎯 target') + ` (${u.id})`)
          .join(', ');
        const lw = measureText(roleText, 9.5, 600) + 10;
        const roleBg = el('rect', {
          x: p.x - lw / 2,
          y: p.y + p.h / 2 + 3,
          width: lw,
          height: 15,
          rx: 4,
          fill: 'var(--vscode-charts-purple, #b180d7)',
        });
        const roleLabel = el('text', {
          x: p.x,
          y: p.y + p.h / 2 + 14,
          'text-anchor': 'middle',
          class: 'node-badge-text',
        });
        roleLabel.textContent = roleText;
        children.push(roleBg, roleLabel);
      }

      const group = el('g', { class: 'node-group' }, children);
      group.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selection = { kind: 'node', nodeIndex: ni };
        render();
        showSidePanelForSelection();
      });
      makeDraggable(group, node.id, p);
      nodeLayer.appendChild(group);
    });

    g.appendChild(edgeLayer);
    g.appendChild(nodeLayer);
    svg.appendChild(g);

    if (selection) {
      // keep side panel content fresh (labels etc. may have changed after edits)
      showSidePanelForSelection({ skipIfEditing: true });
    }
  }

  function groupByTarget(edges) {
    const groups = {};
    edges.forEach((e, i) => {
      (groups[e.to] = groups[e.to] || []).push(i);
    });
    return groups;
  }

  function buildEdgePath(layout, fromIdx, toIdx, curveOffset, backSlot) {
    const a = layout.pos[fromIdx];
    if (!a) return null;
    if (toIdx === -1 || !layout.pos[toIdx]) {
      // dangling edge to an id that doesn't exist as a node - draw a short stub
      const x1 = a.x, y1 = a.y + a.h / 2;
      const x2 = x1, y2 = y1 + 40;
      return { d: `M${x1},${y1} L${x2},${y2}`, mid: { x: x1, y: y1 + 20 } };
    }
    const b = layout.pos[toIdx];
    if (fromIdx === toIdx) {
      // self loop
      const x = a.x + a.w / 2;
      const y = a.y;
      const d = `M${x},${y - 10} C${x + 55},${y - 40} ${x + 55},${y + 40} ${x},${y + 10}`;
      return { d, mid: { x: x + 40, y } };
    }

    const fromLayer = layout.layer[fromIdx];
    const toLayer = layout.layer[toIdx];
    const isBack = toLayer <= fromLayer;

    if (isBack) {
      // Route entirely around the RIGHT side of the diagram as a wide arc,
      // rather than cutting back up through the middle of the grid - this
      // is what actually keeps "deconstruct"/loop-back edges legible once
      // a graph has more than a couple of them.
      const laneX = layout.bounds.w + 50 + (backSlot || 0) * 34;
      const x1 = a.x + a.w / 2;
      const y1 = a.y;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const d = `M${x1},${y1} C${laneX},${y1} ${laneX},${y2} ${x2},${y2}`;
      return { d, mid: { x: laneX, y: (y1 + y2) / 2 } };
    }

    if (toLayer > fromLayer + 1) {
      // Spans multiple layers: route through a waypoint at each
      // intermediate layer so it reads as one deliberate bend rather than
      // a diagonal slicing across layers it doesn't belong to. Waypoints
      // lean toward whichever side of the straight line has more room.
      const x1 = a.x, y1 = a.y + a.h / 2;
      const x2 = b.x, y2 = b.y - b.h / 2;
      const bendDir = curveOffset >= 0 ? 1 : -1;
      const points = [[x1, y1]];
      for (let l = fromLayer + 1; l < toLayer; l++) {
        const t = (l - fromLayer) / (toLayer - fromLayer);
        const straightX = x1 + (x2 - x1) * t;
        const bend = (30 + Math.abs(curveOffset)) * bendDir;
        points.push([straightX + bend, l * (y2 - y1) / (toLayer - fromLayer) + y1]);
      }
      points.push([x2, y2]);
      // Smooth through the points with a Catmull-Rom-ish chain of quadratics.
      let d = `M${points[0][0]},${points[0][1]}`;
      for (let i = 1; i < points.length; i++) {
        const [px, py] = points[i - 1];
        const [cx, cy] = points[i];
        const mx = (px + cx) / 2;
        const my = (py + cy) / 2;
        d += ` Q${px},${py} ${mx},${my}`;
      }
      d += ` T${points[points.length - 1][0]},${points[points.length - 1][1]}`;
      const midPoint = points[Math.floor(points.length / 2)];
      return { d, mid: { x: midPoint[0], y: midPoint[1] } };
    }

    // Adjacent layer, forward: simple, slightly-curved vertical connector.
    const x1 = a.x, y1 = a.y + a.h / 2;
    const x2 = b.x, y2 = b.y - b.h / 2;
    const midX = (x1 + x2) / 2 + curveOffset;
    const midY = (y1 + y2) / 2;
    const d = `M${x1},${y1} Q${midX},${midY} ${x2},${y2}`;
    return { d, mid: { x: midX, y: midY } };
  }

  // ---------- search ----------
  function searchMatches(node) {
    const q = (searchBox.value || '').trim().toLowerCase();
    if (!q) return false;
    return (
      node.id.toLowerCase().includes(q) ||
      (node.entity && node.entity.toLowerCase().includes(q))
    );
  }
  searchBox.addEventListener('input', () => render());
  searchBox.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const q = searchBox.value.trim().toLowerCase();
      const idx = state.graph
        ? state.graph.nodes.findIndex(
            (n) => n.id.toLowerCase().includes(q) || (n.entity || '').toLowerCase().includes(q)
          )
        : -1;
      if (idx >= 0) panToNode(idx);
    }
  });

  function panToNode(idx) {
    const layout = layoutCache;
    if (!layout || !layout.pos[idx]) return;
    const p = layout.pos[idx];
    const rect = canvasWrap.getBoundingClientRect();
    transform.x = rect.width / 2 - p.x * transform.k;
    transform.y = rect.height / 2 - p.y * transform.k;
    render();
  }

  // ---------- pan & zoom ----------
  let isPanning = false;
  let panStart = null;
  svg.addEventListener('mousedown', (ev) => {
    if (ev.target !== svg && ev.target.id !== 'viewport') return;
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
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.1 : 0.9;
    const newK = Math.max(0.15, Math.min(3, transform.k * factor));
    transform.x = mx - ((mx - transform.x) * newK) / transform.k;
    transform.y = my - ((my - transform.y) * newK) / transform.k;
    transform.k = newK;
    applyTransformOnly();
  }, { passive: false });

  function applyTransformOnly() {
    const viewport = document.getElementById('viewport');
    if (viewport) {
      viewport.setAttribute(
        'transform',
        `translate(${transform.x},${transform.y}) scale(${transform.k})`
      );
    }
  }

  document.getElementById('fitBtn').addEventListener('click', fitToView);
  function fitToView() {
    if (!layoutCache) return;
    const rect = canvasWrap.getBoundingClientRect();
    const bw = layoutCache.bounds.w + PADDING * 2;
    const bh = layoutCache.bounds.h + PADDING * 2;
    const k = Math.max(0.15, Math.min(1.3, Math.min(rect.width / bw, rect.height / bh)));
    transform.k = k;
    transform.x = (rect.width - layoutCache.bounds.w * k) / 2;
    transform.y = PADDING * k;
    layoutCache._fitted = true;
    applyTransformOnly();
  }

  // ---------- dragging nodes (manual repositioning override) ----------
  // A single module-level drag state + one set of window listeners,
  // registered once - NOT per-node-per-render, which was leaking a fresh
  // pair of window listeners every single render() call.
  let dragState = null; // { nodeId, startMouse: {x,y}, startPos: {x,y} }
  function makeDraggable(group, nodeId, currentPos) {
    group.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      dragState = {
        nodeId,
        startMouse: { x: ev.clientX, y: ev.clientY },
        startPos: { x: currentPos.x, y: currentPos.y },
      };
    });
  }
  window.addEventListener('mousemove', (ev) => {
    if (!dragState) return;
    const dx = (ev.clientX - dragState.startMouse.x) / transform.k;
    const dy = (ev.clientY - dragState.startMouse.y) / transform.k;
    manualPositions.set(dragState.nodeId, {
      x: dragState.startPos.x + dx,
      y: dragState.startPos.y + dy,
    });
    render();
  });
  window.addEventListener('mouseup', () => {
    dragState = null;
  });

  document.getElementById('autoArrangeBtn').addEventListener('click', () => {
    if (!state.graph) return;
    const idsInGraph = new Set(state.graph.nodes.map((n) => n.id));
    Array.from(manualPositions.keys()).forEach((id) => {
      if (idsInGraph.has(id)) manualPositions.delete(id);
    });
    render();
    fitToView();
  });

  // ---------- side panel ----------
  // ---------- side panel: structured node/edge builder ----------
  // One builder is open per selected node at a time. It holds its own
  // in-memory "draft" state (id/entity/actions/edges-with-everything);
  // nothing touches the document until "Save Node" is clicked. Incoming
  // 'model' pushes are ignored for the open draft while it's dirty, so
  // external edits (or your own in-progress typing) never get clobbered.
  const S = window.SS14Schema;
  let openDraft = null; // { nodeIndex, dirty, state, focusEdgeIndex }

  document.getElementById('closeSidePanel').addEventListener('click', () => {
    selection = null;
    openDraft = null;
    sidePanel.classList.add('hidden');
    render();
  });

  function clearNode(elm) {
    while (elm.firstChild) elm.removeChild(elm.firstChild);
  }
  function fieldLabel(text) {
    const d = document.createElement('div');
    d.className = 'field-label';
    d.textContent = text;
    return d;
  }
  function chip(text) {
    const s = document.createElement('span');
    s.className = 'tag-chip';
    s.textContent = text;
    return s;
  }

  // ---- draft <-> parsed-node conversion ----
  function typedItemToDraft(item, typeMap) {
    return {
      tag: item.tag,
      params: Object.assign({}, item.params),
      _schema: typeMap[item.tag], // undefined for unknown/fork types - still fully editable via "Other fields"
      rawMode: false,
      rawText: '',
    };
  }
  function stepToDraft(step) {
    return {
      kind: step.kind, // 'generic' for unrecognized shapes - still fully editable via "Other fields"
      params: Object.assign({}, step.params),
      rawMode: false,
      rawText: '',
    };
  }

  function nodeToDraftState(node) {
    return {
      originalId: node.id,
      id: node.id,
      entity: node.entity || '',
      actions: node.actions.map((a) => typedItemToDraft(a, S.ACTION_TYPES)),
      edges: node.edges.map((e) => ({
        to: e.to,
        conditions: e.conditions.map((c) => typedItemToDraft(c, S.CONDITION_TYPES)),
        completed: e.completed.map((c) => typedItemToDraft(c, S.ACTION_TYPES)),
        steps: e.steps.map(stepToDraft),
        collapsed: false,
        rawMode: false,
        rawText: '',
      })),
      rawMode: false,
      rawText: '',
    };
  }

  function openNodeBuilder(nodeIndex, focusEdgeIndex) {
    const node = state.graph.nodes[nodeIndex];
    if (!node) return;
    if (!openDraft || openDraft.nodeIndex !== nodeIndex || !openDraft.dirty) {
      openDraft = {
        nodeIndex,
        dirty: false,
        state: nodeToDraftState(node),
        focusEdgeIndex: focusEdgeIndex != null ? focusEdgeIndex : null,
      };
    } else if (focusEdgeIndex != null) {
      openDraft.focusEdgeIndex = focusEdgeIndex;
    }
    sidePanel.classList.remove('hidden');
    renderBuilder();
  }

  function markDirty() {
    if (openDraft) openDraft.dirty = true;
  }

  /** Set the dirty flag and update the Save button / hint in place, WITHOUT
   * rebuilding the panel DOM — used for every-keystroke text input so typing
   * never steals focus. Structural changes (add/remove, dropdown selection)
   * still go through the full onChange -> renderBuilder() path. */
  function markDirtyLight() {
    if (!openDraft) return;
    const wasDirty = openDraft.dirty;
    openDraft.dirty = true;
    if (wasDirty) return;
    const btn = document.getElementById('saveNodeBtn');
    if (btn) btn.textContent = 'Save node ●';
    const hint = document.getElementById('unsavedHint');
    if (hint) hint.classList.remove('hidden');
  }

  function showSidePanelForSelection() {
    if (!selection || !state.graph) {
      sidePanel.classList.add('hidden');
      return;
    }
    if (selection.kind === 'node') {
      openNodeBuilder(selection.nodeIndex, null);
    } else if (selection.kind === 'edge') {
      openNodeBuilder(selection.nodeIndex, selection.edgeIndex);
    }
  }

  // Called after every 'model' push (see message handler) to keep the open
  // builder's read-only context (e.g. the list of valid edge targets) fresh
  // without discarding in-progress edits.
  function refreshBuilderAfterModelUpdate() {
    if (!openDraft || !state.graph) return;
    const node = state.graph.nodes[openDraft.nodeIndex];
    if (!node) {
      openDraft = null;
      sidePanel.classList.add('hidden');
      return;
    }
    if (!openDraft.dirty) {
      openDraft.state = nodeToDraftState(node);
    }
    renderBuilder();
  }

  // ---- generic field renderers ----
  // ---- entity/prototype picker plumbing (workspace scan, via extension host) ----
  let entityPickSeq = 0;
  const entityPickResolvers = new Map();
  function requestEntityPick() {
    const requestId = String(++entityPickSeq);
    return new Promise((resolve) => {
      entityPickResolvers.set(requestId, resolve);
      vscode.postMessage({ type: 'pickEntityPrototype', requestId });
    });
  }

  function renderField(container, field, params, onChange) {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '6px';
    const lbl = document.createElement('div');
    lbl.className = 'field-label';
    lbl.style.marginBottom = '2px';
    lbl.textContent = field.label;
    wrap.appendChild(lbl);

    let input;
    if (field.type === 'bool') {
      input = document.createElement('select');
      input.className = 'inline-select';
      ['(unset)', 'true', 'false'].forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v === '(unset)' ? '' : v;
        opt.textContent = v;
        input.appendChild(opt);
      });
      input.value = params[field.key] === undefined ? '' : String(params[field.key]);
      input.addEventListener('change', () => {
        params[field.key] = input.value === '' ? undefined : input.value === 'true';
        onChange();
      });
      wrap.appendChild(input);
    } else if (field.type === 'enum') {
      input = document.createElement('select');
      input.className = 'inline-select';
      const options = field.allowCustom
        ? field.options.concat(['(custom…)'])
        : field.options;
      options.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        input.appendChild(opt);
      });
      const current = params[field.key];
      if (field.allowCustom && current && !field.options.includes(current)) {
        input.value = '(custom…)';
      } else if (current) {
        input.value = current;
      }
      input.addEventListener('change', () => {
        if (input.value === '(custom…)') {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.placeholder = 'custom value';
          textInput.style.marginTop = '4px';
          textInput.addEventListener('input', () => {
            params[field.key] = textInput.value;
            onChange('light');
          });
          wrap.appendChild(textInput);
          textInput.focus();
        } else {
          params[field.key] = input.value;
          onChange();
        }
      });
      wrap.appendChild(input);
    } else if (field.type === 'taglist') {
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'comma, separated, tags';
      input.value = (params[field.key] || []).join(', ');
      input.addEventListener('input', () => {
        params[field.key] = input.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        onChange('light');
      });
      wrap.appendChild(input);
    } else if (field.type === 'entityRef') {
      const row = document.createElement('div');
      row.className = 'inline-form';
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = field.placeholder || 'Entity prototype ID';
      const v = params[field.key];
      input.value = v === undefined || v === null ? '' : v;
      input.addEventListener('input', () => {
        params[field.key] = input.value;
        onChange('light');
      });
      const browseBtn = document.createElement('button');
      browseBtn.textContent = '🔍 Browse…';
      browseBtn.title = 'Search entity prototypes in this workspace';
      browseBtn.addEventListener('click', async () => {
        browseBtn.disabled = true;
        browseBtn.textContent = 'Scanning…';
        try {
          const picked = await requestEntityPick();
          if (picked) {
            input.value = picked;
            params[field.key] = picked;
            onChange('light');
          }
        } finally {
          browseBtn.disabled = false;
          browseBtn.textContent = '🔍 Browse…';
        }
      });
      row.appendChild(input);
      row.appendChild(browseBtn);
      wrap.appendChild(row);
    } else {
      input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      if (field.placeholder) input.placeholder = field.placeholder;
      const v = params[field.key];
      input.value = v === undefined || v === null ? '' : v;
      input.addEventListener('input', () => {
        if (field.type === 'number') {
          params[field.key] = input.value === '' ? undefined : Number(input.value);
        } else {
          params[field.key] = input.value;
        }
        onChange('light');
      });
      wrap.appendChild(input);
    }
    container.appendChild(wrap);
  }

  /** Generic key/value editor for whatever fields a schema doesn't model -
   * either extra fields on a known type (a fork added something), or every
   * field on a totally unrecognized type. Nothing here is ever dropped: the
   * full params object (known fields + these) is what gets serialized. */
  function renderOtherFields(container, params, knownFields, onChange, isKnownType) {
    const extraKeys = S.extraKeysOf(params, knownFields);
    if (!extraKeys.length && isKnownType) return; // known type, nothing extra - keep UI clean
    const wrap = document.createElement('div');
    wrap.style.marginTop = '6px';
    wrap.style.paddingTop = '6px';
    wrap.style.borderTop = '1px dashed var(--vscode-panel-border, #555)';
    wrap.appendChild(
      fieldLabel(isKnownType ? 'Other fields' : 'Fields (unrecognized type — add fields freely)')
    );

    extraKeys.forEach((key) => {
      const row = document.createElement('div');
      row.className = 'inline-form';
      row.style.marginBottom = '4px';
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.value = key;
      keyInput.style.maxWidth = '120px';
      keyInput.title = 'Field name';
      keyInput.addEventListener('change', () => {
        const newKey = keyInput.value.trim();
        if (newKey && newKey !== key) {
          params[newKey] = params[key];
          delete params[key];
        }
        onChange(true);
      });

      const kind = S.inferGenericType(params[key]);
      let valueInput;
      if (kind === 'bool') {
        valueInput = document.createElement('select');
        valueInput.className = 'inline-select';
        ['true', 'false'].forEach((v) => {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          valueInput.appendChild(opt);
        });
        valueInput.value = String(params[key]);
        valueInput.addEventListener('change', () => {
          params[key] = valueInput.value === 'true';
          onChange('light');
        });
      } else if (kind === 'taglist') {
        valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.placeholder = 'comma, separated';
        valueInput.value = (params[key] || []).join(', ');
        valueInput.addEventListener('input', () => {
          params[key] = valueInput.value.split(',').map((s) => s.trim()).filter(Boolean);
          onChange('light');
        });
      } else {
        valueInput = document.createElement('input');
        valueInput.type = kind === 'number' ? 'number' : 'text';
        valueInput.value = params[key] === undefined || params[key] === null ? '' : params[key];
        valueInput.addEventListener('input', () => {
          params[key] = kind === 'number' ? Number(valueInput.value) : valueInput.value;
          onChange('light');
        });
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'danger';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        delete params[key];
        onChange(true);
      });
      row.appendChild(keyInput);
      row.appendChild(valueInput);
      row.appendChild(removeBtn);
      wrap.appendChild(row);
    });

    const addRow = document.createElement('div');
    addRow.className = 'inline-form';
    const newKeyInput = document.createElement('input');
    newKeyInput.type = 'text';
    newKeyInput.placeholder = 'field name';
    newKeyInput.style.maxWidth = '140px';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add field';
    addBtn.addEventListener('click', () => {
      const key = newKeyInput.value.trim();
      if (!key) return;
      params[key] = '';
      onChange(true);
    });
    addRow.appendChild(newKeyInput);
    addRow.appendChild(addBtn);
    wrap.appendChild(addRow);

    container.appendChild(wrap);
  }

  function typePicker(typeMap, onPick) {
    const form = document.createElement('div');
    form.className = 'inline-form';
    form.style.marginTop = '4px';
    const select = document.createElement('select');
    select.className = 'inline-select';
    Object.keys(typeMap).forEach((tag) => {
      const opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = typeMap[tag].label;
      select.appendChild(opt);
    });
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom / other type…';
    select.appendChild(customOpt);

    const customNameInput = document.createElement('input');
    customNameInput.type = 'text';
    customNameInput.placeholder = 'TypeName (e.g. MyForkAction)';
    customNameInput.style.display = 'none';
    customNameInput.style.marginLeft = '4px';
    select.addEventListener('change', () => {
      customNameInput.style.display = select.value === '__custom__' ? '' : 'none';
    });

    const btn = document.createElement('button');
    btn.textContent = '+ Add';
    btn.addEventListener('click', () => {
      if (select.value === '__custom__') {
        const name = customNameInput.value.trim();
        if (!name) {
          customNameInput.focus();
          return;
        }
        onPick(select.value, name);
        customNameInput.value = '';
      } else {
        onPick(select.value);
      }
    });
    form.appendChild(select);
    form.appendChild(customNameInput);
    form.appendChild(btn);
    return form;
  }

  /** A single typed item (action/condition) editor block: type label, known
   * fields, "Other fields" for anything the schema doesn't model, raw-YAML
   * toggle, remove button. Works identically whether the type is one we
   * recognize or a totally unknown/fork/future one. */
  function renderTypedItemBlock(item, typeMap, onChange, onRemove) {
    const block = document.createElement('div');
    block.className = 'step-row';
    block.style.borderLeftColor = '#3794ff';
    const schema = typeMap[item.tag];

    const head = document.createElement('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center';
    head.style.marginBottom = '4px';
    const title = document.createElement('strong');
    title.textContent = (schema && schema.label) || item.tag;
    if (!schema) {
      const badge = document.createElement('span');
      badge.className = 'tag-chip';
      badge.style.marginLeft = '6px';
      badge.textContent = 'unrecognized type';
      title.appendChild(badge);
    }
    const btns = document.createElement('div');
    const rawToggle = document.createElement('button');
    rawToggle.textContent = item.rawMode ? 'Use form' : 'Edit as YAML';
    rawToggle.style.marginRight = '4px';
    rawToggle.addEventListener('click', () => {
      if (!item.rawMode && !item.rawText) item.rawText = S.buildTypedItemYaml(item);
      item.rawMode = !item.rawMode;
      onChange(true);
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', onRemove);
    btns.appendChild(rawToggle);
    btns.appendChild(removeBtn);
    head.appendChild(title);
    head.appendChild(btns);
    block.appendChild(head);

    if (item.rawMode) {
      const ta = document.createElement('textarea');
      ta.className = 'yaml-edit';
      ta.style.minHeight = '80px';
      ta.spellcheck = false;
      ta.value = item.rawText || '';
      ta.addEventListener('input', () => {
        item.rawText = ta.value;
        onChange('light');
      });
      block.appendChild(ta);
    } else {
      const fieldsWrappedOnChange = (dirty) => {
        item.rawText = '';
        onChange(dirty);
      };
      if (schema) {
        schema.fields.forEach((f) => renderField(block, f, item.params, fieldsWrappedOnChange));
      }
      renderOtherFields(block, item.params, schema ? schema.fields : [], fieldsWrappedOnChange, !!schema);
    }
    return block;
  }

  function renderTypedList(container, label, items, typeMap, onChange) {
    container.appendChild(fieldLabel(label));
    items.forEach((item, i) => {
      container.appendChild(
        renderTypedItemBlock(
          item,
          typeMap,
          onChange,
          () => {
            items.splice(i, 1);
            onChange(true);
          }
        )
      );
    });
    container.appendChild(
      typePicker(typeMap, (tag, customName) => {
        if (tag === '__custom__') {
          items.push({ tag: customName, params: {}, _schema: undefined, rawMode: false, rawText: '' });
        } else {
          items.push({ tag, params: S.defaultParamsFor(typeMap[tag].fields), _schema: typeMap[tag], rawMode: false, rawText: '' });
        }
        onChange(true);
      })
    );
  }

  function renderStepBlock(step, onChange, onRemove) {
    const block = document.createElement('div');
    block.className = 'step-row';
    block.style.borderLeftColor = stepKindColor(step.kind);

    const head = document.createElement('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center';
    head.style.marginBottom = '4px';

    const kindSelect = document.createElement('select');
    kindSelect.className = 'inline-select';
    Object.keys(S.STEP_KINDS).forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = S.STEP_KINDS[k].label;
      kindSelect.appendChild(opt);
    });
    kindSelect.value = step.kind;
    kindSelect.disabled = step.rawMode;
    kindSelect.addEventListener('change', () => {
      step.kind = kindSelect.value;
      step.params = S.defaultParamsFor(S.STEP_KINDS[step.kind].fields);
      onChange(true);
    });

    const btns = document.createElement('div');
    const rawToggle = document.createElement('button');
    rawToggle.textContent = step.rawMode ? 'Use form' : 'Edit as YAML';
    rawToggle.style.marginRight = '4px';
    rawToggle.addEventListener('click', () => {
      if (!step.rawMode && !step.rawText) step.rawText = buildStepRaw(step);
      step.rawMode = !step.rawMode;
      onChange(true);
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', onRemove);
    btns.appendChild(rawToggle);
    btns.appendChild(removeBtn);

    head.appendChild(kindSelect);
    head.appendChild(btns);
    block.appendChild(head);

    if (step.rawMode) {
      const ta = document.createElement('textarea');
      ta.className = 'yaml-edit';
      ta.style.minHeight = '70px';
      ta.spellcheck = false;
      ta.value = step.rawText || '';
      ta.addEventListener('input', () => {
        step.rawText = ta.value;
        onChange('light');
      });
      block.appendChild(ta);
    } else {
      const schema = S.STEP_KINDS[step.kind] || S.STEP_KINDS.generic;
      const fieldsWrappedOnChange = (dirty) => {
        step.rawText = '';
        onChange(dirty);
      };
      schema.fields.forEach((f) => renderField(block, f, step.params, fieldsWrappedOnChange));
      renderOtherFields(block, step.params, schema.fields, fieldsWrappedOnChange, step.kind !== 'generic');
    }
    return block;
  }
  function buildStepRaw(step) {
    return S.buildStepYaml(step);
  }


  function renderEdgeBlock(container, edge, edgeIndex, nodeState, focused, onChange) {
    const edgeOnChange = (dirty) => {
      if (dirty !== false) edge.rawText = '';
      onChange(dirty);
    };
    const wrap = document.createElement('div');
    wrap.style.border = '1px solid var(--vscode-panel-border, #444)';
    wrap.style.borderRadius = '6px';
    wrap.style.marginBottom = '8px';
    wrap.style.overflow = 'hidden';
    if (focused) wrap.style.borderColor = 'var(--vscode-focusBorder, #007acc)';

    const head = document.createElement('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';
    head.style.padding = '6px 8px';
    head.style.background = 'var(--vscode-editorWidget-background, rgba(255,255,255,0.03))';
    head.style.cursor = 'pointer';

    const titleWrap = document.createElement('div');
    titleWrap.style.display = 'flex';
    titleWrap.style.alignItems = 'center';
    titleWrap.style.gap = '6px';
    const arrow = document.createElement('span');
    arrow.textContent = edge.collapsed ? '▸' : '▾';
    const title = document.createElement('strong');
    title.textContent = `→ ${edge.to || '(choose target)'}`;
    titleWrap.appendChild(arrow);
    titleWrap.appendChild(title);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove edge';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      nodeState.edges.splice(edgeIndex, 1);
      onChange(true);
    });

    head.appendChild(titleWrap);
    head.appendChild(removeBtn);
    head.addEventListener('click', () => {
      edge.collapsed = !edge.collapsed;
      onChange(false);
    });
    wrap.appendChild(head);

    if (!edge.collapsed) {
      const body = document.createElement('div');
      body.style.padding = '8px';

      const rawToggleRow = document.createElement('div');
      rawToggleRow.className = 'btn-row';
      rawToggleRow.style.marginBottom = '8px';
      const rawToggle = document.createElement('button');
      rawToggle.textContent = edge.rawMode ? 'Use form builder' : 'Edit whole edge as YAML';
      rawToggle.addEventListener('click', () => {
        if (!edge.rawMode && !edge.rawText) edge.rawText = S.buildEdgeYaml(edge);
        edge.rawMode = !edge.rawMode;
        onChange(true);
      });
      rawToggleRow.appendChild(rawToggle);
      body.appendChild(rawToggleRow);

      if (edge.rawMode) {
        const ta = document.createElement('textarea');
        ta.className = 'yaml-edit';
        ta.spellcheck = false;
        ta.value = edge.rawText || '';
        ta.addEventListener('input', () => {
          edge.rawText = ta.value;
          onChange('light');
        });
        body.appendChild(ta);
      } else {
        body.appendChild(fieldLabel('Target node'));
        const toSelect = document.createElement('select');
        toSelect.className = 'inline-select';
        state.graph.nodes.forEach((n) => {
          const opt = document.createElement('option');
          opt.value = n.id;
          opt.textContent = n.id;
          toSelect.appendChild(opt);
        });
        if (edge.to) toSelect.value = edge.to;
        toSelect.addEventListener('change', () => {
          edge.to = toSelect.value;
          edgeOnChange(true);
        });
        body.appendChild(toSelect);

        const spacer1 = document.createElement('div');
        spacer1.style.height = '10px';
        body.appendChild(spacer1);

        renderTypedList(body, 'Conditions (must be true to build)', edge.conditions, S.CONDITION_TYPES, edgeOnChange);

        const spacer2 = document.createElement('div');
        spacer2.style.height = '10px';
        body.appendChild(spacer2);

        body.appendChild(fieldLabel(`Steps (${edge.steps.length})`));
        edge.steps.forEach((step, si) => {
          body.appendChild(
            renderStepBlock(step, edgeOnChange, () => {
              edge.steps.splice(si, 1);
              edgeOnChange(true);
            })
          );
        });
        const addStepBtn = document.createElement('button');
        addStepBtn.textContent = '+ Add step';
        addStepBtn.addEventListener('click', () => {
          edge.steps.push({ kind: 'tool', params: S.defaultParamsFor(S.STEP_KINDS.tool.fields), rawMode: false });
          edgeOnChange(true);
        });
        body.appendChild(addStepBtn);

        const spacer3 = document.createElement('div');
        spacer3.style.height = '10px';
        body.appendChild(spacer3);

        renderTypedList(body, 'On completed (spawn/delete/effects)', edge.completed, S.ACTION_TYPES, edgeOnChange);
      }

      wrap.appendChild(body);
    }
    container.appendChild(wrap);
  }

  function renderBuilder() {
    if (!openDraft) return;
    const ns = openDraft.state;
    sidePanelTitle.textContent = `Node: ${ns.id}`;
    clearNode(sidePanelBody);

    const onChange = (dirty) => {
      if (dirty === 'light') {
        markDirtyLight();
        return;
      }
      if (dirty !== false) markDirty();
      renderBuilder();
    };

    const rawToggleRow = document.createElement('div');
    rawToggleRow.className = 'btn-row';
    rawToggleRow.style.marginBottom = '10px';
    const rawToggle = document.createElement('button');
    rawToggle.textContent = ns.rawMode ? 'Use form builder' : 'Edit whole node as YAML';
    rawToggle.addEventListener('click', () => {
      if (!ns.rawMode && !ns.rawText) ns.rawText = S.buildNodeYaml(ns);
      ns.rawMode = !ns.rawMode;
      onChange(true);
    });
    rawToggleRow.appendChild(rawToggle);
    sidePanelBody.appendChild(rawToggleRow);

    if (ns.rawMode) {
      const ta = document.createElement('textarea');
      ta.className = 'yaml-edit';
      ta.style.minHeight = '280px';
      ta.spellcheck = false;
      ta.value = ns.rawText || '';
      ta.addEventListener('input', () => {
        ns.rawText = ta.value;
        markDirtyLight();
      });
      sidePanelBody.appendChild(ta);
    } else {
      sidePanelBody.appendChild(fieldLabel('Node id'));
      const idInput = document.createElement('input');
      idInput.type = 'text';
      idInput.value = ns.id;
      idInput.addEventListener('input', () => {
        ns.id = idInput.value;
        ns.rawText = '';
        markDirtyLight();
      });
      sidePanelBody.appendChild(idInput);

      const noteIfStart =
        state.graph.start === state.graph.nodes[openDraft.nodeIndex].id;
      if (noteIfStart) {
        const note = document.createElement('div');
        note.className = 'field-label';
        note.style.marginTop = '4px';
        note.textContent = `⚠ This is the graph's start node — renaming it won't update "start:" automatically.`;
        sidePanelBody.appendChild(note);
      }

      const spacer0 = document.createElement('div');
      spacer0.style.height = '8px';
      sidePanelBody.appendChild(spacer0);

      sidePanelBody.appendChild(fieldLabel('Entity prototype (blank = no entity yet)'));
      const entityInput = document.createElement('input');
      entityInput.type = 'text';
      entityInput.placeholder = 'e.g. Girder, WallSolid…';
      entityInput.value = ns.entity;
      entityInput.addEventListener('input', () => {
        ns.entity = entityInput.value;
        ns.rawText = '';
        markDirtyLight();
      });
      sidePanelBody.appendChild(entityInput);

      const spacer1 = document.createElement('div');
      spacer1.style.height = '10px';
      sidePanelBody.appendChild(spacer1);

      renderTypedList(sidePanelBody, `Actions on arrival (${ns.actions.length})`, ns.actions, S.ACTION_TYPES, onChange);

      const spacer2 = document.createElement('div');
      spacer2.style.height = '14px';
      sidePanelBody.appendChild(spacer2);

      sidePanelBody.appendChild(fieldLabel(`Outgoing edges — plug in where this node leads (${ns.edges.length})`));
      ns.edges.forEach((edge, ei) => {
        renderEdgeBlock(sidePanelBody, edge, ei, ns, openDraft.focusEdgeIndex === ei, onChange);
      });
      const addEdgeBtn = document.createElement('button');
      addEdgeBtn.className = 'primary';
      addEdgeBtn.textContent = '+ Add edge';
      addEdgeBtn.addEventListener('click', () => {
        const target = state.graph.nodes.find((n) => n.id !== ns.id);
        ns.edges.push({
          to: target ? target.id : '',
          conditions: [],
          completed: [],
          steps: [],
          collapsed: false,
          rawMode: false,
          rawText: '',
        });
        openDraft.focusEdgeIndex = ns.edges.length - 1;
        onChange(true);
      });
      sidePanelBody.appendChild(addEdgeBtn);
    }

    // ---- footer: save / reveal / delete ----
    const footer = document.createElement('div');
    footer.className = 'btn-row';
    footer.style.marginTop = '14px';
    footer.style.borderTop = '1px solid var(--vscode-panel-border, #444)';
    footer.style.paddingTop = '10px';

    const saveBtn = document.createElement('button');
    saveBtn.id = 'saveNodeBtn';
    saveBtn.className = 'primary';
    saveBtn.textContent = openDraft.dirty ? 'Save node ●' : 'Save node';
    saveBtn.addEventListener('click', () => {
      const node = state.graph.nodes[openDraft.nodeIndex];
      // If the id changed, fix up any of THIS node's own self-referencing
      // edges before serializing (edges elsewhere in the graph pointing at
      // the old id are handled by the extension in the same save).
      if (ns.id !== ns.originalId) {
        ns.edges.forEach((e) => {
          if (e.to === ns.originalId) e.to = ns.id;
        });
      }
      const text = S.buildNodeYaml(ns);
      vscode.postMessage({
        type: 'saveEditable',
        graphId: state.graph.id,
        range: node.range,
        text,
        indentUnit: node.indentUnit,
        target: { kind: 'node', nodeIndex: openDraft.nodeIndex },
        renameFrom: ns.originalId,
        newId: ns.id,
      });
      ns.originalId = ns.id;
      openDraft.dirty = false;
    });

    const duplicateBtn = document.createElement('button');
    duplicateBtn.textContent = '⎘ Duplicate node';
    duplicateBtn.title = 'Create a copy of this node (with a new id) to build on';
    duplicateBtn.addEventListener('click', async () => {
      const suggested = `${ns.id}Copy`;
      const newId = await textModal('Duplicate node', 'New node id', suggested);
      if (!newId) return;
      vscode.postMessage({
        type: 'duplicateNode',
        graphId: state.graph.id,
        nodeIndex: openDraft.nodeIndex,
        newId,
      });
    });

    const revealBtn = document.createElement('button');
    revealBtn.textContent = 'Reveal in source';
    revealBtn.addEventListener('click', () => {
      const node = state.graph.nodes[openDraft.nodeIndex];
      vscode.postMessage({ type: 'reveal', range: node.range });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete node';
    deleteBtn.addEventListener('click', async () => {
      const node = state.graph.nodes[openDraft.nodeIndex];
      const ok = await confirmModal(
        `Delete node "${node.id}"? This removes it and all its outgoing edges. Edges from other nodes pointing to it will be left dangling.`
      );
      if (ok) {
        vscode.postMessage({
          type: 'deleteItem',
          graphId: state.graph.id,
          fullLineRange: node.fullLineRange,
          target: { kind: 'node', nodeIndex: openDraft.nodeIndex },
        });
        selection = null;
        openDraft = null;
        sidePanel.classList.add('hidden');
      }
    });

    footer.appendChild(saveBtn);
    footer.appendChild(duplicateBtn);
    footer.appendChild(revealBtn);
    footer.appendChild(deleteBtn);
    sidePanelBody.appendChild(footer);

    if (openDraft.dirty) {
      const hint = document.createElement('div');
      hint.id = 'unsavedHint';
      hint.className = 'field-label';
      hint.style.marginTop = '6px';
      hint.textContent = 'Unsaved changes — click "Save node" to write them into the file.';
      sidePanelBody.appendChild(hint);
    }
  }

  // ---------- add node ----------
  document.getElementById('addNodeBtn').addEventListener('click', async () => {
    const id = await textModal('New node', 'Node id', 'newNode');
    if (id) vscode.postMessage({ type: 'addNode', graphId: state.graph.id, id });
  });

  // ---------- lightweight modals (avoid relying on window.prompt/confirm) ----------
  function textModal(title, label, def) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      const h = document.createElement('div');
      h.style.fontWeight = '600';
      h.style.marginBottom = '8px';
      h.textContent = title;
      const fl = fieldLabel(label);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = def || '';
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.className = 'primary';
      ok.textContent = 'Create';
      actions.appendChild(cancel);
      actions.appendChild(ok);
      box.appendChild(h);
      box.appendChild(fl);
      box.appendChild(input);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      input.focus();
      input.select();
      function close(val) {
        document.body.removeChild(overlay);
        resolve(val);
      }
      cancel.addEventListener('click', () => close(null));
      ok.addEventListener('click', () => close(input.value.trim() || null));
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') close(input.value.trim() || null);
        if (ev.key === 'Escape') close(null);
      });
    });
  }

  function confirmModal(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      const p = document.createElement('div');
      p.style.marginBottom = '14px';
      p.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.className = 'danger';
      ok.textContent = 'Delete';
      actions.appendChild(cancel);
      actions.appendChild(ok);
      box.appendChild(p);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      function close(val) {
        document.body.removeChild(overlay);
        resolve(val);
      }
      cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
    });
  }

  // ---------- find usages (cross-file: construction prototypes that build this graph) ----------
  document.getElementById('findUsagesBtn').addEventListener('click', () => {
    if (!state.graph) return;
    const btn = document.getElementById('findUsagesBtn');
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    vscode.postMessage({ type: 'findUsages', graphId: state.graph.id });
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '🔗 Find usages';
    }, 400);
  });

  function showUsagesModal(usages) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.style.width = '420px';
    box.style.maxHeight = '70vh';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.marginBottom = '8px';
    title.textContent = usages.length
      ? `${usages.length} construction prototype${usages.length === 1 ? '' : 's'} build this graph`
      : 'No construction prototypes found for this graph';
    box.appendChild(title);

    if (!usages.length) {
      const hint = document.createElement('div');
      hint.className = 'field-label';
      hint.style.marginBottom = '10px';
      hint.textContent =
        'This graph might not be hooked up to a "type: construction" prototype yet, or it lives in a file that hasn\'t been scanned. Try "SS14: Rescan Workspace" from the command palette after adding one.';
      box.appendChild(hint);
    } else {
      const list = document.createElement('div');
      list.style.overflowY = 'auto';
      list.style.marginBottom = '10px';
      usages.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'edge-list-item';
        row.style.display = 'block';
        row.style.padding = '8px';
        row.style.marginBottom = '6px';
        row.style.border = '1px solid var(--vscode-panel-border, #444)';
        row.style.borderRadius = '4px';
        row.style.cursor = 'pointer';
        const line1 = document.createElement('div');
        line1.innerHTML = `<strong>${u.id}</strong>`;
        const line2 = document.createElement('div');
        line2.className = 'field-label';
        line2.style.marginTop = '2px';
        line2.textContent = `${u.startNode || '?'} → ${u.targetNode || '?'}${u.category ? '  ·  ' + u.category : ''}`;
        const line3 = document.createElement('div');
        line3.className = 'field-label';
        line3.style.marginTop = '2px';
        line3.textContent = u.file;
        row.appendChild(line1);
        row.appendChild(line2);
        row.appendChild(line3);
        row.addEventListener('click', () => {
          vscode.postMessage({ type: 'openUsage', fileUri: u.fileUri, range: u.range });
        });
        list.appendChild(row);
      });
      box.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => document.body.removeChild(overlay));
    actions.appendChild(closeBtn);
    box.appendChild(actions);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }
})();
