const vscode = require('vscode');
const path = require('path');
const {
  parseConstructionGraphs,
  parseConstructionPrototypes,
  parseMachineBoards,
  reindentForSave,
} = require('./graphParser.js');

const VIEW_TYPE = 'ss14ConstructionGraph.editor';
const MAP_VIEW_TYPE = 'ss14ConstructionGraph.map';

/** uriString -> graphId the user asked to jump straight to (via CodeLens),
 * consumed once by resolveCustomTextEditor. */
const pendingGraphSelection = new Map();

function looksLikeConstructionGraphFile(text) {
  return /(^|\n)\s*-\s*type:\s*constructionGraph\b/.test(text);
}
function looksLikeConstructionPrototypeFile(text) {
  return /(^|\n)\s*-\s*type:\s*construction\b/.test(text);
}

// ---------------- unified workspace scan ----------------
// One pass over every yaml file in the workspace, building everything the
// "Browse entity…" picker, "Find usages", and the repo-wide map need. This
// used to be three separate scans; now it's one, cached until the user asks
// to rescan (files change constantly during normal dev, so we don't try to
// track that automatically - a manual rescan command is enough).
/** @type {{entityPrototypes: {id:string,name:string}[], constructionGraphs: any[], constructionPrototypes: any[]} | null} */
let workspaceIndexCache = null;

function extractEntityPrototypesFromText(text) {
  const out = [];
  const lines = text.split('\n');
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const blockText = block.join('\n');
    if (/(^|\n)\s*type:\s*entity\b/.test(blockText)) {
      const idMatch = /(^|\n)\s*id:\s*(.+)/.exec(blockText);
      const nameMatch = /(^|\n)\s*name:\s*(.+)/.exec(blockText);
      if (idMatch) {
        const clean = (s) => s.trim().replace(/^["']|["']$/g, '');
        out.push({ id: clean(idMatch[2]), name: nameMatch ? clean(nameMatch[2]) : '' });
      }
    }
    block = [];
  };
  for (const line of lines) {
    if (/^-\s/.test(line)) flush();
    block.push(line);
  }
  flush();
  return out;
}

async function scanWorkspace(progress) {
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
    // findFiles silently returns nothing without an open workspace folder
    // (as opposed to just an open file) - surface that clearly instead of
    // just quietly finding zero of everything.
    vscode.window.showWarningMessage(
      'SS14 Construction Graph: no workspace folder is open, so cross-file features (Browse entity, Find usages, the repo map) have nothing to search. Use File > Open Folder… to open the repo root, not just this file.'
    );
    return { entityPrototypes: [], constructionGraphs: [], constructionPrototypes: [] };
  }
  const FILE_CAP = 30000;
  const files = await vscode.workspace.findFiles(
    '**/*.{yml,yaml}',
    '**/{.git,node_modules,bin,obj}/**',
    FILE_CAP
  );
  if (files.length >= FILE_CAP) {
    vscode.window.showWarningMessage(
      `SS14 Construction Graph: this workspace has at least ${FILE_CAP} yaml files - the scan may not have covered all of them, so some graphs/prototypes could be missing from "Find usages" and the repo map.`
    );
  }
  const entityPrototypes = [];
  const constructionGraphs = [];
  const constructionPrototypes = [];
  const machineBoards = [];
  let done = 0;
  for (const file of files) {
    try {
      const buf = await vscode.workspace.fs.readFile(file);
      const text = Buffer.from(buf).toString('utf8').replace(/^\uFEFF/, '');
      if (/type:\s*entity\b/.test(text)) {
        extractEntityPrototypesFromText(text).forEach((e) => entityPrototypes.push(e));
        try {
          parseMachineBoards(text).forEach((b) => machineBoards.push(b));
        } catch (e) {
          // a handful of entity files may have YAML quirks the AST parser
          // trips on - don't let that break the rest of the scan
        }
      }
      if (looksLikeConstructionGraphFile(text)) {
        const { graphs } = parseConstructionGraphs(text);
        graphs.forEach((g) => {
          constructionGraphs.push({
            id: g.id,
            nodeCount: g.nodes.length,
            start: g.start,
            file: file.toString(),
            line: g.line,
          });
        });
      }
      if (looksLikeConstructionPrototypeFile(text)) {
        parseConstructionPrototypes(text).forEach((p) => {
          constructionPrototypes.push({ ...p, file: file.toString() });
        });
      }
    } catch (e) {
      // unreadable/binary file - skip
    }
    done += 1;
    if (progress && done % 250 === 0) {
      progress.report({ message: `Scanned ${done}/${files.length} files…` });
    }
  }
  const seen = new Set();
  const dedupedEntities = [];
  for (const item of entityPrototypes) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    dedupedEntities.push(item);
  }
  dedupedEntities.sort((a, b) => a.id.localeCompare(b.id));
  const seenBoards = new Set();
  const dedupedBoards = [];
  for (const b of machineBoards) {
    if (!b.id || seenBoards.has(b.id)) continue;
    seenBoards.add(b.id);
    dedupedBoards.push(b);
  }
  dedupedBoards.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  return {
    entityPrototypes: dedupedEntities,
    constructionGraphs,
    constructionPrototypes,
    machineBoards: dedupedBoards,
  };
}

