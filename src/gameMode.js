/**
 * gameMode.js
 *
 * "What's in the Scene?" — a segment-exploration game mode.
 *
 * After segmented splats finish prefetching, the player can enter a mode where:
 *   1. All anchors fade out, segments are hidden.
 *   2. Segments are revealed one at a time with a material/object label.
 *   3. A frequency/count scoreboard shows every revealed concept so far.
 *   4. Player presses SPACE (or taps the reveal button) to advance.
 *   5. After all segments are shown, a summary card appears.
 *
 * This module owns its own DOM overlay.  It calls back into SceneManager
 * to isolate/show segments via the methods:
 *   manager.isolateSegment(clusterId)
 *   manager.exitSegmentMode()
 *
 * No build step — plain ES module.
 */

export class GameMode {
  /**
   * @param {import('./sceneManager.js').SceneManager} sceneManager
   * @param {HTMLElement} container  Element to mount the overlay into (e.g. document.body)
   */
  constructor(sceneManager, container = document.body) {
    this.manager   = sceneManager;
    this.container = container;

    this._segments  = [];   // { mesh, meta }[] — set by activate()
    this._cursor    = -1;   // which segment is currently shown
    this._revealed  = [];   // segments revealed so far
    this._active    = false;

    this._overlay   = this._buildOverlay();
    container.appendChild(this._overlay);
  }

  // ── Public ────────────────────────────────────────────────────────────────────

  /**
   * Enter game mode with a list of segment entries from SceneManager.
   * @param {{ mesh: *, meta: import('./assetLibrary.js').ManifestSegment }[]} segments
   */
  activate(segments) {
    if (segments.length === 0) return;

    this._segments = [...segments].filter(({ meta }) => meta.visible !== false).sort((a, b) => a.meta.clusterId - b.meta.clusterId);
    this._cursor   = -1;
    this._revealed = [];
    this._active   = true;

    this.manager.enterSegmentMode();   // hides anchors, segments start hidden
    this._overlay.style.display = 'flex';
    this._updateRevealButton('Reveal first object →');
    this._setLabelCard(null);
    this._renderScoreboard();
  }

  deactivate() {
    this._active = false;
    this.manager.exitSegmentMode();
    this._summaryEl.style.display = 'none';
    this._summaryEl.innerHTML = '';
    this._setLabelCard(null);
    this._updateRevealButton('Reveal first object →');
    this._revealBtn.onclick = () => this._advance();
    this._overlay.style.display = 'none';
  }

  get isActive() { return this._active; }

  // Handle SPACE key from the main app
  onKeySpace() {
    if (this._active) this._advance();
  }

  // ── Step logic ────────────────────────────────────────────────────────────────

  _advance() {
    this._cursor++;

    if (this._cursor >= this._segments.length) {
      this._showSummary();
      return;
    }

    const entry = this._segments[this._cursor];
    this.manager.isolateSegment(entry.meta.clusterId);
    this.manager.focusSegment(entry.meta.clusterId);
    this._revealed.push(entry.meta);

    this._setLabelCard(entry.meta);
    this._renderScoreboard();

    const remaining = this._segments.length - this._cursor - 1;
    if (remaining === 0) {
      this._updateRevealButton('See summary →');
    } else {
      this._updateRevealButton(`Next (${remaining} remaining) →`);
    }
  }

