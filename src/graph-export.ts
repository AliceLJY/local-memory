/**
 * Memory Knowledge Graph Export — generates an interactive HTML visualization
 * of memory entries as a force-directed graph.
 *
 * Uses D3.js v7 for layout and rendering. The output is a self-contained HTML
 * file that can be opened in any browser.
 */

import type { MemoryEntry, MemoryStore } from "./store.js";
import { parseEvolution, isActiveMemory } from "./memory-evolution.js";
import { cosineSimilarity } from "./multi-vector.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  label: string;       // truncated text
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  accessCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "supersede" | "consolidation" | "cluster" | "scope" | "semantic";
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphExportOptions {
  scope?: string;
  maxNodes?: number;      // default 200
  outputPath?: string;    // default data/exports/
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

interface ParsedMetadata {
  evolution?: Record<string, unknown>;
  clustered_with?: string;
  cluster_members?: string[];
  [key: string]: unknown;
}

function parseMetadataSafe(metadata: string | undefined): ParsedMetadata {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata) as ParsedMetadata;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Node Selection — diverse, connected, balanced
// ---------------------------------------------------------------------------

/**
 * Select nodes for the graph with diversity in mind:
 * 1. First, include entries that have evolution links (they form interesting connected subgraphs)
 * 2. Then, fill remaining slots with round-robin across categories (sorted by importance within each)
 *
 * This avoids the "all patterns, no edges" problem that pure importance sorting causes.
 */
function selectDiverseNodes(entries: MemoryEntry[], maxNodes: number): MemoryEntry[] {
  if (entries.length <= maxNodes) return entries;

  const selected = new Map<string, MemoryEntry>();

  // Phase 1: Prioritize entries with evolution links (they create edges)
  for (const entry of entries) {
    if (selected.size >= maxNodes) break;
    const evo = parseEvolution(entry.metadata, entry.timestamp);
    const meta = parseMetadataSafe(entry.metadata);
    const hasLinks = evo.supersededBy || evo.supersedes || evo.consolidatedInto ||
      typeof meta.clustered_with === "string" || Array.isArray(meta.cluster_members);
    if (hasLinks && !selected.has(entry.id)) {
      selected.set(entry.id, entry);
    }
  }

  // Phase 2: Round-robin across categories, picking top-importance entries
  const byCategory = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (selected.has(entry.id)) continue;
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  // Sort each category by importance descending
  for (const [, list] of byCategory) {
    list.sort((a, b) => b.importance - a.importance);
  }

  // Round-robin: take one from each category in turn
  const categories = [...byCategory.keys()];
  const indices = new Map<string, number>(categories.map(c => [c, 0]));
  let added = true;
  while (selected.size < maxNodes && added) {
    added = false;
    for (const cat of categories) {
      if (selected.size >= maxNodes) break;
      const list = byCategory.get(cat)!;
      const idx = indices.get(cat)!;
      if (idx < list.length) {
        selected.set(list[idx].id, list[idx]);
        indices.set(cat, idx + 1);
        added = true;
      }
    }
  }

  return [...selected.values()];
}

// ---------------------------------------------------------------------------
// Graph Builder
// ---------------------------------------------------------------------------

export async function buildMemoryGraph(
  store: Pick<MemoryStore, "list"> & Partial<Pick<MemoryStore, "getVectors">>,
  options?: GraphExportOptions,
): Promise<MemoryGraph> {
  const maxNodes = options?.maxNodes ?? 200;
  const scopeFilter = options?.scope ? [options.scope] : undefined;

  // 1. List all entries
  const entries = await store.list(scopeFilter, undefined, 10000, 0);

  // 2. Filter to active entries only
  const active = entries.filter(e => isActiveMemory(e.metadata));

  // 3. Select nodes with diversity: prioritize connected nodes, then balance categories
  const selected = selectDiverseNodes(active, maxNodes);
  const nodeIds = new Set(selected.map(e => e.id));

  // 4. Build nodes
  const nodes: GraphNode[] = selected.map(entry => {
    const evo = parseEvolution(entry.metadata, entry.timestamp);
    return {
      id: entry.id,
      label: truncateText(entry.text, 80),
      category: entry.category,
      scope: entry.scope,
      importance: entry.importance,
      timestamp: entry.timestamp,
      accessCount: evo.accessCount,
    };
  });

  // 5. Build edges
  const edges: GraphEdge[] = [];

  for (const entry of selected) {
    const evo = parseEvolution(entry.metadata, entry.timestamp);
    const meta = parseMetadataSafe(entry.metadata);

    // supersededBy
    if (evo.supersededBy && nodeIds.has(evo.supersededBy)) {
      edges.push({ source: entry.id, target: evo.supersededBy, type: "supersede" });
    }

    // supersedes
    if (evo.supersedes && nodeIds.has(evo.supersedes)) {
      edges.push({ source: evo.supersedes, target: entry.id, type: "supersede" });
    }

    // consolidatedInto
    if (evo.consolidatedInto && nodeIds.has(evo.consolidatedInto)) {
      edges.push({ source: entry.id, target: evo.consolidatedInto, type: "consolidation" });
    }

    // clustered_with (single ID stored at top level of metadata)
    if (typeof meta.clustered_with === "string" && nodeIds.has(meta.clustered_with)) {
      edges.push({ source: entry.id, target: meta.clustered_with, type: "cluster" });
    }

    // cluster_members (array at top level of metadata)
    if (Array.isArray(meta.cluster_members)) {
      for (const memberId of meta.cluster_members) {
        if (typeof memberId === "string" && nodeIds.has(memberId)) {
          edges.push({ source: entry.id, target: memberId, type: "cluster" });
        }
      }
    }
  }

  // 6. Scope edges — group entries by scope, connect within groups (≤ 20 per scope)
  const byScope = new Map<string, string[]>();
  for (const node of nodes) {
    const list = byScope.get(node.scope) ?? [];
    list.push(node.id);
    byScope.set(node.scope, list);
  }

  for (const [, ids] of byScope) {
    if (ids.length > 15 || ids.length < 2) continue;
    // Connect each node to the next in the group (chain, not full mesh)
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ source: ids[i], target: ids[i + 1], type: "scope" });
    }
  }

  // 7. Cross-scope semantic bridges — connect entries from DIFFERENT scopes
  //    that are semantically similar (cosine ≥ 0.65). This reveals hidden
  //    cross-domain knowledge connections that the user's interdisciplinary
  //    thinking creates but explicit metadata doesn't capture.
  //    Vectors must be fetched separately since list() omits them for perf.
  const SEMANTIC_BRIDGE_THRESHOLD = 0.65;
  const MAX_SEMANTIC_EDGES = 30;  // cap to avoid visual clutter

  if (store.getVectors) {
    const vectorMap = await store.getVectors(selected.map(e => e.id));
    const semanticCandidates: { source: string; target: string; sim: number }[] = [];

    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        const a = selected[i];
        const b = selected[j];
        // Only cross-scope — same-scope connections are handled by scope chains
        if (a.scope === b.scope) continue;
        const vecA = vectorMap.get(a.id);
        const vecB = vectorMap.get(b.id);
        if (!vecA || !vecB) continue;
        const sim = cosineSimilarity(vecA, vecB);
        if (sim >= SEMANTIC_BRIDGE_THRESHOLD) {
          semanticCandidates.push({ source: a.id, target: b.id, sim });
        }
      }
    }

    // Keep top-N by similarity to avoid clutter
    semanticCandidates.sort((a, b) => b.sim - a.sim);
    for (const { source, target } of semanticCandidates.slice(0, MAX_SEMANTIC_EDGES)) {
      edges.push({ source, target, type: "semantic" });
    }
  }

  // 8. Deduplicate edges
  const edgeKey = (e: GraphEdge) => `${e.source}|${e.target}|${e.type}`;
  const seen = new Set<string>();
  const uniqueEdges: GraphEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEdges.push(edge);
    }
  }

  return { nodes, edges: uniqueEdges };
}

