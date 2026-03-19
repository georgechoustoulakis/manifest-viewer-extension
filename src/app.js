'use strict';

// ─── DOM helper ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ─── App state ────────────────────────────────────────────────────────────────

let currentUrl         = '';
let currentRawContent  = '';
let currentChain       = [];
let currentParsed      = null;
let cachedTimelineRows = null;
let timelineZoom       = 1.0;
let currentView        = 'source';
let timelineRendered   = false;
let segmentsRendered   = false;

// ─── Link builder (needs currentUrl / currentChain) ───────────────────────────

function makeLink(rawText, resolved) {
  const isManifest = isManifestUrl(resolved);
  const cls    = isManifest ? 'uri-manifest' : 'uri-segment';
  const href   = isManifest ? viewerUrlFor(resolved, [...currentChain, currentUrl]) : resolved;
  const target = isManifest ? '_self' : '_blank';
  const rel    = isManifest ? '' : ' rel="noopener noreferrer"';
  return `<a class="${cls}" href="${escapeHtml(href)}" target="${target}"${rel} title="${escapeHtml(resolved)}">${escapeHtml(rawText)}</a>`;
}

// ─── Fetch via background service worker ─────────────────────────────────────

function fetchManifest(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'fetchManifest', url }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.success) {
        resolve(response);
      } else {
        reject(new Error(response?.error || 'Fetch failed'));
      }
    });
  });
}

// ─── Manifest load ────────────────────────────────────────────────────────────

// ─── Collapse state helpers ───────────────────────────────────────────────────

function captureCollapseState() {
  const el = $('view-segments');
  const tracks = new Set(), periods = new Set();
  el.querySelectorAll('.sl-track').forEach((t, i) => {
    if (t.classList.contains('sl-track--collapsed')) tracks.add(i);
  });
  el.querySelectorAll('.sl-period').forEach((p, i) => {
    if (p.classList.contains('sl-period--collapsed')) periods.add(i);
  });
  return { tracks, periods };
}

function restoreCollapseState({ tracks, periods }) {
  const el = $('view-segments');
  el.querySelectorAll('.sl-track').forEach((t, i) => {
    if (tracks.has(i)) t.classList.add('sl-track--collapsed');
  });
  el.querySelectorAll('.sl-period').forEach((p, i) => {
    if (periods.has(i)) p.classList.add('sl-period--collapsed');
  });
}

// ─── Go / Refresh button label ────────────────────────────────────────────────

function updateGoBtn() {
  const isRefresh = currentUrl && $('url-bar').value.trim() === currentUrl;
  $('go-btn').title = isRefresh ? 'Refresh' : 'Go';
}

// ─── Manifest load ────────────────────────────────────────────────────────────

async function loadManifest(url) {
  if (!url) return;

  const isRefresh = url === currentUrl && !!currentUrl;
  const savedCollapses = isRefresh ? captureCollapseState() : null;

  currentUrl         = url;
  currentRawContent  = '';
  currentParsed      = null;
  timelineRendered   = false;
  segmentsRendered   = false;
  cachedTimelineRows = null;
  timelineZoom       = 1.0;

  $('url-bar').value              = url;
  $('status-text').textContent    = '';
  $('status-meta').textContent    = '';
  $('manifest-content').innerHTML = '';
  $('download-btn').disabled      = true;
  document.title = new URL(url).pathname.split('/').pop() + ' — Manifest Viewer';
  updateGoBtn();

  // Refresh: stay on the current view. New navigation: go to source.
  if (!isRefresh && currentView !== 'source') switchView('source');

  try {
    const { content, status, contentType } = await fetchManifest(url);
    currentRawContent = content;

    const format = detectFormat(url, contentType);

    if (format === 'hls') {
      currentParsed = parseHls(content, url);
    } else if (format === 'dash') {
      currentParsed = parseDashMpd(content, url);
    }

    $('manifest-content').innerHTML = format === 'dash'
      ? renderDash(content, url)
      : renderHls(content, url);

    $('download-btn').disabled = false;
    const bytes = new TextEncoder().encode(content).length;
    $('status-text').textContent = status;
    $('status-meta').textContent =
      `${format.toUpperCase()} · ${contentType || 'text/plain'} · ${bytes.toLocaleString()} bytes · ${content.split('\n').length} lines`;

    // On refresh, re-render whichever non-source view is active, then restore collapse state
    if (isRefresh) {
      if (currentView === 'timeline') {
        await renderTimeline();
        timelineRendered = true;
      } else if (currentView === 'segments') {
        await renderSegments();
        segmentsRendered = true;
      }
      if (savedCollapses) restoreCollapseState(savedCollapses);
    }
  } catch (err) {
    $('download-btn').disabled   = true;
    $('status-text').textContent = 'Error';
    $('manifest-content').textContent = err.message;
  }
}