async function ensureWorkspaceIndex() {
  if (workspaceIndexCache) return workspaceIndexCache;
  workspaceIndexCache = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'SS14 Construction Graph: scanning workspace…',
      cancellable: false,
    },
    (progress) => scanWorkspace(progress)
  );
  return workspaceIndexCache;
}

function activate(context) {
  // ---- CodeLens: "🌳 View as graph" above each constructionGraph block,
  // and "🔗 links to graph X" above each construction prototype ----
  const codeLensProvider = {
    provideCodeLenses(document) {
      const cfg = vscode.workspace.getConfiguration('ss14ConstructionGraph');
      if (!cfg.get('autoDetect', true)) return [];
      const text = document.getText();
      const lenses = [];

      if (looksLikeConstructionGraphFile(text)) {
        let parsed;
        try {
          parsed = parseConstructionGraphs(text);
        } catch (e) {
          parsed = { graphs: [] };
        }
        parsed.graphs.forEach((g) => {
          const line = Math.max(0, g.line - 1);
          lenses.push(
            new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
              title: `$(type-hierarchy-sub) Open "${g.id}" in graph editor  ·  ${g.nodes.length} node${
                g.nodes.length === 1 ? '' : 's'
              }`,
              command: 'ss14ConstructionGraph.openGraphById',
              arguments: [document.uri, g.id],
            })
          );
        });
      }

      if (looksLikeConstructionPrototypeFile(text)) {
        let protos = [];
        try {
          protos = parseConstructionPrototypes(text);
        } catch (e) {
          protos = [];
        }
        protos.forEach((p) => {
          const line = Math.max(0, p.line - 1);
          lenses.push(
            new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
              title: `$(link) "${p.id}" builds graph "${p.graph}" (${p.startNode || '?'} → ${p.targetNode || '?'})`,
              command: 'ss14ConstructionGraph.openGraphByName',
              arguments: [p.graph],
            })
          );
        });
      }

      return lenses;
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'yaml' }, codeLensProvider)
  );

  // ---- Custom editor (the graph builder itself) ----
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new GraphEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorInstances: true,
    })
  );

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('ss14ConstructionGraph.open', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Open a YAML file with a constructionGraph first.');
        return;
      }
      const text = editor.document.getText();
      const { graphs, errors } = parseConstructionGraphs(text);
      if (errors.length) {
        vscode.window.showWarningMessage(
          `SS14 Construction Graph: this file has YAML parse issues (${errors[0]}). Showing what could be parsed.`
        );
      }
      if (!graphs.length) {
        vscode.window.showInformationMessage(
          'No `type: constructionGraph` prototypes found in this file.'
        );
        return;
      }
      let chosen = graphs[0];
      if (graphs.length > 1) {
        const pick = await vscode.window.showQuickPick(
          graphs.map((g) => ({ label: g.id, description: `${g.nodes.length} nodes`, g })),
          { placeHolder: 'Which construction graph?' }
        );
        if (!pick) return;
        chosen = pick.g;
      }
      pendingGraphSelection.set(editor.document.uri.toString(), chosen.id);
      await vscode.commands.executeCommand(
        'vscode.openWith',
        editor.document.uri,
        VIEW_TYPE,
        vscode.ViewColumn.Beside
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ss14ConstructionGraph.openGraphById', async (uri, graphId) => {
      pendingGraphSelection.set(uri.toString(), graphId);
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Beside);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ss14ConstructionGraph.openGraphByName', async (graphId) => {
      const index = await ensureWorkspaceIndex();
      const matches = index.constructionGraphs.filter((g) => g.id === graphId);
      if (!matches.length) {
        vscode.window.showWarningMessage(
          `SS14 Construction Graph: couldn't find a constructionGraph named "${graphId}" in this workspace. Try "SS14: Rescan Workspace" if you just added it.`
        );
        return;
      }
      let match = matches[0];
      if (matches.length > 1) {
        const pick = await vscode.window.showQuickPick(
          matches.map((m) => ({
            label: m.id,
            description: `${m.nodeCount} nodes`,
            detail: vscode.workspace.asRelativePath(vscode.Uri.parse(m.file), false),
            m,
          })),
          { placeHolder: `Multiple graphs named "${graphId}" found - which one?` }
        );
        if (!pick) return;
        match = pick.m;
      }
      const uri = vscode.Uri.parse(match.file);
      pendingGraphSelection.set(uri.toString(), match.id);
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Active);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ss14ConstructionGraph.setAsDefault', async (uri) => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (!target) {
        vscode.window.showWarningMessage('Open a construction graph file first.');
        return;
      }
      const relative = vscode.workspace.asRelativePath(target, false);
      const config = vscode.workspace.getConfiguration();
      const associations = { ...(config.get('workbench.editorAssociations') || {}) };
      associations[relative] = VIEW_TYPE;
      await config.update(
        'workbench.editorAssociations',
        associations,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage(
        `"${relative}" will now open in the SS14 Construction Graph Editor by default. (Change this anytime via the "workbench.editorAssociations" setting.)`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ss14ConstructionGraph.rescanWorkspace', async () => {
      workspaceIndexCache = null;
      const index = await ensureWorkspaceIndex();
      vscode.window.showInformationMessage(
        `SS14 Construction Graph: found ${index.constructionGraphs.length} construction graphs, ` +
          `${index.constructionPrototypes.length} construction prototypes, and ${index.entityPrototypes.length} entity prototypes.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ss14ConstructionGraph.newGraph', async () => {
      const id = await vscode.window.showInputBox({
        prompt: 'New construction graph id (e.g. Girder, ReinforcedWall)',
        placeHolder: 'MyThingGraph',
        validateInput: (v) => (v && /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : 'Use a simple identifier, e.g. MyThingGraph'),
      });
      if (!id) return;

      const skeleton = `- type: constructionGraph\n  id: ${id}\n  start: start\n  graph:\n    - node: start\n`;

      const editor = vscode.window.activeTextEditor;
      const activeIsEmptyYaml =
        editor &&
        editor.document.languageId === 'yaml' &&
        editor.document.getText().trim() === '';

      let targetUri;
      if (activeIsEmptyYaml) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(editor.document.uri, new vscode.Position(0, 0), skeleton);
        await vscode.workspace.applyEdit(edit);
        targetUri = editor.document.uri;
      } else if (editor && editor.document.languageId === 'yaml') {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Insert into this file', detail: editor.document.fileName, value: 'insert' },
            { label: 'Create a new file', value: 'new' },
          ],
          { placeHolder: 'Where should the new construction graph go?' }
        );
        if (!choice) return;
        if (choice.value === 'insert') {
          const doc = editor.document;
          const text = doc.getText();
          const insertPos = doc.positionAt(text.length);
          const needsLeadingNewline = text.length > 0 && !text.endsWith('\n');
          const edit = new vscode.WorkspaceEdit();
          edit.insert(doc.uri, insertPos, (needsLeadingNewline ? '\n' : '') + skeleton);
          await vscode.workspace.applyEdit(edit);
          targetUri = doc.uri;
        } else {
          const newDoc = await vscode.workspace.openTextDocument({ language: 'yaml', content: skeleton });
          targetUri = newDoc.uri;
        }
      } else {
        const newDoc = await vscode.workspace.openTextDocument({ language: 'yaml', content: skeleton });
        targetUri = newDoc.uri;
      }

      pendingGraphSelection.set(targetUri.toString(), id);
      await vscode.commands.executeCommand('vscode.openWith', targetUri, VIEW_TYPE, vscode.ViewColumn.Active);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ss14ConstructionGraph.showRepoMap', async () => {
      const panel = vscode.window.createWebviewPanel(
        MAP_VIEW_TYPE,
        'SS14 Construction Graph Map',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
        }
      );
      panel.webview.html = getMapWebviewHtml(context, panel.webview);

      const sendIndex = async (forceRescan) => {
        if (forceRescan) workspaceIndexCache = null;
        const index = await ensureWorkspaceIndex();
        panel.webview.postMessage({ type: 'mapData', index });
      };

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') {
          await sendIndex(false);
          return;
        }
        if (msg.type === 'rescan') {
          await sendIndex(true);
          return;
        }
        if (msg.type === 'openGraph') {
          const uri = vscode.Uri.parse(msg.file);
          pendingGraphSelection.set(uri.toString(), msg.id);
          await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Beside);
          return;
        }
        if (msg.type === 'openUsage') {
          const uri = vscode.Uri.parse(msg.file);
          const usageDoc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(usageDoc, {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: false,
          });
          if (msg.range) {
            const start = usageDoc.positionAt(msg.range[0]);
            const end = usageDoc.positionAt(msg.range[1]);
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
          }
          return;
        }
      });
    })
  );
}

function getMapWebviewHtml(context, webview) {
  const mediaUri = (file) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', file)));
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${mediaUri('graph.css')}">
<link rel="stylesheet" href="${mediaUri('repomap.css')}">
<title>Construction Graph Map</title>
</head>
<body>
  <div id="mapApp">
    <div id="mapToolbar">
      <div class="title">🕸️ Construction Graph Map</div>
      <div id="mapStats" class="field-label"></div>
      <div id="mapToolbarRight">
        <input id="mapSearch" type="text" placeholder="Find a graph…" />
        <button id="mapRescanBtn" title="Rescan the workspace">$(refresh) Rescan</button>
      </div>
    </div>
    <div id="mapCanvasWrap">
      <svg id="mapCanvas" xmlns="http://www.w3.org/2000/svg"></svg>
      <div id="mapLoading">Scanning workspace…</div>
      <div id="mapLegend"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${mediaUri('repomap.js')}"></script>
</body>
</html>`;
}

class GraphEditorProvider {
  constructor(context) {
    this.context = context;
  }

  async resolveCustomTextEditor(document, webviewPanel, _token) {
    const context = this.context;
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
    };
    webviewPanel.webview.html = getWebviewHtml(context, webviewPanel.webview);

    const uriKey = document.uri.toString();
    let { graphs } = parseConstructionGraphs(document.getText());
    let graphId =
      pendingGraphSelection.get(uriKey) || (graphs[0] && graphs[0].id) || null;
    pendingGraphSelection.delete(uriKey);

    const pushModel = (opts = {}) => {
      const text = document.getText();
      const parsed = parseConstructionGraphs(text);
      graphs = parsed.graphs;
      const graph = graphs.find((g) => g.id === graphId) || graphs[0] || null;
      if (graph) graphId = graph.id;
      webviewPanel.webview.postMessage({
        type: 'model',
        graph,
        allGraphIds: graphs.map((g) => g.id),
        errors: parsed.errors,
        preserveSelection: !!opts.preserveSelection,
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === uriKey) {
        pushModel({ preserveSelection: true });
      }
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'requestNewGraph') {
          await vscode.commands.executeCommand('ss14ConstructionGraph.newGraph');
          return;
        }
        if (msg.type === 'openRepoMap') {
          await vscode.commands.executeCommand('ss14ConstructionGraph.showRepoMap');
          return;
        }
        if (msg.type === 'selectGraph') {
          graphId = msg.id;
          pushModel();
          return;
        }
        if (msg.type === 'pickEntityPrototype') {
          const items = (await ensureWorkspaceIndex()).entityPrototypes;
          const picks = items.map((e) => ({ label: e.id, description: e.name }));
          const chosen = await vscode.window.showQuickPick(picks, {
            placeHolder: `Pick an entity prototype (${items.length} found) — Escape to cancel`,
            matchOnDescription: true,
          });
          webviewPanel.webview.postMessage({
            type: 'entityPrototypePicked',
            requestId: msg.requestId,
            value: chosen ? chosen.label : null,
          });
          return;
        }
        if (msg.type === 'findEntityOutcomes') {
          // Currently the only dynamic-entity pattern we understand is
          // `!type:BoardNodeEntity` (the shared Machine graph) resolved via
          // entities with a `MachineBoard` component. Anything else just
          // gets an empty (not error) result - the button simply won't do
          // much for it yet.
          const index = await ensureWorkspaceIndex();
          const boards =
            msg.tag === 'BoardNodeEntity' ? index.machineBoards : [];
          webviewPanel.webview.postMessage({
            type: 'entityOutcomesResult',
            nodeId: msg.nodeId,
            outcomes: boards.map((b) => ({
              id: b.id,
              name: b.name,
              prototype: b.prototype,
              stackRequirements: b.stackRequirements,
            })),
          });
          return;
        }
        if (msg.type === 'findUsages') {
          const index = await ensureWorkspaceIndex();
          const usages = index.constructionPrototypes
            .filter((p) => p.graph === msg.graphId)
            .map((p) => ({
              id: p.id,
              startNode: p.startNode,
              targetNode: p.targetNode,
              category: p.category,
              file: vscode.workspace.asRelativePath(vscode.Uri.parse(p.file), false),
              fileUri: p.file,
              range: p.range,
            }));
          webviewPanel.webview.postMessage({
            type: 'usagesResult',
            graphId: msg.graphId,
            usages,
          });
          return;
        }
        if (msg.type === 'openUsage') {
          const uri = vscode.Uri.parse(msg.fileUri);
          const usageDoc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(usageDoc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
          });
          if (msg.range) {
            const start = usageDoc.positionAt(msg.range[0]);
            const end = usageDoc.positionAt(msg.range[1]);
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
          }
          return;
        }
        await handleMessage(msg, document, () => pushModel({ preserveSelection: true }));
      } catch (err) {
        vscode.window.showErrorMessage(`SS14 Construction Graph: ${err.message}`);
        webviewPanel.webview.postMessage({ type: 'error', message: err.message });
      }
    });

    // handleMessage's 'ready' case triggers the first pushModel via the callback,
    // but we also want the very first paint to happen even if 'ready' is slow:
  }
}

