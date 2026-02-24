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

// ─── Link builder ─────────────────────────────────────────────────────────────

function makeLink(rawText, resolved) {
  const isManifest = isManifestUrl(resolved);
  const cls    = isManifest ? 'uri-manifest' : 'uri-segment';
  // For manifest links, thread the full ancestor chain (including the current page)
  // so the destination can render breadcrumbs all the way back to the root.
  const href   = isManifest ? viewerUrlFor(resolved, [...currentChain, currentUrl]) : resolved;
  const target = isManifest ? '_self' : '_blank';
  const rel    = isManifest ? '' : ' rel="noopener noreferrer"';
  return `<a class="${cls}" href="${escapeHtml(href)}" target="${target}"${rel} title="${escapeHtml(resolved)}">${escapeHtml(rawText)}</a>`;
}

// ─── Format detection ─────────────────────────────────────────────────────────

function detectFormat(url, contentType) {
  try {
    if (new URL(url).pathname.toLowerCase().endsWith('.mpd')) return 'dash';
  } catch {}
  if (contentType.includes('dash+xml') || contentType.includes('application/dash')) return 'dash';
  return 'hls';
}

// ─── HLS renderer ─────────────────────────────────────────────────────────────

function tokenizeAttrList(str, baseUrl) {
  let html = '';
  let i = 0;

  while (i < str.length) {
    const keyMatch = /^([A-Z0-9_-]+)=/.exec(str.slice(i));
    if (keyMatch) {
      const key = keyMatch[1];
      html += `<span class="attr-key">${escapeHtml(key)}</span><span class="attr-eq">=</span>`;
      i += keyMatch[0].length;

      if (str[i] === '"') {
        let j = i + 1;
        while (j < str.length && str[j] !== '"') {
          if (str[j] === '\\') j++;
          j++;
        }
        const inner = str.slice(i + 1, j);
        if (key === 'URI') {
          html += `"${makeLink(inner, resolveUrl(inner, baseUrl))}"`;
        } else {
          html += `<span class="attr-string">${escapeHtml(str.slice(i, j + 1))}</span>`;
        }
        i = j + 1;
      } else {
        const val = /^[^,]*/.exec(str.slice(i))?.[0] ?? '';
        html += /^\d+(\.\d+)?$/.test(val)
          ? `<span class="number">${escapeHtml(val)}</span>`
          : `<span class="attr-value">${escapeHtml(val)}</span>`;
        i += val.length;
      }
    } else if (str[i] === ',') {
      html += `<span class="tag-colon">,</span>`;
      i++;
    } else {
      html += escapeHtml(str[i++]);
    }
  }

  return html;
}

function highlightHlsLine(line, baseUrl) {
  const trimmed = line.trimEnd();
  if (!trimmed.trim()) return '';

  if (trimmed.startsWith('#') && !trimmed.startsWith('#EXT')) {
    return `<span class="comment">${escapeHtml(trimmed)}</span>`;
  }

  if (trimmed === '#EXTM3U') {
    return `<span class="tag-header">${escapeHtml(trimmed)}</span>`;
  }

  if (trimmed.startsWith('#EXT')) {
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      return `<span class="tag-name">${escapeHtml(trimmed)}</span>`;
    }

    const tagName  = trimmed.slice(0, colonIdx);
    const tagValue = trimmed.slice(colonIdx + 1);

    if (tagName === '#EXTINF') {
      const commaIdx = tagValue.indexOf(',');
      if (commaIdx !== -1) {
        return (
          `<span class="tag-name">${escapeHtml(tagName)}</span>` +
          `<span class="tag-colon">:</span>` +
          `<span class="number">${escapeHtml(tagValue.slice(0, commaIdx))}</span>` +
          `<span class="tag-colon">,</span>` +
          `<span class="extinf-title">${escapeHtml(tagValue.slice(commaIdx + 1))}</span>`
        );
      }
      return (
        `<span class="tag-name">${escapeHtml(tagName)}</span>` +
        `<span class="tag-colon">:</span>` +
        `<span class="number">${escapeHtml(tagValue)}</span>`
      );
    }

    return (
      `<span class="tag-name">${escapeHtml(tagName)}</span>` +
      `<span class="tag-colon">:</span>` +
      tokenizeAttrList(tagValue, baseUrl)
    );
  }

  if (!trimmed.startsWith('#')) {
    return makeLink(trimmed, resolveUrl(trimmed, baseUrl));
  }

  return escapeHtml(trimmed);
}