  _showSummary() {
    this.manager.exitSegmentMode();  // show all anchors again

    const counts = {};
    for (const meta of this._revealed) {
      const key = meta.label || `Segment ${meta.clusterId}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }

    const rows = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `
        <div class="gs-summary-row">
          <span class="gs-summary-label">${label}</span>
          <span class="gs-summary-count">×${count}</span>
        </div>`)
      .join('');

    this._summaryEl.innerHTML = `
      <h3>Scene Summary</h3>
      <p>${this._revealed.length} semantic objects found</p>
      <div class="gs-summary-list">${rows}</div>
    `;
    this._summaryEl.style.display = 'block';
    this._updateRevealButton('Exit game mode');
    this._revealBtn.onclick = () => this.deactivate();
  }

  // ── DOM ───────────────────────────────────────────────────────────────────────

  _buildOverlay() {
    const el = document.createElement('div');
    el.id = 'gs-game-overlay';
    el.style.display = 'none';
    el.innerHTML = `
      <div id="gs-label-card"></div>
      <div id="gs-scoreboard">
        <div id="gs-scoreboard-title">Objects found</div>
        <div id="gs-scoreboard-list"></div>
      </div>
      <div id="gs-summary"></div>
      <button id="gs-reveal-btn">Reveal first object →</button>
    `;

    // Inject styles scoped to these ids
    const style = document.createElement('style');
    style.textContent = `
      #gs-game-overlay {
        position: fixed;
        inset: 0;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        padding-bottom: 40px;
        gap: 16px;
        z-index: 300;
        font-family: system-ui, sans-serif;
      }
      #gs-label-card {
        background: rgba(0,0,0,0.75);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 12px;
        padding: 18px 32px;
        color: white;
        text-align: center;
        min-width: 260px;
        backdrop-filter: blur(4px);
        transition: opacity 0.3s;
      }
      #gs-label-card.empty { opacity: 0; }
      .gs-cluster-id {
        font-size: 11px;
        color: #888;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin-bottom: 4px;
      }
      .gs-label-text {
        font-size: 22px;
        font-weight: 600;
        color: #fff;
      }
      .gs-label-count {
        font-size: 12px;
        color: #aaa;
        margin-top: 4px;
      }
      .gs-label-meta {
        margin-top: 10px;
        display: flex;
        gap: 8px;
        justify-content: center;
        flex-wrap: wrap;
      }
      .gs-label-tag {
        font-size: 11px;
        color: #d8d8d8;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 999px;
        padding: 4px 8px;
        background: rgba(255,255,255,0.05);
      }
      .gs-label-note {
        margin-top: 12px;
        max-width: 360px;
        font-size: 13px;
        line-height: 1.5;
        color: #e5e5e5;
      }
      .gs-color-dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
      }
      #gs-scoreboard {
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0,0,0,0.65);
        border-radius: 10px;
        padding: 14px 18px;
        color: white;
        min-width: 180px;
        max-height: 60vh;
        overflow-y: auto;
        backdrop-filter: blur(4px);
        pointer-events: auto;
      }
      #gs-scoreboard-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #888;
        margin-bottom: 10px;
      }
      .gs-score-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 3px 0;
        font-size: 13px;
        gap: 12px;
      }
      .gs-score-name { color: #ddd; }
      .gs-score-n    { color: #fff; font-weight: 700; font-variant-numeric: tabular-nums; }
      #gs-summary {
        display: none;
        background: rgba(0,0,0,0.85);
        border-radius: 12px;
        padding: 20px 28px;
        color: white;
        max-width: 360px;
        width: 90%;
        backdrop-filter: blur(6px);
        pointer-events: auto;
      }
      #gs-summary h3 { margin: 0 0 8px; font-size: 18px; }
      #gs-summary p  { margin: 0 0 14px; font-size: 13px; color: #aaa; }
      .gs-summary-list { display: flex; flex-direction: column; gap: 6px; }
      .gs-summary-row  { display: flex; justify-content: space-between; font-size: 14px; }
      .gs-summary-label { color: #ddd; }
      .gs-summary-count { color: #fff; font-weight: 700; }
      #gs-reveal-btn {
        pointer-events: auto;
        background: rgba(255,255,255,0.12);
        border: 1px solid rgba(255,255,255,0.25);
        border-radius: 8px;
        padding: 12px 28px;
        color: white;
        font-size: 15px;
        cursor: pointer;
        backdrop-filter: blur(4px);
        transition: background 0.15s;
      }
      #gs-reveal-btn:hover { background: rgba(255,255,255,0.22); }
    `;
    document.head.appendChild(style);

    this._labelCardEl  = el.querySelector('#gs-label-card');
    this._scoreListEl  = el.querySelector('#gs-scoreboard-list');
    this._summaryEl    = el.querySelector('#gs-summary');
    this._revealBtn    = el.querySelector('#gs-reveal-btn');

    this._revealBtn.addEventListener('click', () => this._advance());
    return el;
  }

  _setLabelCard(meta) {
    if (!meta) {
      this._labelCardEl.classList.add('empty');
      this._labelCardEl.innerHTML = '';
      return;
    }
    this._labelCardEl.classList.remove('empty');
    const label = meta.label || `Segment ${meta.clusterId}`;
    const dot   = meta.colorHint
      ? `<span class="gs-color-dot" style="background:${meta.colorHint}"></span>`
      : '';
    const countNote = meta.gaussianCount != null
      ? `<div class="gs-label-count">${meta.gaussianCount.toLocaleString()} Gaussians</div>`
      : '';
    const tags = [meta.theme, meta.room].filter(Boolean)
      .map(tag => `<span class="gs-label-tag">${tag}</span>`)
      .join('');
    const metaRow = tags ? `<div class="gs-label-meta">${tags}</div>` : '';
    const note = meta.text ? `<div class="gs-label-note">${meta.text}</div>` : '';

    this._labelCardEl.innerHTML = `
      <div class="gs-cluster-id">Cluster ${meta.clusterId}</div>
      <div class="gs-label-text">${dot}${label}</div>
      ${countNote}
      ${metaRow}
      ${note}
    `;
  }

  _renderScoreboard() {
    const counts = {};
    for (const meta of this._revealed) {
      const key = meta.label || `Segment ${meta.clusterId}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    this._scoreListEl.innerHTML = sorted
      .map(([name, n]) => `
        <div class="gs-score-row">
          <span class="gs-score-name">${name}</span>
          <span class="gs-score-n">×${n}</span>
        </div>`)
      .join('') || '<div style="color:#666;font-size:12px">None yet</div>';
  }

  _updateRevealButton(text) {
    this._revealBtn.textContent = text;
    this._revealBtn.onclick = () => this._advance();
  }
}
