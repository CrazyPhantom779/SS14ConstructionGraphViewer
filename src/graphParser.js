// graphParser.js
// Parses SS14 `constructionGraph` prototypes out of a YAML document, using the
// `yaml` package's CST/AST so we get exact character ranges for every node and
// edge. Those ranges are what let the webview edit a node's YAML and splice it
// back into the real file untouched everywhere else. Actions/conditions/steps
// are exposed as full {tag, params} objects (not just display labels) so the
// webview can populate real form fields, not just read-only summaries.

const YAML = require('yaml');

function tagLabel(tag) {
  // Custom SS14 tags look like "!type:SnapToGrid". Plain YAML tags (maps,
  // seqs, scalars) look like "tag:yaml.org,2002:map" and aren't interesting.
  if (!tag) return null;
  const m = /^!type:(.+)$/.exec(tag);
  return m ? m[1] : null;
}

function safeToJSON(node) {
  try {
    return node && typeof node.toJSON === 'function' ? node.toJSON() : node;
  } catch (e) {
    return undefined;
  }
}

/** A seq of `!type:X` items -> [{ tag: 'X', params: {...} }] */
function typedListOf(seqNode) {
  if (!seqNode || !seqNode.items) return [];
  return seqNode.items
    .map((item) => {
      const tag = tagLabel(item && item.tag);
      if (!tag) return null;
      const params = safeToJSON(item) || {};
      return { tag, params };
    })
    .filter(Boolean);
}

function stepKindOf(json) {
  const has = (k) => Object.prototype.hasOwnProperty.call(json, k);
  if (has('tool')) return 'tool';
  if (has('material')) return 'material';
  if (has('component')) return 'component';
  if (has('prototype')) return 'prototype';
  if (has('tag')) return 'tag';
  if (has('allTags') || has('anyTags')) return 'multiTag';
  return 'generic'; // unrecognized shape (future/fork step type) - still fully editable generically
}

function stepsOf(seqNode) {
  if (!seqNode || !seqNode.items) return [];
  return seqNode.items.map((item) => {
    const params = safeToJSON(item) || {};
    return { kind: stepKindOf(params), params };
  });
}

function stepShortLabel(step) {
  const p = step.params;
  switch (step.kind) {
    case 'tool':
      return `Tool: ${p.tool}`;
    case 'material':
      return `Material: ${p.material} x${p.amount != null ? p.amount : '?'}`;
    case 'component':
      return `Component: ${p.component}`;
    case 'prototype':
      return `Prototype: ${p.prototype}`;
    case 'tag':
      return `Tag: ${p.tag}`;
    case 'multiTag': {
      const parts = [];
      if (p.allTags) parts.push(`all(${p.allTags.join(', ')})`);
      if (p.anyTags) parts.push(`any(${p.anyTags.join(', ')})`);
      return `Tags: ${parts.join(' + ')}`;
    }
    default:
      return `Custom (${Object.keys(p)[0] || 'empty'}${Object.keys(p).length > 1 ? '…' : ''})`;
  }
}

/** Short human label for an edge, used on the diagram itself. */
function summarizeEdgeLabel(edge) {
  const parts = [];
  if (edge.steps.length === 1) {
    parts.push(stepShortLabel(edge.steps[0]));
  } else if (edge.steps.length > 1) {
    parts.push(`${edge.steps.length} steps`);
  }
  if (edge.conditions.length) {
    parts.push(
      `if ${edge.conditions[0].tag}${edge.conditions.length > 1 ? '…' : ''}`
    );
  }
  return parts.join('  ·  ');
}

/**
 * Compute the "dedented" editable text for an AST node range, plus the
 * indentUnit needed to re-indent it when saving back. Used as the raw-YAML
 * fallback / escape hatch at both the node and edge level.
 */
function extractEditable(text, range) {
  const raw = text.slice(range[0], range[1]);
  const lineStart = text.lastIndexOf('\n', range[0] - 1) + 1;
  const indentUnit = range[0] - lineStart;
  const lines = raw.split('\n');
  const dedented = lines
    .map((line, i) => {
      if (i === 0) return line;
      if (line.slice(0, indentUnit).trim() === '') {
        return line.slice(indentUnit);
      }
      return line; // shorter than indentUnit (blank line) - leave as-is
    })
    .join('\n');
  return { text: dedented.replace(/\s+$/, ''), indentUnit };
}

/** Reverse of extractEditable: re-indent generated/edited text for insertion. */
function reindentForSave(editedText, indentUnit) {
  const pad = ' '.repeat(indentUnit);
  return editedText
    .split('\n')
    .map((line, i) => (i === 0 || line.trim() === '' ? line : pad + line))
    .join('\n');
}

/** Full line-span of an item (including its "- " marker and trailing newline),
 * used for clean deletion. */
function fullLineRange(text, itemRange, nextItemRange) {
  const lineStart = text.lastIndexOf('\n', itemRange[0] - 1) + 1;
  let end;
  if (nextItemRange) {
    end = text.lastIndexOf('\n', nextItemRange[0] - 1) + 1;
  } else {
    end = itemRange[1];
    if (text[end] === '\n') end += 1;
  }
  return [lineStart, end];
}

