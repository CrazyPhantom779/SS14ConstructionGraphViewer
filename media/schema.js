// schema.js (webview) — knowledge of the known SS14 construction-graph
// action/condition/step types, used to render nice form fields, PLUS a
// generic key/value editor layer so that:
//   (a) fields this schema doesn't know about are never silently dropped
//       on save, and
//   (b) action/condition/step types this schema doesn't know about at all
//       (future SS14 additions, or fork-specific types) still get a fully
//       structured, no-YAML-required editor — never forced into raw mode.
//
// Design: every typed item (action/condition) and every step carries its
// full `params` object as the single source of truth. Known fields (from
// the maps below) render as labeled inputs / enum dropdowns bound directly
// into that same params object. Any OTHER keys present in params (from an
// unrecognized type, or extra fields a fork added to a known type) render
// in an "Other fields" section as generic key/value rows, addable/removable
// freely. Saving always serializes the FULL params object, known + unknown
// keys alike, so nothing you didn't touch is ever lost.
//
// A raw-YAML toggle remains available at every level (item/step/edge/node)
// as an additional power-user option, but is never required for anything.

(function (global) {
  const F = {
    text: (key, label, opts) => ({ key, label, type: 'text', ...opts }),
    number: (key, label, opts) => ({ key, label, type: 'number', ...opts }),
    bool: (key, label, opts) => ({ key, label, type: 'bool', ...opts }),
    enumField: (key, label, options, opts) => ({
      key,
      label,
      type: 'enum',
      options,
      ...opts,
    }),
    taglist: (key, label, opts) => ({ key, label, type: 'taglist', ...opts }),
    entityRef: (key, label, opts) => ({ key, label, type: 'entityRef', ...opts }),
  };

  const TOOL_QUALITIES = [
    'Welding', 'Cutting', 'Prying', 'Screwing', 'Anchoring', 'Sawing',
    'Rolling', 'Pulsing', 'Pointing', 'Blending', 'Slicing', 'Bolting',
  ];
  const MATERIALS = [
    'Steel', 'Glass', 'ReinforcedGlass', 'Plasteel', 'Plastic', 'Cloth',
    'Wood', 'Gold', 'Silver', 'Plasma', 'Uranium', 'Brass', 'Bananium',
    'Cardboard', 'Durathread',
  ];

  // ---- Actions (used for node `actions:` and edge `completed:`) ----
  const ACTION_TYPES = {
    SpawnPrototype: {
      label: 'Spawn prototype',
      fields: [
        F.entityRef('prototype', 'Entity prototype ID'),
        F.number('amount', 'Amount', { default: 1 }),
      ],
    },
    GivePrototype: {
      label: 'Give prototype (to hands)',
      fields: [
        F.entityRef('prototype', 'Entity prototype ID'),
        F.number('amount', 'Amount', { default: 1 }),
      ],
    },
    DeleteEntity: { label: 'Delete entity', fields: [] },
    SetAnchor: {
      label: 'Set anchored',
      fields: [F.bool('value', 'Anchored', { default: true })],
    },
    SnapToGrid: {
      label: 'Snap to grid',
      fields: [
        F.enumField('offset', 'Offset', ['Center', 'Edge'], { default: 'Center' }),
        F.bool('southRotation', 'Force south rotation', { default: false }),
      ],
    },
    PlaySound: {
      label: 'Play sound',
      fields: [
        F.text('sound', 'Sound file path', { placeholder: '/Audio/...' }),
        F.text('soundCollection', 'Sound collection (instead of path)'),
      ],
    },
    PopupUser: {
      label: 'Popup message to user',
      fields: [
        F.text('text', 'Message text'),
        F.bool('cursor', 'Show at cursor', { default: false }),
      ],
    },
    SpriteChange: {
      label: 'Change sprite',
      fields: [
        F.number('layer', 'Layer', { default: 0 }),
        F.text('sprite', 'RSI path'),
        F.text('state', 'RSI state'),
        F.text('texture', 'Texture path (instead of RSI+state)'),
      ],
    },
    SpriteStateChange: {
      label: 'Change sprite state',
      fields: [
        F.number('layer', 'Layer', { default: 0 }),
        F.text('state', 'RSI state'),
      ],
    },
    VisualizerDataInt: {
      label: 'Set visualizer int data',
      fields: [
        F.text('key', 'Visualizer key'),
        F.number('data', 'Value'),
      ],
    },
    BuildComputer: {
      label: 'Build computer (from board)',
      fields: [F.text('container', 'Board container name', { default: 'board' })],
    },
  };

  // ---- Conditions (edge `conditions:`) ----
  const CONDITION_TYPES = {
    EntityAnchored: {
      label: 'Entity anchored',
      fields: [F.bool('anchored', 'Must be anchored', { default: true })],
    },
    ComponentInTile: {
      label: 'Component in tile',
      fields: [
        F.text('component', 'Component name'),
        F.bool('hasEntity', 'Requires matching entity', { default: true }),
      ],
    },
    ContainerEmpty: {
      label: 'Container empty',
      fields: [F.text('container', 'Container name')],
    },
    WirePanel: {
      label: 'Wire panel state',
      fields: [F.bool('open', 'Panel must be open', { default: true })],
    },
  };

  // ---- Steps (edge `steps:`) — discriminated by which key is present ----
  const STEP_KINDS = {
    tool: {
      label: '🔧 Use tool',
      discriminantKey: 'tool',
      fields: [
        F.enumField('tool', 'Tool quality', TOOL_QUALITIES, { default: 'Welding' }),
        F.number('doAfter', 'Do-after time (s)', { default: 1 }),
      ],
    },
    material: {
      label: '🧱 Insert material',
      discriminantKey: 'material',
      fields: [
        F.enumField('material', 'Material (stack type)', MATERIALS, {
          default: 'Steel',
          allowCustom: true,
        }),
        F.number('amount', 'Amount', { default: 1 }),
        F.number('doAfter', 'Do-after time (s)', { default: 0 }),
        F.text('store', 'Store consumed item as (optional)'),
      ],
    },
    component: {
      label: '🔌 Requires component',
      discriminantKey: 'component',
      fields: [
        F.text('component', 'Component name'),
        F.text('store', 'Store as (optional)'),
        F.text('name', 'Display name (optional)'),
        F.text('icon', 'Icon prototype (optional)'),
        F.number('doAfter', 'Do-after time (s)'),
      ],
    },
    prototype: {
      label: '📦 Insert entity prototype',
      discriminantKey: 'prototype',
      fields: [
        F.entityRef('prototype', 'Entity prototype ID'),
        F.text('store', 'Store as (optional)'),
        F.text('name', 'Display name (optional)'),
        F.text('icon', 'Icon prototype (optional)'),
        F.number('doAfter', 'Do-after time (s)'),
      ],
    },
    tag: {
      label: '🏷️ Insert entity with tag',
      discriminantKey: 'tag',
      fields: [
        F.text('tag', 'Tag'),
        F.text('store', 'Store as (optional)'),
        F.text('name', 'Display name (optional)'),
        F.text('icon', 'Icon prototype (optional)'),
        F.number('doAfter', 'Do-after time (s)'),
      ],
    },
    multiTag: {
      label: '🏷️ Insert entity with tags',
      discriminantKey: 'allTags',
      fields: [
        F.taglist('allTags', 'Must have ALL tags'),
        F.taglist('anyTags', 'Must have ANY tag'),
        F.text('store', 'Store as (optional)'),
        F.text('name', 'Display name (optional)'),
        F.number('doAfter', 'Do-after time (s)'),
      ],
    },
    generic: {
      label: '❔ Custom / other step',
      discriminantKey: null,
      fields: [],
    },
  };

  function defaultParamsFor(fields) {
    const out = {};
    fields.forEach((f) => {
      if (f.default !== undefined) out[f.key] = f.default;
    });
    return out;
  }

  /** Keys in `params` that aren't covered by `fields` - never dropped, always
   * shown in the "Other fields" generic editor. */
  function extraKeysOf(params, fields) {
    const known = new Set((fields || []).map((f) => f.key));
    return Object.keys(params || {}).filter((k) => !known.has(k));
  }

  function inferGenericType(value) {
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'taglist';
    return 'text';
  }

  // ---------------- YAML generation ----------------
  // All generated text is "dedented" (first line at column 0, YAML-nesting
  // relative) so it slots directly into the existing splice/reindent pipeline
  // the same way hand-edited raw text does.

  function yamlScalar(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    if (s === '') return null;
    const needsQuote =
      /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
      /[:#]/.test(s) ||
      /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
      /^-?\d+(\.\d+)?$/.test(s) ||
      s.trim() !== s;
    if (needsQuote) return JSON.stringify(s);
    return s;
  }

  function indentLines(text, spaces) {
    const pad = ' '.repeat(spaces);
    return text
      .split('\n')
      .map((l) => (l.trim() === '' ? l : pad + l))
      .join('\n');
  }

  /** Emit `key: value` (or a nested list for arrays), used both for known
   * schema fields and for generic/"other" fields alike - same code path, so
   * nothing formats differently just because we don't have a label for it. */
  function emitKeyValue(lines, prefix, key, value) {
    if (Array.isArray(value)) {
      if (!value.length) return;
      lines.push(`${prefix}${key}:`);
      value.forEach((v) => lines.push(`    - ${yamlScalar(v)}`));
    } else if (value && typeof value === 'object') {
      // Nested plain object (rare for this format, but don't lose it) -
      // emit as an inline flow map so we never crash on unexpected shapes.
      lines.push(`${prefix}${key}: ${JSON.stringify(value)}`);
    } else {
      if (value === undefined || value === null || value === '') return;
      lines.push(`${prefix}${key}: ${yamlScalar(value)}`);
    }
  }

  /** Render a single typed item (`- !type:Tag\n    field: val`) at column 0.
   * Always serializes the FULL params object (known fields via their nice
   * key, plus any extra/unknown keys) - never just the modeled subset. */
  function buildTypedItemYaml(item) {
    if (item.rawMode) return `- ${indentLines(item.rawText || '', 2).trimStart()}`;
    const lines = [`- !type:${item.tag}`];
    const schema = item._schema || { fields: [] };
    const orderedKeys = [];
    (schema.fields || []).forEach((f) => orderedKeys.push(f.key));
    extraKeysOf(item.params, schema.fields).forEach((k) => orderedKeys.push(k));
    orderedKeys.forEach((key) => emitKeyValue(lines, '  ', key, item.params[key]));
    return lines.join('\n');
  }

  function buildTypedListYaml(key, items) {
    if (!items || !items.length) return '';
    const body = items.map(buildTypedItemYaml).join('\n');
    return `${key}:\n${indentLines(body, 2)}`;
  }

  function buildStepYaml(step) {
    if (step.rawMode) return `- ${indentLines(step.rawText || '', 2).trimStart()}`;
    const schema = STEP_KINDS[step.kind] || STEP_KINDS.generic;
    const lines = [];
    const orderedKeys = [];
    (schema.fields || []).forEach((f) => orderedKeys.push(f.key));
    extraKeysOf(step.params, schema.fields).forEach((k) => orderedKeys.push(k));
    orderedKeys.forEach((key, i) => {
      const value = step.params[key];
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) {
        if (!value.length) return;
        lines.push(`${lines.length === 0 ? '- ' : '  '}${key}:`);
        value.forEach((v) => lines.push(`    - ${yamlScalar(v)}`));
      } else {
        lines.push(`${lines.length === 0 ? '- ' : '  '}${key}: ${yamlScalar(value)}`);
      }
    });
    if (!lines.length) lines.push(`- {}`);
    if (step.completed && step.completed.length) {
      lines.push(`  ${buildTypedListYaml('completed', step.completed).replace(/\n/g, '\n  ')}`);
    }
    return lines.join('\n');
  }

  function buildStepListYaml(steps) {
    if (!steps || !steps.length) return '';
    const body = steps.map(buildStepYaml).join('\n');
    return `steps:\n${indentLines(body, 2)}`;
  }

  /** Build the full dedented YAML text for one edge, from structured state. */
  function buildEdgeYaml(edge) {
    if (edge.rawMode) return edge.rawText || '';
    const lines = [`to: ${yamlScalar(edge.to) || edge.to}`];
    const conds = buildTypedListYaml('conditions', edge.conditions);
    if (conds) lines.push(conds);
    const completed = buildTypedListYaml('completed', edge.completed);
    if (completed) lines.push(completed);
    const steps = buildStepListYaml(edge.steps);
    if (steps) lines.push(steps);
    return lines.join('\n');
  }

  /** Dynamic entity specifiers like `!type:BoardNodeEntity { container: x }`
   * are rare but real (SS14's shared Machine graph uses exactly this) -
   * rendered as inline flow style to match the convention used in the wild. */
  function buildEntitySpecifierInline(spec) {
    const keys = Object.keys(spec.params || {});
    const parts = keys
      .map((k) => (spec.params[k] === undefined || spec.params[k] === null || spec.params[k] === '' ? null : `${k}: ${yamlScalar(spec.params[k])}`))
      .filter(Boolean);
    return `!type:${spec.tag}` + (parts.length ? ` { ${parts.join(', ')} }` : '');
  }

  /** Build the full dedented YAML text for one node (incl. all its edges). */
  function buildNodeYaml(node) {
    if (node.rawMode) return node.rawText || '';
    const lines = [`node: ${node.id}`];
    if (node.entitySpecifier) {
      const value = node.entitySpecifier.rawMode
        ? node.entitySpecifier.rawText || buildEntitySpecifierInline(node.entitySpecifier)
        : buildEntitySpecifierInline(node.entitySpecifier);
      lines.push(`entity: ${value}`);
    } else if (node.entity) {
      lines.push(`entity: ${yamlScalar(node.entity)}`);
    }
    const actions = buildTypedListYaml('actions', node.actions);
    if (actions) lines.push(actions);
    if (node.edges && node.edges.length) {
      const body = node.edges
        .map((e) => `- ${indentLines(buildEdgeYaml(e), 2).trimStart()}`)
        .join('\n');
      lines.push(`edges:\n${indentLines(body, 2)}`);
    }
    return lines.join('\n');
  }

  global.SS14Schema = {
    ACTION_TYPES,
    CONDITION_TYPES,
    STEP_KINDS,
    TOOL_QUALITIES,
    MATERIALS,
    defaultParamsFor,
    extraKeysOf,
    inferGenericType,
    buildNodeYaml,
    buildEdgeYaml,
    buildTypedItemYaml,
    buildStepYaml,
    buildEntitySpecifierInline,
  };
})(window);