function renderHls(content, baseUrl) {
  return content.split('\n').map((line, idx) =>
    `<div class="line">` +
    `<span class="line-num">${idx + 1}</span>` +
    `<span class="line-content">${highlightHlsLine(line, baseUrl)}</span>` +
    `</div>`
  ).join('');
}

// ─── DASH/MPD renderer ────────────────────────────────────────────────────────

function highlightXmlTag(text, baseUrl) {
  // Closing tag: </TagName>
  const closeMatch = /^<\/([\w:.-]+)(\s*)>/.exec(text);
  if (closeMatch) {
    return `<span class="xml-punct">&lt;/</span>` +
           `<span class="xml-tag-name">${escapeHtml(closeMatch[1])}</span>` +
           escapeHtml(closeMatch[2]) +
           `<span class="xml-punct">&gt;</span>`;
  }

  // Opening / self-closing tag: <TagName attr="val" ...>
  const nameMatch = /^<([\w:.-]+)/.exec(text);
  if (!nameMatch) return escapeHtml(text);

  let html = `<span class="xml-punct">&lt;</span><span class="xml-tag-name">${escapeHtml(nameMatch[1])}</span>`;
  let i = nameMatch[0].length;

  while (i < text.length) {
    if (text[i] === '>') {
      html += `<span class="xml-punct">&gt;</span>`;
      break;
    }
    if (text.slice(i, i + 2) === '/>') {
      html += `<span class="xml-punct">/&gt;</span>`;
      break;
    }

    const wsMatch = /^\s+/.exec(text.slice(i));
    if (wsMatch) { html += escapeHtml(wsMatch[0]); i += wsMatch[0].length; continue; }

    const attrName = /^[\w:.-]+/.exec(text.slice(i))?.[0];
    if (!attrName) { html += escapeHtml(text[i++]); continue; }

    html += `<span class="xml-attr-name">${escapeHtml(attrName)}</span>`;
    i += attrName.length;

    const eqMatch = /^\s*=\s*/.exec(text.slice(i));
    if (!eqMatch) continue;
    html += escapeHtml(eqMatch[0]);
    i += eqMatch[0].length;

    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    html += `<span class="xml-punct">${escapeHtml(quote)}</span>`;
    i++;

    const valEnd = text.indexOf(quote, i);
    const value  = valEnd === -1 ? text.slice(i) : text.slice(i, valEnd);

    // Only linkify absolute URLs; leave template strings (e.g. $Number$) as plain text.
    if (/^https?:\/\//.test(value)) {
      html += makeLink(value, resolveUrl(value, baseUrl));
    } else {
      html += `<span class="xml-attr-value">${escapeHtml(value)}</span>`;
    }

    html += `<span class="xml-punct">${escapeHtml(quote)}</span>`;
    i = valEnd === -1 ? text.length : valEnd + 1;
  }

  return html;
}

// Highlight element text content (e.g. <BaseURL>https://...</BaseURL>).
function highlightXmlText(text, baseUrl) {
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('http')) return escapeHtml(line);
    const pre  = escapeHtml(line.slice(0, line.indexOf(trimmed)));
    const post = escapeHtml(line.slice(line.indexOf(trimmed) + trimmed.length));
    return pre + makeLink(trimmed, resolveUrl(trimmed, baseUrl)) + post;
  }).join('\n');
}

