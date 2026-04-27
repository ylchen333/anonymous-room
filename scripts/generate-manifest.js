#!/usr/bin/env node
/**
 * generate-manifest.js
 *
 * Scans the assets/ directory and auto-generates assets/manifest.json.
 *
 * Detection rules:
 *   [scene]_N.ext        → groups into an "on_the_fly_nvs" scene (N is integer >= 0)
 *   [scene]_seg_N.ext    → added to the parent scene's "segments" array
 *   anything else        → "single" scene entry
 *
 * Supported formats: .ply  .spz  .splat  .ksplat  .sog
 *
 * Usage:
 *   node scripts/generate-manifest.js
 *   node scripts/generate-manifest.js --assets-dir ./assets --out ./assets/manifest.json
 *   node scripts/generate-manifest.js --dry-run
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPPORTED_EXTS = new Set(['.ply', '.spz', '.splat', '.ksplat', '.sog']);

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') flags.dryRun = true;
  if (args[i] === '--assets-dir') flags.assetsDir = args[++i];
  if (args[i] === '--out') flags.out = args[++i];
}

const ASSETS_DIR = path.resolve(flags.assetsDir ?? path.join(__dirname, '..', 'assets'));
const OUT_PATH   = path.resolve(flags.out ?? path.join(ASSETS_DIR, 'manifest.json'));

// ── Scan ──────────────────────────────────────────────────────────────────────

/**
 * Recursively list all splat files under a directory, returning paths
 * relative to ASSETS_DIR.
 */
function scanDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanDir(full));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) {
        results.push(path.relative(ASSETS_DIR, full));
      }
    }
  }
  return results;
}

/**
 * Given a relative file path, return the parsed info:
 *   { sceneId, anchorIndex, segIndex, format, relPath }
 *
 * Examples:
 *   "onthefly_nvs_splats/along_schenley_anchor_0.ply" → sceneId="along_schenley", anchorIndex=0
 *   "other_splats/along_schenley_0.ply"               → sceneId="along_schenley", anchorIndex=0
 *   "segments/along_schenley_seg_3.ply"               → sceneId="along_schenley", segIndex=3
 *   "other_splats/butterfly.spz"                       → sceneId="butterfly", anchorIndex=null (single)
 */
function parseFilePath(relPath) {
  const ext    = path.extname(relPath).toLowerCase();
  const base   = path.basename(relPath, ext);

  // Segment: <scene>_seg_<N>
  const segMatch = base.match(/^(.+)_seg_(\d+)$/);
  if (segMatch) {
    return {
      sceneId: segMatch[1],
      anchorIndex: null,
      segIndex: parseInt(segMatch[2], 10),
      format: ext.slice(1),
      relPath,
    };
  }

  // On-the-fly NVS anchor with explicit tag: <scene>_anchor_<N>
  const anchorTagMatch = base.match(/^(.+)_anchor_(\d+)$/);
  if (anchorTagMatch) {
    return {
      sceneId: anchorTagMatch[1],
      anchorIndex: parseInt(anchorTagMatch[2], 10),
      segIndex: null,
      format: ext.slice(1),
      relPath,
    };
  }

  // Generic anchor group: <scene>_<N>  (N is a non-negative integer)
  const anchorMatch = base.match(/^(.+)_(\d+)$/);
  if (anchorMatch) {
    return {
      sceneId: anchorMatch[1],
      anchorIndex: parseInt(anchorMatch[2], 10),
      segIndex: null,
      format: ext.slice(1),
      relPath,
    };
  }

  // Single file
  return {
    sceneId: base,
    anchorIndex: null,
    segIndex: null,
    format: ext.slice(1),
    relPath,
  };
}

/**
 * Scan for <scene>_metadata.json files in a directory and return a map of
 * sceneId → anchorPositions ([x,y,z][]).
 */
function readMetadataPositions(dir) {
  const result = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(.+)_metadata\.json$/);
    if (!match) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
      if (Array.isArray(data.anchors)) {
        result.set(match[1], data.anchors.map(a => a.position));
      }
    } catch { /* skip malformed files */ }
  }
  return result;
}

