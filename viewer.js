'use strict';

// ─── Utilities ────────────────────────────────────────────────────────────────

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
    return path.endsWith('.m3u8') || path.endsWith('.m3u');
  } catch {
    const lower = url.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('.m3u');
  }
}

function viewerUrlFor(manifestUrl) {
  return chrome.runtime.getURL('viewer.html') + '?url=' + encodeURIComponent(manifestUrl);
}

// ─── Link builder ─────────────────────────────────────────────────────────────

/**
 * Build an <a> element string for a URI found in the manifest.
 * - .m3u8 / .m3u  → navigates within the viewer (same tab)
 * - everything else → opens in a new tab
 *
 * rawText  : the text as it appears in the manifest (may be relative)
 * resolved : the absolute URL
 */
function makeLink(rawText, resolved) {
  const isManifest = isManifestUrl(resolved);
  const cls = isManifest ? 'uri-manifest' : 'uri-segment';
  const href = isManifest ? viewerUrlFor(resolved) : resolved;
  const target = isManifest ? '_self' : '_blank';
  const rel = isManifest ? '' : ' rel="noopener noreferrer"';
  return `<a class="${cls}" href="${escapeHtml(href)}" target="${target}"${rel} title="${escapeHtml(resolved)}">${escapeHtml(rawText)}</a>`;
}

// ─── Attribute list tokenizer ─────────────────────────────────────────────────

/**
 * Tokenize an HLS attribute list string (everything after the first colon of a tag).
 * Returns an HTML string with spans for keys, values, strings, numbers, and links.
 *
 * HLS attribute lists look like:
 *   BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2",URI="playlist.m3u8"
 */
function tokenizeAttrList(str, baseUrl) {
  let html = '';
  let i = 0;
  const len = str.length;

  while (i < len) {
    // Try KEY= pattern
    const keyMatch = /^([A-Z0-9_-]+)=/.exec(str.slice(i));
    if (keyMatch) {
      const key = keyMatch[1];
      html += `<span class="attr-key">${escapeHtml(key)}</span><span class="attr-eq">=</span>`;
      i += keyMatch[0].length;

      if (i < len && str[i] === '"') {
        // Quoted string — scan for closing quote (handle escaped chars)
        let j = i + 1;
        while (j < len && str[j] !== '"') {
          if (str[j] === '\\') j++;
          j++;
        }
        const inner = str.slice(i + 1, j);
        const full = str.slice(i, j + 1); // includes surrounding quotes

        if (key === 'URI') {
          const resolved = resolveUrl(inner, baseUrl);
          html += `"${makeLink(inner, resolved)}"`;
        } else {
          html += `<span class="attr-string">${escapeHtml(full)}</span>`;
        }
        i = j + 1;
      } else {
        // Unquoted value — read until comma or end
        const valMatch = /^[^,]*/.exec(str.slice(i));
        const val = valMatch ? valMatch[0] : '';
        if (/^\d+(\.\d+)?$/.test(val)) {
          html += `<span class="number">${escapeHtml(val)}</span>`;
        } else {
          html += `<span class="attr-value">${escapeHtml(val)}</span>`;
        }
        i += val.length;
      }
    } else if (str[i] === ',') {
      html += `<span class="tag-colon">,</span>`;
      i++;
    } else {
      // Fallback: emit character as-is (handles whitespace, unexpected chars)
      html += escapeHtml(str[i]);
      i++;
    }
  }

  return html;
}

// ─── Line highlighter ─────────────────────────────────────────────────────────

function highlightLine(line, baseUrl) {
  const trimmed = line.trimEnd();

  // Empty or whitespace
  if (trimmed.trim() === '') return '';

  // Non-EXT comment
  if (trimmed.startsWith('#') && !trimmed.startsWith('#EXT')) {
    return `<span class="comment">${escapeHtml(trimmed)}</span>`;
  }

  // Header
  if (trimmed === '#EXTM3U') {
    return `<span class="tag-header">${escapeHtml(trimmed)}</span>`;
  }

  // All other #EXT tags
  if (trimmed.startsWith('#EXT')) {
    const colonIdx = trimmed.indexOf(':');

    // Tags with no value: #EXT-X-ENDLIST, #EXT-X-INDEPENDENT-SEGMENTS, etc.
    if (colonIdx === -1) {
      return `<span class="tag-name">${escapeHtml(trimmed)}</span>`;
    }

    const tagName = trimmed.slice(0, colonIdx);
    const tagValue = trimmed.slice(colonIdx + 1);

    // #EXTINF:duration,title — special case
    if (tagName === '#EXTINF') {
      const commaIdx = tagValue.indexOf(',');
      if (commaIdx !== -1) {
        const duration = tagValue.slice(0, commaIdx);
        const title = tagValue.slice(commaIdx + 1);
        return (
          `<span class="tag-name">${escapeHtml(tagName)}</span>` +
          `<span class="tag-colon">:</span>` +
          `<span class="number">${escapeHtml(duration)}</span>` +
          `<span class="tag-colon">,</span>` +
          `<span class="extinf-title">${escapeHtml(title)}</span>`
        );
      }
      return (
        `<span class="tag-name">${escapeHtml(tagName)}</span>` +
        `<span class="tag-colon">:</span>` +
        `<span class="number">${escapeHtml(tagValue)}</span>`
      );
    }

    // All other tags: tokenize the attribute list
    return (
      `<span class="tag-name">${escapeHtml(tagName)}</span>` +
      `<span class="tag-colon">:</span>` +
      tokenizeAttrList(tagValue, baseUrl)
    );
  }

  // Bare URI line (segment or playlist reference — anything not starting with #)
  if (!trimmed.startsWith('#')) {
    const resolved = resolveUrl(trimmed, baseUrl);
    return makeLink(trimmed, resolved);
  }

  return escapeHtml(trimmed);
}