// ---------------------------------------------------------------------------
// HTML Renderer
// ---------------------------------------------------------------------------

export function renderGraphHTML(graph: MemoryGraph): string {
  const graphJSON = JSON.stringify(graph);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RecallNest Knowledge Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    overflow: hidden;
  }
  #header {
    position: fixed;
    top: 16px;
    left: 16px;
    z-index: 10;
    pointer-events: none;
  }
  #header h1 {
    font-size: 20px;
    font-weight: 600;
    color: #e6edf3;
  }
  #header .stats {
    font-size: 13px;
    color: #8b949e;
    margin-top: 4px;
  }
  #legend {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 10;
    background: rgba(22, 27, 34, 0.9);
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 16px;
    font-size: 12px;
  }
  #legend h3 {
    font-size: 13px;
    margin-bottom: 8px;
    color: #e6edf3;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .legend-line {
    width: 20px;
    height: 0;
    border-top: 2px solid #fbbf24;
    flex-shrink: 0;
  }
  .legend-line.dashed { border-top-style: dashed; border-top-color: #60a5fa; }
  .legend-line.dotted { border-top-style: dotted; border-top-color: #9ca3af; }
  #tooltip {
    position: fixed;
    display: none;
    background: rgba(22, 27, 34, 0.95);
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 12px;
    max-width: 360px;
    pointer-events: none;
    z-index: 20;
    line-height: 1.5;
  }
  #tooltip .tt-label { font-weight: 600; color: #e6edf3; margin-bottom: 4px; word-break: break-word; }
  #tooltip .tt-meta { color: #8b949e; }
  #tooltip .tt-meta-line { margin-top: 2px; }
  svg { width: 100vw; height: 100vh; }
</style>
</head>
<body>
<div id="header">
  <h1>RecallNest Knowledge Graph</h1>
  <div class="stats" id="stats"></div>
</div>

<div id="legend">
  <h3>Categories</h3>
  <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div><span>profile</span></div>
  <div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div><span>preferences</span></div>
  <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div><span>entities</span></div>
  <div class="legend-item"><div class="legend-dot" style="background:#6b7280"></div><span>events</span></div>
  <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div><span>cases</span></div>
  <div class="legend-item"><div class="legend-dot" style="background:#8b5cf6"></div><span>patterns</span></div>
  <h3 style="margin-top:10px">Edge Types</h3>
  <div class="legend-item"><div class="legend-line"></div><span>supersede</span></div>
  <div class="legend-item"><div class="legend-line dashed"></div><span>cluster</span></div>
  <div class="legend-item"><div class="legend-line dotted"></div><span>scope</span></div>
  <div class="legend-item"><div class="legend-line" style="border-top-color:#f472b6;border-top-style:dashed"></div><span>semantic bridge</span></div>
</div>

<div id="tooltip">
  <div class="tt-label" id="tt-label"></div>
  <div class="tt-meta" id="tt-meta"></div>
</div>

<svg id="graph"></svg>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const GRAPH_DATA = ${graphJSON};

const CATEGORY_COLORS = {
  profile: "#f59e0b",
  preferences: "#3b82f6",
  entities: "#10b981",
  events: "#6b7280",
  cases: "#ef4444",
  patterns: "#8b5cf6",
};
const DEFAULT_COLOR = "#9ca3af";

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || DEFAULT_COLOR;
}