function renderDash(content, baseUrl) {
  // Match comments, processing instructions, and tags (quoting-aware so > inside
  // attribute values doesn't terminate the tag prematurely).
  const tokenRe = /(<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(?:[^"'<>]|"[^"]*"|'[^']*')*>)/g;
  let html = '';
  let lastIndex = 0;

  for (const match of content.matchAll(tokenRe)) {
    if (match.index > lastIndex) {
      html += highlightXmlText(content.slice(lastIndex, match.index), baseUrl);
    }

    const token = match[0];
    if (token.startsWith('<!--')) {
      // Wrap each line individually so no span ever crosses a line boundary.
      html += token.split('\n').map(l => `<span class="xml-comment">${escapeHtml(l)}</span>`).join('\n');
    } else if (token.startsWith('<?')) {
      html += token.split('\n').map(l => `<span class="xml-pi">${escapeHtml(l)}</span>`).join('\n');
    } else {
      html += highlightXmlTag(token, baseUrl);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < content.length) {
    html += highlightXmlText(content.slice(lastIndex), baseUrl);
  }

  return html.split('\n').map((lineHtml, idx) =>
    `<div class="line">` +
    `<span class="line-num">${idx + 1}</span>` +
    `<span class="line-content">${lineHtml}</span>` +
    `</div>`
  ).join('');
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

// ─── App state & load ────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

let currentUrl        = '';
let currentRawContent = '';
let currentChain      = []; // ancestor URLs, oldest first

async function loadManifest(url) {
  if (!url) return;

  currentUrl        = url;
  currentRawContent = '';
  $('url-bar').value              = url;
  $('status-text').textContent    = '';
  $('status-meta').textContent    = '';
  $('manifest-content').innerHTML = '';
  $('download-btn').disabled      = true;
  document.title = new URL(url).pathname.split('/').pop() + ' — Manifest Viewer';

  try {
    const { content, status, contentType } = await fetchManifest(url);
    currentRawContent = content;

    const format = detectFormat(url, contentType);
    $('manifest-content').innerHTML = format === 'dash'
      ? renderDash(content, url)
      : renderHls(content, url);

    $('download-btn').disabled = false;
    const bytes = new TextEncoder().encode(content).length;
    $('status-text').textContent = status;
    $('status-meta').textContent =
      `${format.toUpperCase()} · ${contentType || 'text/plain'} · ${bytes.toLocaleString()} bytes · ${content.split('\n').length} lines`;
  } catch (err) {
    $('download-btn').disabled   = true;
    $('status-text').textContent = 'Error';
    $('manifest-content').textContent = err.message;
  }
}

function navigate(url) {
  if (url) window.location.href = viewerUrlFor(url); // no chain — URL bar starts fresh
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

function urlFilename(url) {
  try { return new URL(url).pathname.split('/').pop() || url; } catch { return url; }
}

function renderBreadcrumbs(chain, url) {
  const el = $('breadcrumbs');
  if (!chain.length) { el.hidden = true; return; }

  const parts = chain.map((ancestor, i) =>
    `<a class="breadcrumb-link" href="${escapeHtml(viewerUrlFor(ancestor, chain.slice(0, i)))}" title="${escapeHtml(ancestor)}">${escapeHtml(urlFilename(ancestor))}</a>`
  );
  parts.push(`<span class="breadcrumb-current">${escapeHtml(urlFilename(url))}</span>`);

  el.innerHTML = parts.join('<span class="breadcrumb-sep">›</span>');
  el.hidden = false;
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // URL comes from either:
  //   ?url=<encoded>  — opened via popup or viewer link
  //   #<raw-url>      — redirected here by declarativeNetRequest interception
  const params = new URLSearchParams(window.location.search);
  let initialUrl = params.get('url') || '';

  if (!initialUrl && location.hash.length > 1) {
    initialUrl = location.hash.slice(1);
    history.replaceState(null, '', '?url=' + encodeURIComponent(initialUrl));
  }

  // Read ancestor chain from &back= params and render breadcrumbs.
  currentChain = params.getAll('back');
  renderBreadcrumbs(currentChain, initialUrl);

  $('back-btn').disabled = history.length <= 1;
  $('back-btn').addEventListener('click', () => history.back());

  $('url-bar').addEventListener('keydown', e => {
    if (e.key === 'Enter') navigate($('url-bar').value.trim());
  });
  $('go-btn').addEventListener('click', () => navigate($('url-bar').value.trim()));

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