// ─── Full manifest highlighter ────────────────────────────────────────────────

function highlightManifest(content, baseUrl) {
  const lines = content.split('\n');
  return lines
    .map((line, idx) => {
      const lineNum = idx + 1;
      const highlighted = highlightLine(line, baseUrl);
      return (
        `<div class="line">` +
        `<span class="line-num">${lineNum}</span>` +
        `<span class="line-content">${highlighted}</span>` +
        `</div>`
      );
    })
    .join('');
}

// ─── Fetch via background service worker ─────────────────────────────────────

function fetchManifest(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'fetchManifest', url }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('No response from background service worker'));
        return;
      }
      if (response.success) {
        resolve(response);
      } else {
        reject(new Error(response.error || 'Fetch failed'));
      }
    });
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function showState(state) {
  $('loading').hidden = state !== 'loading';
  $('error').hidden = state !== 'error';
  $('empty').hidden = state !== 'empty';
  $('manifest-view').hidden = state !== 'manifest';
  $('status-bar').hidden = (state !== 'manifest' && state !== 'error');
}

function setStatus(text, meta) {
  $('status-text').textContent = text || '';
  $('status-meta').textContent = meta || '';
}

// ─── Load & render a manifest ─────────────────────────────────────────────────

let currentUrl = '';
let currentRawContent = '';

async function loadManifest(url) {
  if (!url) { showState('empty'); return; }

  currentUrl = url;
  currentRawContent = '';
  $('url-bar').value = url;
  document.title = new URL(url).pathname.split('/').pop() + ' — HLS Viewer';

  showState('loading');
  setStatus('', '');

  try {
    const result = await fetchManifest(url);
    const { content, status, contentType } = result;

    currentRawContent = content;
    $('manifest-content').innerHTML = highlightManifest(content, url);
    showState('manifest');

    const byteCount = new TextEncoder().encode(content).length;
    setStatus(status, `${contentType || 'text/plain'} · ${byteCount.toLocaleString()} bytes · ${content.split('\n').length} lines`);
  } catch (err) {
    showState('error');
    $('error-text').textContent = err.message;
    setStatus('Error', '');
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function navigate(url) {
  if (!url) return;
  window.location.href = viewerUrlFor(url);
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // URL comes from either:
  //   ?url=<encoded>  — opened via popup or viewer link
  //   #<raw-url>      — redirected here by declarativeNetRequest interception
  const params = new URLSearchParams(window.location.search);
  let initialUrl = params.get('url') || '';

  if (!initialUrl && location.hash.length > 1) {
    // Fragment contains the raw manifest URL (no encoding applied by the redirect rule).
    initialUrl = location.hash.slice(1);
    // Rewrite the address bar to the canonical ?url= form and remove the fragment.
    history.replaceState(null, '', '?url=' + encodeURIComponent(initialUrl));
  }

  // Back button — enabled only if history allows it
  $('back-btn').disabled = history.length <= 1;
  $('back-btn').addEventListener('click', () => history.back());

  // URL bar navigation
  $('url-bar').addEventListener('keydown', e => {
    if (e.key === 'Enter') navigate($('url-bar').value.trim());
  });
  $('go-btn').addEventListener('click', () => navigate($('url-bar').value.trim()));

  // Copy current URL
  $('copy-btn').addEventListener('click', async () => {
    const url = currentUrl || $('url-bar').value.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const btn = $('copy-btn');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch {
      // Clipboard access denied — silently ignore
    }
  });

  // Open raw content in a new tab as plain text (via blob URL so the
  // declarativeNetRequest rule doesn't intercept it again).
  $('raw-btn').addEventListener('click', () => {
    if (currentRawContent) {
      const blob = new Blob([currentRawContent], { type: 'text/plain' });
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank', 'noopener');
    } else {
      const url = currentUrl || $('url-bar').value.trim();
      if (url) window.open(url, '_blank', 'noopener');
    }
  });

  // Load initial manifest
  if (initialUrl) {
    loadManifest(initialUrl);
  } else {
    showState('empty');
  }
});
