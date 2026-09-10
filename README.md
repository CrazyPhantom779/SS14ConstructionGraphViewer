# AI Development Disclaimer

This VS Code extension was **developed entirely by Artificial Intelligence**, specifically using **Anthropic's Claude**. 

From the initial architecture and core logic to the UI components, test suites, and documentation, 100% of the codebase was generated via AI prompts.

### What This Means for Users
* **Rapid Iteration:** Features and bug fixes are generated using AI-driven workflows.
* **Review & Testing:** While a human maintainer oversees the repository, configures the build pipelines, and publishes the extension, the underlying logic is entirely machine-generated.
* **Use at Your Own Risk:** AI-generated code can occasionally contain edge-case bugs, security vulnerabilities, or performance inefficiencies that might slip past manual automated testing. Please test thoroughly in a staging or non-critical environment.

If you encounter any unexpected behavior, please open an Issue so we can prompt Claude for a fix!

# SS14 Construction Graph Editor

Build, view, and edit Space Station 14 `constructionGraph` YAML prototypes as
an interactive tree — instead of hundreds of lines of nested
`- to: / steps: / !type:` YAML you have to trace by eye. Also understands
the separate `type: construction` prototypes that actually make a graph
buildable in-game, and can map an entire workspace's worth of graphs at once.

Built against the format described in the [SS14 dev docs](https://docs.spacestation14.com/en/space-station-14/core-tech/construction.html)
and tested throughout against real graphs from
[space-wizards/space-station-14](https://github.com/space-wizards/space-station-14).

## Features

**A real builder, not just a viewer.** Click a node to open its editor
panel: pick the entity prototype (with a workspace-wide "🔍 Browse…" picker),
add arrival actions from a dropdown of known types, and expand each outgoing
edge to set its target, conditions, and build steps — all through fields and
dropdowns. Every level (the whole node, a single edge, or a single
action/condition/step) also has an **"Edit as YAML"** toggle, so nothing is
ever locked behind the form.

**Nothing is ever silently dropped, even for forks and future SS14
versions.** Fields this tool doesn't have a nice label for still show up in
an "Other fields" editor and round-trip perfectly on save. Action, condition,
and step *types* this tool has never heard of (a fork's custom type, or
something added to SS14 after this was built) still get a fully structured,
add-a-field editor instead of being forced into raw-only mode.

**An auto-layout that's actually built for readability.** The tree layout
runs several rounds of crossing-reduction (sweeping both up and down through
the graph, not just one direction) followed by coordinate-straightening
passes so chains of edges read as straight lines instead of zig-zags. Edges
that skip several steps bend through waypoints instead of cutting diagonally
across unrelated nodes; edges that loop back up the graph are routed as a
wide arc off to the side instead of through the middle. Drag any node to
override its position — your layout persists across edits — and hit
**"✨ Auto-arrange"** any time to snap back to the computed layout.

**Knows about `type: construction` prototypes**, the separate prototype
(often in a different file) that actually hooks a graph up to the crafting
menu — category, placement mode, and crucially which node is the entry point
and which is the finished result. Those show up as CodeLenses of their own,
and the graph editor's **"🔗 Find usages"** button scans the whole workspace
for every construction prototype that builds the graph you're looking at,
tags the corresponding start/target nodes right on the diagram, and jumps
you straight to the prototype's YAML.

**A workspace-wide map.** Run **"SS14: Show Construction Graph Map"** to see
every constructionGraph and construction prototype in the whole workspace at
once, laid out as a force-directed web (graphs as circles sized by node
count, construction prototypes as small dots linked to the graph they build,
loosely clustered by category) — not one connected mess, since most graphs
genuinely are independent, but you can see everything and click straight
into any of them.

**Open by default.** Right-click a file and choose **"SS14: Always Open This
File in the Construction Graph Editor"** to make that file open straight
into the graph editor from now on (uses VS Code's own
`workbench.editorAssociations` setting, so it's easy to see/undo).

**Start from literally nothing.** Run **"SS14: New Construction Graph…"** (or
click the button on the empty-state screen) to scaffold a brand new graph
with just a `start` node, then build the whole tree by clicking "+ Add node"
and "+ Add edge" — never touch YAML if you don't want to.

**Safe, atomic editing.** Edits are staged in memory per node; **Save node**
writes exactly that node's YAML back into the file in one edit, leaving
everything else (comments, formatting, other nodes) untouched. Renaming a
node's id automatically updates every other edge in the graph that pointed
at the old id, as a single atomic undo step — something hand-editing
wouldn't do for you. Live file edits made outside the editor are picked up
automatically; an open, unsaved panel is never overwritten out from under
you.

**Other conveniences:** Duplicate node, delete node/edge, structural
warnings (dangling edges, duplicate ids, a `start:` that doesn't match any
node), pan/zoom/search, and a graph switcher when a file has multiple
`constructionGraph` prototypes in it.

## Usage

1. Open a construction graph YAML file. A **🌳 Open "..." in graph editor**
   CodeLens appears above any `type: constructionGraph` block, and a
   **🔗 "..." builds graph "..."** CodeLens appears above any
   `type: construction` block.
2. Click a node to build it out. Fill in fields, add actions/edges/steps
   from the dropdowns, or hit "Edit as YAML" wherever you'd rather just type
   it. Click **Save node** to commit.
3. Click **🔗 Find usages** to see (and jump to) every construction
   prototype elsewhere in the workspace that builds this graph.
4. Run **SS14: Show Construction Graph Map** any time for the full
   workspace overview.

## Notes / limitations

- The form models a curated set of the common action/condition/step types.
  Anything else — current or future — is still fully editable through the
  generic field editor or the raw-YAML fallback, so you're never blocked,
  but it won't have a fancy dropdown until this tool is taught about it.
- Switching a single item between "form" and "raw YAML" mode preserves
  whichever one you last edited, but doesn't live-sync edits made in one
  mode into the other's fields until you toggle — edit one representation
  at a time per item for predictable results.
- The workspace scan (for the entity picker, "Find usages", and the repo
  map) is manually triggered/cached, not automatic on every keystroke — use
  **SS14: Rescan Workspace** after adding new files it should know about.
- The repo map's layout is a lightweight force simulation, not a guarantee
  of zero overlap on very large workspaces — pan/zoom and the search box are
  there to help navigate dense areas.

## Licensing

This project is licensed under the terms of the CC BY 4.0 license. See LICENSE.md for details.