function navigate(url) {
  if (url) window.location.href = viewerUrlFor(url);
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

function renderBreadcrumbs(chain, url) {
  const el = $('breadcrumbs');
  if (!url) { el.hidden = true; return; }

  const parts = chain.map((ancestor, i) =>
    `<a class="breadcrumb-link" href="${escapeHtml(viewerUrlFor(ancestor, chain.slice(0, i)))}" title="${escapeHtml(ancestor)}">${escapeHtml(urlFilename(ancestor))}</a>`
  );
  parts.push(`<span class="breadcrumb-current">${escapeHtml(urlFilename(url))}</span>`);

  el.innerHTML = parts.join('<span class="breadcrumb-sep">›</span>');
  el.hidden = false;
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchView(view, pushHistory = true) {
  currentView = view;
  $('tab-source').classList.toggle('tab-btn--active',   view === 'source');
  $('tab-timeline').classList.toggle('tab-btn--active', view === 'timeline');
  $('tab-segments').classList.toggle('tab-btn--active', view === 'segments');
  $('view-source').hidden   = view !== 'source';
  $('view-timeline').hidden = view !== 'timeline';
  $('view-segments').hidden = view !== 'segments';

  if (view === 'timeline' && !timelineRendered) {
    renderTimeline();
    timelineRendered = true;
  }
  if (view === 'segments' && !segmentsRendered) {
    renderSegments();
    segmentsRendered = true;
  }

  if (pushHistory) {
    history.pushState({ view }, '');
    $('back-btn').disabled = false;
  }
}

// ─── Drag-to-scroll ───────────────────────────────────────────────────────────

function setupDragScroll(el) {
  let isDragging = false, startX = 0, startY = 0, scrollLeft = 0, scrollTop = 0, hasDragged = false;

  el.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('a, button')) return;
    isDragging  = true;
    hasDragged  = false;
    startX      = e.clientX;
    startY      = e.clientY;
    scrollLeft  = el.scrollLeft;
    scrollTop   = el.scrollTop;
    el.classList.add('tl-dragging');
  });

  const stopDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove('tl-dragging');
  };

  document.addEventListener('mouseup',   stopDrag);
  document.addEventListener('mouseleave', stopDrag);

  document.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged = true;
    el.scrollLeft = scrollLeft - dx;
    el.scrollTop  = scrollTop  - dy;
  });

  // Prevent link navigation when the mouse moved during drag
  el.addEventListener('click', e => {
    if (hasDragged) { e.preventDefault(); e.stopPropagation(); hasDragged = false; }
  }, true);
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  let initialUrl = params.get('url') || '';

  if (!initialUrl && location.hash.length > 1) {
    initialUrl = location.hash.slice(1);
    history.replaceState(null, '', '?url=' + encodeURIComponent(initialUrl));
  }

  currentChain = params.getAll('back');
  renderBreadcrumbs(currentChain, initialUrl);

  // Stamp the initial state so popstate can detect "back to root source"
  history.replaceState({ view: 'source', initial: true }, '');

  $('back-btn').disabled = history.length <= 1;
  $('back-btn').addEventListener('click', () => history.back());

  window.addEventListener('popstate', e => {
    const view = e.state?.view;
    if (view === 'timeline' || view === 'source' || view === 'segments') {
      switchView(view, false);
      // Re-disable back btn only when restored to the original source entry with no parent chain
      $('back-btn').disabled = e.state?.initial === true && currentChain.length === 0;
    }
  });

  $('url-bar').addEventListener('input', updateGoBtn);

  const goOrRefresh = () => {
    const url = $('url-bar').value.trim();
    if (!url) return;
    if (url === currentUrl && currentUrl) loadManifest(url);
    else navigate(url);
  };
  $('url-bar').addEventListener('keydown', e => { if (e.key === 'Enter') goOrRefresh(); });
  $('go-btn').addEventListener('click', goOrRefresh);

  $('tab-source').addEventListener('click',   () => switchView('source'));
  $('tab-timeline').addEventListener('click', () => switchView('timeline'));
  $('tab-segments').addEventListener('click', () => switchView('segments'));

  setupDragScroll($('view-timeline'));

  // Pinch (ctrlKey) or mouse wheel (deltaMode !== 0) zooms; trackpad pan passes through
  const tlEl = $('view-timeline');

  tlEl.addEventListener('wheel', e => {
    const isMouseWheel = e.deltaMode !== 0;
    if (!cachedTimelineRows || (!e.ctrlKey && !isMouseWheel)) return;
    e.preventDefault();

    // Width of the sticky label column — must match .tl2-corner CSS width
    const LABEL_W = 188;
    const rect = tlEl.getBoundingClientRect();

    // Cursor position in scroll-space before zoom (relative to track start)
    const mouseTrackX = e.clientX - rect.left - LABEL_W + tlEl.scrollLeft;

    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    timelineZoom = Math.max(0.05, Math.min(100, timelineZoom * factor));

    tlEl.innerHTML = currentParsed?.isDash
      ? buildDashTimelineHtml(cachedTimelineRows, timelineZoom, currentParsed.periods, currentParsed)
      : buildTimelineHtml(cachedTimelineRows, timelineZoom);

    // Scroll so the point under the cursor stays fixed
    tlEl.scrollLeft = Math.max(0, mouseTrackX * factor - (e.clientX - rect.left - LABEL_W));
  }, { passive: false });

  // ── Segment hover tooltip ──
  const tlTip = $('tl-seg-tip');

  function positionTip(cx, cy) {
    const pad = 14, margin = 8;
    const tw = tlTip.offsetWidth, th = tlTip.offsetHeight;
    let x = cx + pad, y = cy + pad;
    if (x + tw > window.innerWidth  - margin) x = cx - tw - pad;
    if (y + th > window.innerHeight - margin) y = cy - th - pad;
    tlTip.style.left = `${x}px`;
    tlTip.style.top  = `${y}px`;
  }

  tlEl.addEventListener('mouseover', e => {
    const seg = e.target.closest('.tl2-seg[data-tip]');
    if (!seg) return;
    try {
      tlTip.innerHTML = buildTipHtml(JSON.parse(seg.dataset.tip));
      tlTip.hidden = false;
      positionTip(e.clientX, e.clientY);
    } catch {}
  });

  tlEl.addEventListener('mousemove', e => {
    if (!tlTip.hidden) positionTip(e.clientX, e.clientY);
  });

  tlEl.addEventListener('mouseout', e => {
    if (e.target.closest('.tl2-seg') && !e.relatedTarget?.closest('.tl2-seg')) {
      tlTip.hidden = true;
    }
  });

  tlEl.addEventListener('mouseleave', () => { tlTip.hidden = true; });

  $('copy-btn').addEventListener('click', async () => {
    const url = currentUrl || $('url-bar').value.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const btn = $('copy-btn');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch { /* clipboard denied */ }
  });

  $('download-btn').addEventListener('click', () => {
    if (!currentRawContent) return;
    const filename = new URL(currentUrl).pathname.split('/').pop() || 'manifest';
    const blob = new Blob([currentRawContent], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: filename,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('raw-btn').addEventListener('click', () => {
    if (currentRawContent) {
      const blob = new Blob([currentRawContent], { type: 'text/plain' });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } else {
      const url = currentUrl || $('url-bar').value.trim();
      if (url) window.open(url, '_blank', 'noopener');
    }
  });

  if (initialUrl) loadManifest(initialUrl);
});