/** Convert a snake_case / kebab-case id to a human-friendly display name. */
function toDisplayName(id) {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Build manifest ────────────────────────────────────────────────────────────

const files = scanDir(ASSETS_DIR).filter(f => !f.startsWith('segments' + path.sep) || f.includes('_seg_'));

// Read anchor positions from any *_metadata.json files found in subdirectories
const metadataPositions = new Map();
for (const entry of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const subPositions = readMetadataPositions(path.join(ASSETS_DIR, entry.name));
  for (const [sceneId, positions] of subPositions) {
    metadataPositions.set(sceneId, positions);
  }
}

// Keyed by sceneId
const sceneMap = new Map();

function getOrCreate(sceneId) {
  if (!sceneMap.has(sceneId)) {
    sceneMap.set(sceneId, {
      id: sceneId,
      displayName: toDisplayName(sceneId),
      type: 'single',         // upgraded to on_the_fly_nvs if > 1 anchor found
      format: null,
      anchors: [],
      anchorPositions: [],    // populated from *_metadata.json if present
      segments: [],
    });
  }
  return sceneMap.get(sceneId);
}

for (const relPath of files) {
  const info = parseFilePath(relPath);
  const scene = getOrCreate(info.sceneId);

  if (info.segIndex !== null) {
    // Segmented splat — will be added to parent scene
    scene.segments.push({
      id: `${info.sceneId}_seg_${info.segIndex}`,
      label: '',          // fill in after HDBSCAN labelling
      clusterId: info.segIndex,
      file: relPath,
      gaussianCount: null,
      colorHint: null,
    });
    scene.segments.sort((a, b) => a.clusterId - b.clusterId);
  } else if (info.anchorIndex !== null) {
    // Named anchor from on-the-fly NVS
    scene.anchors[info.anchorIndex] = relPath;   // insert at correct index
    scene.type = 'on_the_fly_nvs';
    scene.format = info.format;
  } else {
    // Single file
    scene.anchors.push(relPath);
    scene.format = info.format;
  }
}

// Compact sparse anchor arrays (fill holes that shouldn't exist, but be safe)
for (const scene of sceneMap.values()) {
  scene.anchors = scene.anchors.filter(Boolean);
  if (scene.anchors.length > 1 && scene.type === 'single') {
    scene.type = 'on_the_fly_nvs';
  }
  if (scene.type === 'single') delete scene.format; // format is per-file for single
  else scene.format = path.extname(scene.anchors[0] ?? '').slice(1) || 'ply';

  // Populate anchor positions from metadata if available
  if (metadataPositions.has(scene.id)) {
    scene.anchorPositions = metadataPositions.get(scene.id);
  }
  // Remove anchorPositions if empty (keeps single-scene manifests clean)
  if (!scene.anchorPositions?.length) delete scene.anchorPositions;
}

// Read existing manifest to preserve manually-added fields (labels, colorHints, etc.)
let existingScenes = {};
if (fs.existsSync(OUT_PATH)) {
  try {
    const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    for (const s of existing.scenes ?? []) {
      existingScenes[s.id] = s;
    }
  } catch {
    // ignore parse errors – regenerate fresh
  }
}

// Merge: keep existing anchorPositions (if metadata not present) + segment labels / colorHints
for (const scene of sceneMap.values()) {
  const prev = existingScenes[scene.id];
  if (!prev) continue;
  // Preserve manually-set anchorPositions if metadata didn't supply them
  if (!scene.anchorPositions && prev.anchorPositions) {
    scene.anchorPositions = prev.anchorPositions;
  }
  for (const seg of scene.segments) {
    const prevSeg = (prev.segments ?? []).find(s => s.clusterId === seg.clusterId);
    if (prevSeg) {
      if (prevSeg.label)      seg.label      = prevSeg.label;
      if (prevSeg.colorHint)  seg.colorHint  = prevSeg.colorHint;
      if (prevSeg.gaussianCount != null) seg.gaussianCount = prevSeg.gaussianCount;
    }
  }
}

const manifest = {
  _comment: 'Auto-generated by scripts/generate-manifest.js — re-run to refresh, edit labels/colorHints manually.',
  _version: 1,
  scenes: [...sceneMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
  _segmentSchema: {
    _doc: 'After running HDBSCAN/SAGA segmentation, drop [scene]_seg_N.ply files into assets/segments/ then re-run this script. Fill in label and colorHint manually.',
    _segmentFields: {
      id: 'string — [sceneId]_seg_[clusterId]',
      label: 'string — human-readable object/material name from HDBSCAN output',
      clusterId: 'int — cluster index from HDBSCAN',
      file: 'string — path relative to assets/',
      gaussianCount: 'int | null — number of Gaussians in segment',
      colorHint: 'string | null — CSS hex color for UI badge',
    },
  },
};

const json = JSON.stringify(manifest, null, 2);

if (flags.dryRun) {
  console.log(json);
} else {
  fs.writeFileSync(OUT_PATH, json, 'utf8');
  console.log(`Wrote ${manifest.scenes.length} scenes to ${OUT_PATH}`);
  for (const s of manifest.scenes) {
    const segNote = s.segments.length ? ` + ${s.segments.length} segments` : '';
    console.log(`  [${s.type.padEnd(14)}] ${s.id} (${s.anchors.length} anchors${segNote})`);
  }
}
