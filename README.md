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
an interactive tree, understand the separate `type: construction` prototypes
that make a graph buildable in-game, and see how "dynamic" entities like
machine frames resolve to their finished result — all without needing to
read raw YAML.

Tested throughout against real data from
[space-wizards/space-station-14](https://github.com/space-wizards/space-station-14)
and [ss14Starlight/space-station-14](https://github.com/ss14Starlight/space-station-14)
(1,100+ real files, zero parse failures).

## Features

**A real builder, not just a viewer.** Click a node to open its editor
panel: pick the entity prototype (with a workspace-wide "🔍 Browse…"
picker), add arrival actions from a dropdown, and expand each outgoing edge
to set its target, conditions, and build steps. Every level — the whole
node, a single edge, a single action/condition/step — also has an
**"Edit as YAML"** toggle, so nothing is ever locked behind the form.

**Nothing is ever silently dropped**, even for forks and future SS14
versions. Fields without a nice label still show up in an "Other fields"
editor and round-trip perfectly. Action/condition/step *types* this tool
has never seen still get a fully structured editor instead of being forced
into raw-only mode. Dynamic entity specifiers (`entity: !type:X { ... }`,
used by things like the shared Machine graph) and nested per-step
`completed:` effects are understood and preserved, not corrupted.

**"Show possible outcomes."** Some nodes don't have a fixed entity — e.g.
every machine in the game (fabricator, cargo computer, etc.) shares one
"Machine" graph, and which specific machine you get is decided by which
circuit board you insert, not by the graph itself. Click **🔌 Show possible
outcomes** on a node like that and every matching board found in the
workspace (scanned for a `MachineBoard` component) fans out as connected
leaves right in the diagram, each showing its extra part requirements on
hover.

**An auto-layout built for readability.** Several rounds of crossing
reduction (sweeping both up and down, not just one direction) plus
coordinate-straightening passes turn zig-zags into straight lines.
Multi-step edges bend through waypoints instead of cutting diagonally
through unrelated nodes; loop-back edges route as a wide arc off to the
side. Drag any node — your layout persists — and hit **"✨ Auto-arrange"**
any time to reset it.

**Knows about `type: construction` prototypes** — the separate prototype
(often in a different file) that hooks a graph up to the crafting menu.
These get their own CodeLens, and **"🔗 Find usages"** scans the whole
workspace for every one that builds the graph you're looking at, tags the
start/target nodes on the diagram, and jumps you to the prototype's YAML.

**A workspace-wide map.** The **🕸️ Repo Map** button (or "SS14: Show
Construction Graph Map") shows every graph and construction prototype in
the whole workspace at once as a force-directed web, loosely clustered by
category — not one connected mess, since most graphs genuinely are
independent, but everything is there and clickable.

**Open by default.** Right-click a file → "Always Open This File in the
Construction Graph Editor" to make it open straight into the graph editor
from now on (uses VS Code's own `workbench.editorAssociations` setting).

**Start from nothing.** "SS14: New Construction Graph…" (or the button on
the empty-state screen) scaffolds a brand new graph with just a `start`
node — build the whole tree with "+ Add node"/"+ Add edge", never touch
YAML if you don't want to.

**Safe, atomic editing.** Edits are staged per node; **Save node** writes
exactly that node's YAML back, leaving everything else untouched. Renaming
a node's id automatically updates every other edge that pointed at the old
id, as one atomic undo step. Live external edits are picked up
automatically; an open, unsaved panel is never overwritten out from under
you.

**Other conveniences:** duplicate node, delete node/edge, structural
warnings (dangling edges, duplicate ids, a bad `start:`), hover tooltips
with full step/condition detail, step-kind icons, pan/zoom/search, and a
graph switcher for files with multiple `constructionGraph` prototypes.

## Usage

1. Open a construction graph YAML file. CodeLenses appear above any
   `type: constructionGraph` or `type: construction` block.
2. Click a node to build it out; **Save node** to commit.
3. **🔗 Find usages** to see (and jump to) every construction prototype
   that builds this graph. **🔌 Show possible outcomes** on any node with a
   dynamic entity to see what it could actually become.
4. **🕸️ Repo Map** any time for the full workspace overview.

## Notes / limitations

- The form models a curated set of common action/condition/step types.
  Anything else is still fully editable through the generic field editor or
  raw-YAML fallback, but won't have a fancy dropdown until this tool is
  taught about it.
- "Show possible outcomes" currently understands one dynamic-entity pattern
  (`!type:BoardNodeEntity` + `MachineBoard` component, i.e. the shared
  Machine graph). Other dynamic patterns, if any exist, won't populate yet.
- Switching a single item between "form" and "raw YAML" mode preserves
  whichever one you last edited, but doesn't live-sync edits made in one
  mode into the other's fields until you toggle.
- The workspace scan (entity picker, Find usages, outcomes, repo map) is
  manually cached — use **SS14: Rescan Workspace** after adding new files.
- Requires an open workspace *folder* (not just a single open file) for any
  cross-file feature to find anything — VS Code's search API can't look
  outside a folder that isn't open.

## Licensing

This project is licensed under the terms of the CC0 1.0 Universal license. See LICENSE.md for details.