function parseConstructionGraphs(text) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { uniqueKeys: false, lineCounter });
  const graphs = [];
  const errors = (doc.errors || []).map((e) => e.message);

  const topItems =
    doc.contents && doc.contents.items ? doc.contents.items : [];

  topItems.forEach((item, topIndex) => {
    if (!item || typeof item.get !== 'function') return;
    let type;
    try {
      type = item.get('type');
    } catch (e) {
      return;
    }
    if (type !== 'constructionGraph') return;

    const id = safeToJSON(item.get('id', true));
    const start = safeToJSON(item.get('start', true));
    const graphSeq = item.get('graph', true);
    const nodeItems = graphSeq && graphSeq.items ? graphSeq.items : [];

    const nodes = nodeItems.map((nodeMap, i) => {
      const nodeId = safeToJSON(nodeMap.get('node', true));
      const entity = safeToJSON(nodeMap.get('entity', true));
      const actionsSeq = nodeMap.get('actions', true);
      const edgesSeq = nodeMap.get('edges', true);
      const edgeItems = edgesSeq && edgesSeq.items ? edgesSeq.items : [];

      const edges = edgeItems.map((edgeMap, j) => {
        const toNode = edgeMap.get('to', true);
        const to = safeToJSON(toNode);
        const conditionsSeq = edgeMap.get('conditions', true);
        const completedSeq = edgeMap.get('completed', true);
        const stepsSeq = edgeMap.get('steps', true);
        const steps = stepsOf(stepsSeq);
        const nextEdge = edgeItems[j + 1];
        const pos = lineCounter.linePos(edgeMap.range[0]);
        const editable = extractEditable(text, edgeMap.range.slice(0, 2));
        const edge = {
          index: j,
          to,
          toValueRange: toNode ? toNode.range.slice(0, 2) : null,
          range: edgeMap.range.slice(0, 2),
          fullLineRange: fullLineRange(
            text,
            edgeMap.range,
            nextEdge ? nextEdge.range : null
          ),
          line: pos.line,
          conditions: typedListOf(conditionsSeq),
          completed: typedListOf(completedSeq),
          steps,
          editableText: editable.text,
          indentUnit: editable.indentUnit,
        };
        edge.label = summarizeEdgeLabel(edge);
        return edge;
      });

      const nextNode = nodeItems[i + 1];
      const pos = lineCounter.linePos(nodeMap.range[0]);
      const editable = extractEditable(text, nodeMap.range.slice(0, 2));
      return {
        index: i,
        id: nodeId,
        entity: entity || null,
        range: nodeMap.range.slice(0, 2),
        fullLineRange: fullLineRange(
          text,
          nodeMap.range,
          nextNode ? nextNode.range : null
        ),
        line: pos.line,
        actions: typedListOf(actionsSeq),
        edges,
        editableText: editable.text,
        indentUnit: editable.indentUnit,
      };
    });

    const graphPos = lineCounter.linePos(item.range[0]);
    const graph = {
      graphIndex: topIndex,
      id: id || `(unnamed graph #${topIndex})`,
      start: start || null,
      range: item.range.slice(0, 2),
      line: graphPos.line,
      graphSeqRange: graphSeq ? graphSeq.range.slice(0, 2) : null,
      nodes,
    };
    graph.warnings = computeGraphWarnings(graph);
    graphs.push(graph);
  });

  return { errors, graphs };
}

/** Non-fatal structural issues surfaced in the UI (not blocking - SS14's own
 * graphs sometimes intentionally have "soft" issues, e.g. a deconstruct edge
 * that legitimately loops back). Purely informational. */
function computeGraphWarnings(graph) {
  const warnings = [];
  const idCounts = new Map();
  graph.nodes.forEach((n) => {
    idCounts.set(n.id, (idCounts.get(n.id) || 0) + 1);
  });
  idCounts.forEach((count, id) => {
    if (count > 1) {
      warnings.push({ type: 'duplicateNode', nodeId: id, message: `Node id "${id}" is used ${count} times.` });
    }
  });
  if (graph.start && !graph.nodes.some((n) => n.id === graph.start)) {
    warnings.push({
      type: 'missingStart',
      message: `start: "${graph.start}" does not match any node in this graph.`,
    });
  }
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  graph.nodes.forEach((n) => {
    n.edges.forEach((e) => {
      if (e.to && !nodeIds.has(e.to)) {
        warnings.push({
          type: 'danglingEdge',
          nodeId: n.id,
          edgeIndex: e.index,
          message: `Edge "${n.id}" → "${e.to}" points to a node that doesn't exist in this graph.`,
        });
      }
    });
  });
  return warnings;
}

/** Parses the separate `type: construction` prototypes that make a
 * constructionGraph buildable in-game (category, placementMode, and
 * crucially which node is the entry point / finished result). These are
 * very often in a different file than the graph itself. */
function parseConstructionPrototypes(text) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { uniqueKeys: false, lineCounter });
  const out = [];
  const topItems = doc.contents && doc.contents.items ? doc.contents.items : [];
  topItems.forEach((item) => {
    if (!item || typeof item.get !== 'function') return;
    let type;
    try {
      type = item.get('type');
    } catch (e) {
      return;
    }
    if (type !== 'construction') return;
    const json = safeToJSON(item) || {};
    const pos = lineCounter.linePos(item.range[0]);
    out.push({
      id: json.id,
      graph: json.graph,
      startNode: json.startNode,
      targetNode: json.targetNode,
      category: json.category,
      placementMode: json.placementMode,
      line: pos.line,
      range: item.range.slice(0, 2),
      raw: json,
    });
  });
  return out;
}

module.exports = {
  parseConstructionGraphs,
  parseConstructionPrototypes,
  extractEditable,
  reindentForSave,
  fullLineRange,
  stepShortLabel,
};