function nodeRadius(importance) {
  return 4 + importance * 8; // 4-12
}

function edgeStroke(type) {
  if (type === "supersede") return "";
  if (type === "cluster") return "8,4";
  if (type === "consolidation") return "";
  if (type === "semantic") return "6,3,2,3";  // dash-dot pattern
  return "3,3";
}

function edgeColor(type) {
  if (type === "supersede" || type === "consolidation") return "#fbbf24";
  if (type === "cluster") return "#60a5fa";
  if (type === "semantic") return "#f472b6";
  return "#9ca3af";
}

function edgeOpacity(type) {
  if (type === "scope") return 0.4;
  if (type === "cluster") return 0.65;
  if (type === "semantic") return 0.6;
  return 0.7;
}

// Stats
document.getElementById("stats").textContent =
  GRAPH_DATA.nodes.length + " nodes, " + GRAPH_DATA.edges.length + " edges";

var svg = d3.select("#graph");
var width = window.innerWidth;
var height = window.innerHeight;

var g = svg.append("g");

// Zoom
var zoom = d3.zoom()
  .scaleExtent([0.1, 8])
  .on("zoom", function(event) { g.attr("transform", event.transform); });
svg.call(zoom);

// Simulation
var simulation = d3.forceSimulation(GRAPH_DATA.nodes)
  .force("link", d3.forceLink(GRAPH_DATA.edges)
    .id(function(d) { return d.id; })
    .distance(80))
  .force("charge", d3.forceManyBody().strength(-120))
  .force("center", d3.forceCenter(width / 2, height / 2))
  .force("collide", d3.forceCollide().radius(function(d) { return nodeRadius(d.importance) + 2; }));

