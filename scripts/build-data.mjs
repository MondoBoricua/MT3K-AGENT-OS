#!/usr/bin/env node
/**
 * build-data.mjs — ingests every tracked repo's graphify-out/ into the panel.
 *
 * Reads data/projects.json, then for each repo:
 *   graphify-out/graph.json          → nodes + links (NetworkX node-link format)
 *   graphify-out/cost.json           → token spend → estimated savings/session
 *   graphify-out/.graphify_labels.json → community id → human label
 *   graphify-out/GRAPH_REPORT.md     → wiki/report markdown
 *
 * Writes panel/public/data/<id>.json (per project) and manifest.json (index).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "panel", "public", "data");
const REREAD_RATE_PER_MTOK = 3.0; // $/Mtok — Sonnet-class input, the cost of re-reading the repo

const expand = (p) => p.replace(/^~(?=$|\/)/, homedir());
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

function langFromExt(ext) {
  const m = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".astro": "Astro", ".vue": "Vue", ".svelte": "Svelte", ".php": "PHP", ".py": "Python",
    ".swift": "Swift", ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".java": "Java",
    ".cs": "C#", ".shader": "Shader", ".hlsl": "Shader", ".compute": "Shader",
    ".css": "CSS", ".scss": "SCSS", ".md": "Docs", ".json": "Config",
  };
  return m[ext] || null;
}

function primaryLang(nodes) {
  const counts = {};
  for (const n of nodes) {
    const lang = langFromExt(extname(n.source_file || n.label || "").toLowerCase());
    if (lang && lang !== "Config" && lang !== "Docs") counts[lang] = (counts[lang] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : "Mixed";
}

function processProject(p) {
  const base = join(expand(p.path), "graphify-out");
  const graphPath = join(base, "graph.json");
  if (!existsSync(graphPath)) {
    console.warn(`  ⚠ ${p.id}: no graph.json — skipping (run \`graphify .\` in ${p.path})`);
    return null;
  }
  const g = readJSON(graphPath);
  const rawNodes = g.nodes || [];
  const rawLinks = g.links || g.edges || [];
  const labels = safe(() => readJSON(join(base, ".graphify_labels.json")), {});
  const cost = safe(() => readJSON(join(base, "cost.json")), null);
  const report = safe(() => readFileSync(join(base, "GRAPH_REPORT.md"), "utf8"), "");

  // wiki (graphify export wiki): index.md + one article per community
  const wikiDir = join(base, "wiki");
  const WIKI_CAP = 200; // bound a wiki bloated by a node_modules-polluted graph (one article per micro-community)
  let wiki = null;
  if (existsSync(wikiDir)) {
    const index = safe(() => readFileSync(join(wikiDir, "index.md"), "utf8"), "");
    let articles = readdirSync(wikiDir)
      .filter((f) => f.endsWith(".md") && f !== "index.md" && !f.startsWith("-"))
      .map((f) => ({ title: f.replace(/\.md$/, "").replace(/_/g, " "), body: safe(() => readFileSync(join(wikiDir, f), "utf8"), "") }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const wikiTotal = articles.length;
    if (articles.length > WIKI_CAP) articles = [...articles].sort((a, b) => b.body.length - a.body.length).slice(0, WIKI_CAP).sort((a, b) => a.title.localeCompare(b.title));
    if (index || articles.length) wiki = { index, articles, total: wikiTotal };
  }

  // degree per node (connectivity)
  const degree = {};
  for (const n of rawNodes) degree[n.id] = 0;
  const norm = (e) => (typeof e === "object" ? e.id ?? e : e);
  for (const l of rawLinks) {
    const s = norm(l.source), t = norm(l.target);
    if (s in degree) degree[s]++;
    if (t in degree) degree[t]++;
  }

  // map confidence: AST-extracted vs model-inferred
  let extracted = 0, inferred = 0;
  for (const n of rawNodes) (n._origin === "ast" ? extracted++ : inferred++);
  const total = extracted + inferred || 1;

  // communities → labelled clusters with sizes
  const clusterSize = {};
  for (const n of rawNodes) clusterSize[n.community] = (clusterSize[n.community] || 0) + 1;
  const clusters = Object.entries(clusterSize)
    .map(([id, size]) => ({ id: Number(id), label: labels[id] || `Community ${id}`, size }))
    .sort((a, b) => b.size - a.size);

  // god nodes: most connected files
  const godNodes = [...rawNodes]
    .map((n) => ({ id: n.id, label: n.label, degree: degree[n.id] || 0, community: n.community }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 8);

  // savings: cost of re-reading the repo each session vs querying the map
  const tokensReread = cost?.runs?.length
    ? Math.max(...cost.runs.map((r) => r.input_tokens || 0))
    : rawNodes.length * 1500;
  const costPerSession = (tokensReread / 1e6) * REREAD_RATE_PER_MTOK;

  // lean graph for the canvas
  let nodes = rawNodes.map((n) => ({
    id: n.id, label: n.label, community: n.community,
    origin: n._origin === "ast" ? "extracted" : "inferred", degree: degree[n.id] || 0,
  }));
  let links = rawLinks.map((l) => ({ source: norm(l.source), target: norm(l.target) }));

  // cap huge graphs so the browser doesn't download/parse a multi-MB file (e.g. a repo graphed
  // with node_modules). Keep the most-connected nodes; the card still reports the true file count.
  const GRAPH_CAP = 3000;
  const trueNodeCount = nodes.length;
  if (nodes.length > GRAPH_CAP) {
    const keep = new Set([...nodes].sort((a, b) => b.degree - a.degree).slice(0, GRAPH_CAP).map((n) => n.id));
    nodes = nodes.filter((n) => keep.has(n.id));
    links = links.filter((l) => keep.has(l.source) && keep.has(l.target));
  }

  const meta = {
    id: p.id, name: p.name, lang: primaryLang(rawNodes),
    files: trueNodeCount, graphNodes: nodes.length, links: rawLinks.length, clusters: clusters.length,
    confidence: { extracted: +(extracted / total * 100).toFixed(0), inferred: +(inferred / total * 100).toFixed(0) },
    savings: { costPerSession: +costPerSession.toFixed(2), tokens: tokensReread },
  };

  // the legend/sidebar only need the biggest clusters; meta.clusters keeps the true total
  const clustersOut = clusters.slice(0, 400);
  writeFileSync(join(OUT, `${p.id}.json`), JSON.stringify({ meta, nodes, links, godNodes, clusters: clustersOut, report, wiki }));
  console.log(`  ✓ ${p.id}: ${meta.files} files · ${meta.links} links · ${meta.clusters} clusters · ${meta.confidence.extracted}% extracted · ~$${meta.savings.costPerSession}/session`);
  return meta;
}

// --- run ---
mkdirSync(OUT, { recursive: true });
const { projects } = readJSON(join(ROOT, "data", "projects.json"));
console.log(`Ingesting ${projects.length} projects…`);
const metas = projects.map(processProject).filter(Boolean);
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ projects: metas, builtAt: process.env.BUILD_TIME || null }));
console.log(`\nWrote manifest with ${metas.length} projects → panel/public/data/manifest.json`);
