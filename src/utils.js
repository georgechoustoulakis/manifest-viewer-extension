'use strict';

// ─── General utilities ────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveUrl(href, baseUrl) {
  if (!href) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function isManifestUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase().split('?')[0];
    return path.endsWith('.m3u8') || path.endsWith('.m3u') || path.endsWith('.mpd');
  } catch {
    const lower = url.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('.m3u') || lower.includes('.mpd');
  }
}

function viewerUrlFor(manifestUrl, chain = []) {
  let url = chrome.runtime.getURL('viewer.html') + '?url=' + encodeURIComponent(manifestUrl);
  for (const ancestor of chain) url += '&back=' + encodeURIComponent(ancestor);
  return url;
}

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(0).padStart(2, '0')}`;
  if (m > 0) return `${m}:${sec.toFixed(0).padStart(2, '0')}`;
  return `${sec.toFixed(3)}s`;
}

function detectFormat(url, contentType) {
  try {
    if (new URL(url).pathname.toLowerCase().endsWith('.mpd')) return 'dash';
  } catch {}
  if (contentType.includes('dash+xml') || contentType.includes('application/dash')) return 'dash';
  return 'hls';
}

function urlFilename(url) {
  try { return new URL(url).pathname.split('/').pop() || url; } catch { return url; }
}