// Edges
var link = g.append("g")
  .selectAll("line")
  .data(GRAPH_DATA.edges)
  .join("line")
  .attr("stroke", function(d) { return edgeColor(d.type); })
  .attr("stroke-width", 2)
  .attr("stroke-dasharray", function(d) { return edgeStroke(d.type); })
  .attr("stroke-opacity", function(d) { return edgeOpacity(d.type); });

// Nodes
var node = g.append("g")
  .selectAll("circle")
  .data(GRAPH_DATA.nodes)
  .join("circle")
  .attr("r", function(d) { return nodeRadius(d.importance); })
  .attr("fill", function(d) { return categoryColor(d.category); })
  .attr("stroke", "#0d1117")
  .attr("stroke-width", 1.5)
  .call(d3.drag()
    .on("start", dragstarted)
    .on("drag", dragged)
    .on("end", dragended));

// Tooltip
var tooltip = document.getElementById("tooltip");
var ttLabel = document.getElementById("tt-label");
var ttMeta = document.getElementById("tt-meta");

function formatAge(ts) {
  var days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return days + " days ago";
  var months = Math.floor(days / 30);
  return months + (months === 1 ? " month ago" : " months ago");
}

function updateTooltip(d) {
  ttLabel.textContent = d.label;
  // Clear previous meta lines
  while (ttMeta.firstChild) ttMeta.removeChild(ttMeta.firstChild);
  var lines = [
    "Category: " + d.category,
    "Scope: " + d.scope,
    "Importance: " + d.importance.toFixed(2),
    "Age: " + formatAge(d.timestamp),
    "Accesses: " + d.accessCount,
  ];
  for (var i = 0; i < lines.length; i++) {
    var div = document.createElement("div");
    div.className = "tt-meta-line";
    div.textContent = lines[i];
    ttMeta.appendChild(div);
  }
}

node
  .on("mouseover", function(event, d) {
    updateTooltip(d);
    tooltip.style.display = "block";
  })
  .on("mousemove", function(event) {
    tooltip.style.left = (event.clientX + 12) + "px";
    tooltip.style.top = (event.clientY + 12) + "px";
  })
  .on("mouseout", function() {
    tooltip.style.display = "none";
  });

// Tick
simulation.on("tick", function() {
  link
    .attr("x1", function(d) { return d.source.x; })
    .attr("y1", function(d) { return d.source.y; })
    .attr("x2", function(d) { return d.target.x; })
    .attr("y2", function(d) { return d.target.y; });
  node
    .attr("cx", function(d) { return d.x; })
    .attr("cy", function(d) { return d.y; });
});

function dragstarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}
function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}
function dragended(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportMemoryGraph(
  store: Pick<MemoryStore, "list">,
  options?: GraphExportOptions,
): Promise<{ path: string; graph: MemoryGraph }> {
  const graph = await buildMemoryGraph(store, options);
  const html = renderGraphHTML(graph);

  const outputDir = options?.outputPath
    ? resolve(options.outputPath, "..")
    : resolve(import.meta.dir, "../data/exports");

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filePath = options?.outputPath
    ?? join(outputDir, `memory-graph-${Date.now()}.html`);

  writeFileSync(filePath, html, "utf-8");

  return { path: filePath, graph };
}

// ---------------------------------------------------------------------------
// Format Result
// ---------------------------------------------------------------------------

export function formatGraphExportResult(path: string, graph: MemoryGraph): string {
  // Count categories
  const catCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    catCounts.set(node.category, (catCounts.get(node.category) ?? 0) + 1);
  }
  const catSummary = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat}(${count})`)
    .join(", ");

  // Count edge types
  const edgeTypeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeTypeCounts.set(edge.type, (edgeTypeCounts.get(edge.type) ?? 0) + 1);
  }
  const semanticCount = edgeTypeCounts.get("semantic") ?? 0;
  const edgeSummary = semanticCount > 0
    ? ` (${semanticCount} semantic bridges)`
    : "";

  return [
    `Knowledge Graph exported: ${path}`,
    `Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}${edgeSummary}`,
    `Categories: ${catSummary || "none"}`,
  ].join("\n");
}