async function applyRangeEdit(document, range, newText) {
  return applyEditsBatch(document, [{ range, text: newText }]);
}

/** Applies several replacements as ONE WorkspaceEdit (atomic undo step).
 * All ranges must be computed against the document as it is *before* any
 * of these edits are applied - VS Code resolves offsets correctly even
 * when edits are specified out of order, as long as ranges don't overlap. */
async function applyEditsBatch(document, edits) {
  const wsEdit = new vscode.WorkspaceEdit();
  edits.forEach(({ range, text }) => {
    const startPos = document.positionAt(range[0]);
    const endPos = document.positionAt(range[1]);
    wsEdit.replace(document.uri, new vscode.Range(startPos, endPos), text);
  });
  const ok = await vscode.workspace.applyEdit(wsEdit);
  if (!ok) throw new Error('Failed to apply edit to document.');
}

function backendYamlScalar(v) {
  const s = String(v);
  const needsQuote =
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /[:#]/.test(s) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
    /^-?\d+(\.\d+)?$/.test(s) ||
    s.trim() !== s;
  return needsQuote ? JSON.stringify(s) : s;
}

function findNode(graph, nodeIndex) {
  return graph.nodes[nodeIndex];
}
function findEdge(graph, nodeIndex, edgeIndex) {
  const node = findNode(graph, nodeIndex);
  return node && node.edges[edgeIndex];
}

/** graphId is read fresh from the closure via getGraph() so it reflects the
 * panel's *current* selection even if the user switched graphs mid-flight. */
async function handleMessage(msg, document, refreshModel) {
  const currentGraph = () => {
    const { graphs } = parseConstructionGraphs(document.getText());
    return graphs.find((g) => g.id === msg.graphId) || graphs[0];
  };

  switch (msg.type) {
    case 'ready': {
      refreshModel();
      return;
    }
    case 'reveal': {
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
      const start = document.positionAt(msg.range[0]);
      const end = document.positionAt(msg.range[1]);
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
      return;
    }
    case 'saveEditable': {
      // msg: { range: [s,e], text: generatedOrRawText, indentUnit, target, renameFrom?, newId? }
      const graph = currentGraph();
      if (!graph) throw new Error('Graph no longer found in document.');

      let liveRange = msg.range;
      if (msg.target && msg.target.kind === 'node') {
        const n = findNode(graph, msg.target.nodeIndex);
        if (n) liveRange = n.range;
      } else if (msg.target && msg.target.kind === 'edge') {
        const e = findEdge(graph, msg.target.nodeIndex, msg.target.edgeIndex);
        if (e) liveRange = e.range;
      }

      const reindented = reindentForSave(msg.text, msg.indentUnit);
      const edits = [{ range: liveRange, text: reindented }];

      // If this save renamed a node's id, propagate the new id to every
      // OTHER edge in this graph that pointed at the old id, so nothing
      // is silently left dangling - this is the one thing hand-editing
      // YAML wouldn't do for you automatically.
      if (
        msg.target &&
        msg.target.kind === 'node' &&
        msg.renameFrom &&
        msg.newId &&
        msg.renameFrom !== msg.newId
      ) {
        const newIdScalar = backendYamlScalar(msg.newId);
        graph.nodes.forEach((n, ni) => {
          if (ni === msg.target.nodeIndex) return; // this node's own text was just replaced above
          n.edges.forEach((e) => {
            if (e.to === msg.renameFrom && e.toValueRange) {
              edits.push({ range: e.toValueRange, text: newIdScalar });
            }
          });
        });
      }

      await applyEditsBatch(document, edits);
      refreshModel();
      return;
    }
    case 'deleteItem': {
      const graph = currentGraph();
      if (!graph) throw new Error('Graph no longer found in document.');
      let liveRange = msg.fullLineRange;
      if (msg.target && msg.target.kind === 'node') {
        const n = findNode(graph, msg.target.nodeIndex);
        if (n) liveRange = n.fullLineRange;
      } else if (msg.target && msg.target.kind === 'edge') {
        const e = findEdge(graph, msg.target.nodeIndex, msg.target.edgeIndex);
        if (e) liveRange = e.fullLineRange;
      }
      await applyRangeEdit(document, liveRange, '');
      refreshModel();
      return;
    }
    case 'addNode': {
      const graph = currentGraph();
      if (!graph) throw new Error('Graph no longer found in document.');
      const text = document.getText();

      const newId = msg.id || `newNode${graph.nodes.length + 1}`;
      let insertOffset;
      let dashIndent;
      if (graph.nodes.length > 0) {
        const last = graph.nodes[graph.nodes.length - 1];
        insertOffset = last.fullLineRange[1];
        dashIndent = Math.max(0, last.range[0] - last.fullLineRange[0] - 2);
      } else if (graph.graphSeqRange) {
        insertOffset = graph.graphSeqRange[1];
        dashIndent = 4;
      } else {
        throw new Error('Could not find graph: list to insert into.');
      }
      const pad = ' '.repeat(dashIndent);
      const snippet = `${pad}- node: ${newId}\n`;
      const needsLeadingNewline = text[insertOffset - 1] !== '\n';
      await applyRangeEdit(
        document,
        [insertOffset, insertOffset],
        (needsLeadingNewline ? '\n' : '') + snippet
      );
      refreshModel();
      return;
    }
    case 'duplicateNode': {
      // msg: { nodeIndex, newId }
      const graph = currentGraph();
      if (!graph) throw new Error('Graph no longer found in document.');
      const source = findNode(graph, msg.nodeIndex);
      if (!source) throw new Error('Node to duplicate no longer found.');
      const text = document.getText();

      const dedented = source.editableText.replace(/^node:\s*.*/, `node: ${msg.newId}`);
      const dashIndent = Math.max(0, source.range[0] - source.fullLineRange[0] - 2);
      const pad = ' '.repeat(dashIndent);
      const reindented = reindentForSave(dedented, source.indentUnit);
      const snippet = `${pad}- ${reindented.trimStart()}\n`;

      const insertOffset = source.fullLineRange[1];
      const needsLeadingNewline = text[insertOffset - 1] !== '\n';
      await applyRangeEdit(
        document,
        [insertOffset, insertOffset],
        (needsLeadingNewline ? '\n' : '') + snippet
      );
      refreshModel();
      return;
    }
    default:
      return;
  }
}

function getWebviewHtml(context, webview) {
  const mediaUri = (file) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', file)));
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${mediaUri('graph.css')}">
<title>Construction Graph</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <div id="graphTitleWrap">
        <div id="graphTitle" class="title">Loading…</div>
        <select id="graphSwitcher" class="hidden inline-select" title="Switch construction graph"></select>
      </div>
      <div id="toolbarRight">
        <input id="searchBox" type="text" placeholder="Find node or entity…" />
        <button id="findUsagesBtn" title="Find construction prototypes elsewhere in the workspace that build this graph">🔗 Find usages</button>
        <button id="repoMapBtn" title="See every construction graph in the workspace at once">🕸️ Repo Map</button>
        <button id="autoArrangeBtn" title="Reset to automatic layout">✨ Auto-arrange</button>
        <button id="fitBtn" title="Fit to view">⤢ Fit</button>
        <button id="addNodeBtn" title="Add a new node" class="primary">+ Node</button>
      </div>
    </div>
    <div id="main">
      <div id="canvasWrap">
        <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
        <div id="errorBanner" class="hidden"></div>
        <div id="warningsBanner" class="hidden"></div>
        <div id="emptyState" class="empty-state hidden">
          No <code>type: constructionGraph</code> found in this file.<br/>
          <button id="newGraphFromEmptyBtn" class="primary" style="margin-top:10px;">+ New Construction Graph…</button>
        </div>
      </div>
      <div id="sidePanel" class="hidden">
        <div id="sidePanelHeader">
          <span id="sidePanelTitle"></span>
          <button id="closeSidePanel">✕</button>
        </div>
        <div id="sidePanelBody"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${mediaUri('schema.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('main.js')}"></script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
