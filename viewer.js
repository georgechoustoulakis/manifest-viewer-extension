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

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(0).padStart(2, '0')}`;
  if (m > 0) return `${m}:${sec.toFixed(0).padStart(2, '0')}`;
  return `${sec.toFixed(3)}s`;
}

// ─── Link builder ─────────────────────────────────────────────────────────────

function makeLink(rawText, resolved) {
  const isManifest = isManifestUrl(resolved);
  const cls    = isManifest ? 'uri-manifest' : 'uri-segment';
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
  const closeMatch = /^<\/([\w:.-]+)(\s*)>/.exec(text);
  if (closeMatch) {
    return `<span class="xml-punct">&lt;/</span>` +
           `<span class="xml-tag-name">${escapeHtml(closeMatch[1])}</span>` +
           escapeHtml(closeMatch[2]) +
           `<span class="xml-punct">&gt;</span>`;
  }

  const nameMatch = /^<([\w:.-]+)/.exec(text);
  if (!nameMatch) return escapeHtml(text);

  let html = `<span class="xml-punct">&lt;</span><span class="xml-tag-name">${escapeHtml(nameMatch[1])}</span>`;
  let i = nameMatch[0].length;

  while (i < text.length) {
    if (text[i] === '>') { html += `<span class="xml-punct">&gt;</span>`; break; }
    if (text.slice(i, i + 2) === '/>') { html += `<span class="xml-punct">/&gt;</span>`; break; }

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
  const tokenRe = /(<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(?:[^"'<>]|"[^"]*"|'[^']*')*>)/g;
  let html = '';
  let lastIndex = 0;

  for (const match of content.matchAll(tokenRe)) {
    if (match.index > lastIndex) {
      html += highlightXmlText(content.slice(lastIndex, match.index), baseUrl);
    }

    const token = match[0];
    if (token.startsWith('<!--')) {
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

// ─── HLS parser (for Timeline view) ──────────────────────────────────────────

function parseHlsAttrs(str) {
  const attrs = {};
  const re = /([A-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]*))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function parseHls(content, baseUrl) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const result = {
    isMaster:      false,
    version:       null,
    targetDuration: null,
    mediaSequence: 0,
    playlistType:  null,
    hasEndList:    false,
    segments:      [],
    streams:       [],
    media:         [],
  };

  let i = 0;
  let pendingDuration    = 0;
  let pendingTitle       = '';
  let pendingDisc        = false;
  let pendingPDT         = null;
  let pendingByterange   = null;
  let currentKey         = null;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-VERSION:')) {
      result.version = parseInt(line.slice(15));
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      result.targetDuration = parseInt(line.slice(22));
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      result.mediaSequence = parseInt(line.slice(22));
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      result.playlistType = line.slice(21);
    } else if (line === '#EXT-X-ENDLIST') {
      result.hasEndList = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseHlsAttrs(line.slice(11));
      currentKey = (a.METHOD && a.METHOD !== 'NONE') ? { method: a.METHOD, uri: a.URI || '' } : null;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      result.isMaster = true;
      const a = parseHlsAttrs(line.slice(18));
      i++;
      // skip any comment lines between the tag and the URI
      while (i < lines.length && lines[i].startsWith('#')) i++;
      if (i < lines.length) {
        result.streams.push({
          bandwidth:        parseInt(a.BANDWIDTH)          || 0,
          averageBandwidth: parseInt(a['AVERAGE-BANDWIDTH']) || 0,
          resolution:       a.RESOLUTION  || '',
          codecs:           a.CODECS      || '',
          frameRate:        a['FRAME-RATE'] || '',
          uri:              resolveUrl(lines[i], baseUrl),
          rawUri:           lines[i],
        });
      }
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      result.isMaster = true;
      const a = parseHlsAttrs(line.slice(13));
      result.media.push({
        type:       a.TYPE       || '',
        groupId:    a['GROUP-ID'] || '',
        language:   a.LANGUAGE   || '',
        name:       a.NAME       || '',
        isDefault:  a.DEFAULT   === 'YES',
        isForced:   a.FORCED    === 'YES',
        uri:        a.URI ? resolveUrl(a.URI, baseUrl) : '',
      });
    } else if (line.startsWith('#EXTINF:')) {
      const val      = line.slice(8);
      const ci       = val.indexOf(',');
      pendingDuration = parseFloat(ci !== -1 ? val.slice(0, ci) : val) || 0;
      pendingTitle    = ci !== -1 ? val.slice(ci + 1) : '';
    } else if (line === '#EXT-X-DISCONTINUITY') {
      pendingDisc = true;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingPDT = line.slice(25);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByterange = line.slice(17);
    } else if (!line.startsWith('#')) {
      result.segments.push({
        seq:         result.mediaSequence + result.segments.length,
        uri:         resolveUrl(line, baseUrl),
        rawUri:      line,
        duration:    pendingDuration,
        title:       pendingTitle,
        discontinuity: pendingDisc,
        key:         currentKey,
        programDateTime: pendingPDT,
        byterange:   pendingByterange,
      });
      pendingDuration  = 0;
      pendingTitle     = '';
      pendingDisc      = false;
      pendingPDT       = null;
      pendingByterange = null;
      // currentKey persists until overridden by a new #EXT-X-KEY
    }

    i++;
  }

  return result;
}

// ─── Timeline: media playlist ─────────────────────────────────────────────────

function renderTimelineMedia(parsed) {
  const { segments, targetDuration, hasEndList, playlistType, mediaSequence } = parsed;

  if (!segments.length) return `<div class="tl-empty">No segments found.</div>`;

  const totalDuration  = segments.reduce((s, seg) => s + seg.duration, 0);
  const avgDuration    = totalDuration / segments.length;
  const discontinuities = segments.filter(s => s.discontinuity).length;
  const encryptedCount = segments.filter(s => s.key).length;
  const type = hasEndList ? 'VOD' : (playlistType === 'EVENT' ? 'EVENT' : 'LIVE');

  // ── Stats header ──
  let html = `<div class="tl-header">`;

  const stat = (label, value, cls = '') =>
    `<div class="tl-stat ${cls}"><span class="tl-stat-label">${label}</span><span class="tl-stat-value">${value}</span></div>`;

  html += stat('Type', type);
  html += stat('Duration', formatDuration(totalDuration));
  html += stat('Segments', segments.length);
  html += stat('Avg segment', `${avgDuration.toFixed(2)}s`);
  if (targetDuration) html += stat('Target dur.', `${targetDuration}s`);
  html += stat('First seq.', mediaSequence);
  if (discontinuities) html += stat('Discontinuities', discontinuities, 'tl-stat--warn');
  if (encryptedCount)  html += stat('Encrypted', encryptedCount, 'tl-stat--enc');
  html += `</div>`;

  // ── Segment track ──
  html += `<div class="tl-track">`;

  let flip = false;
  for (const seg of segments) {
    if (seg.discontinuity) {
      html += `<div class="tl-gap" title="Discontinuity before #${seg.seq}"></div>`;
      flip = false;
    }

    const pct = totalDuration > 0
      ? (seg.duration / totalDuration * 100)
      : (100 / segments.length);

    const cls = seg.key ? 'tl-seg--enc' : (flip ? 'tl-seg--b' : 'tl-seg--a');

    const tip = [
      `#${seg.seq}`,
      `${seg.duration.toFixed(3)}s`,
      seg.rawUri,
      seg.programDateTime ? `PDT: ${seg.programDateTime}` : '',
      seg.byterange       ? `Range: ${seg.byterange}`      : '',
      seg.key             ? `${seg.key.method}`              : '',
    ].filter(Boolean).join('\n');

    html += `<div class="tl-seg ${cls}" style="width:${pct}%" title="${escapeHtml(tip)}"></div>`;
    flip = !flip;
  }

  html += `</div>`;

  // ── Time axis ──
  html += `<div class="tl-axis"><span>0:00</span><span>${formatDuration(totalDuration)}</span></div>`;

  // ── Legend ──
  html += `<div class="tl-legend">`;
  html += `<span class="tl-legend-item"><span class="tl-legend-swatch tl-seg--a"></span>Segment</span>`;
  if (discontinuities) html += `<span class="tl-legend-item"><span class="tl-legend-swatch tl-gap" style="height:10px;width:6px;border-radius:1px"></span>Discontinuity</span>`;
  if (encryptedCount)  html += `<span class="tl-legend-item"><span class="tl-legend-swatch tl-seg--enc"></span>Encrypted</span>`;
  html += `</div>`;

  return html;
}

// ─── Timeline: master playlist ────────────────────────────────────────────────

function renderTimelineMaster(parsed) {
  const { streams, media } = parsed;
  if (!streams.length && !media.length) return `<div class="tl-empty">No renditions found.</div>`;

  const sorted  = [...streams].sort((a, b) => b.bandwidth - a.bandwidth);
  const maxBw   = sorted[0]?.bandwidth || 1;

  const openLink = (uri) => {
    const href = viewerUrlFor(uri, [...currentChain, currentUrl]);
    return `<a class="tl-lane-open" href="${escapeHtml(href)}" title="${escapeHtml(uri)}">&#8599;</a>`;
  };

  let html = `<div class="tl-master">`;

  // ── Video streams ──
  if (sorted.length) {
    html += `<div class="tl-group"><div class="tl-group-label">Video</div>`;
    for (const s of sorted) {
      const pct    = Math.max((s.bandwidth / maxBw) * 100, 4);
      const bwLabel = s.bandwidth >= 1_000_000
        ? `${(s.bandwidth / 1_000_000).toFixed(2)} Mbps`
        : `${(s.bandwidth / 1000).toFixed(0)} Kbps`;
      const meta   = [s.codecs, s.frameRate ? `${s.frameRate} fps` : ''].filter(Boolean).join(' · ');

      html += `<div class="tl-lane">`;
      html += `  <div class="tl-lane-res">${escapeHtml(s.resolution || '—')}</div>`;
      html += `  <div class="tl-lane-track">`;
      html += `    <div class="tl-lane-bar" style="width:${pct}%">`;
      html += `      <span class="tl-lane-bw">${escapeHtml(bwLabel)}</span>`;
      if (meta) html += `<span class="tl-lane-meta">${escapeHtml(meta)}</span>`;
      html += `    </div>`;
      html += `  </div>`;
      html += openLink(s.uri);
      html += `</div>`;
    }
    html += `</div>`;
  }

  // ── Audio tracks ──
  const audio = media.filter(m => m.type === 'AUDIO');
  if (audio.length) {
    html += `<div class="tl-group"><div class="tl-group-label">Audio</div>`;
    for (const t of audio) {
      const info = [t.name, t.language, t.isDefault ? 'default' : ''].filter(Boolean).join(' · ');
      html += `<div class="tl-lane tl-lane--aux">`;
      html += `  <div class="tl-lane-res">${escapeHtml(t.groupId)}</div>`;
      html += `  <div class="tl-lane-aux-info">${escapeHtml(info)}</div>`;
      if (t.uri) html += openLink(t.uri);
      html += `</div>`;
    }
    html += `</div>`;
  }

  // ── Subtitle tracks ──
  const subs = media.filter(m => m.type === 'SUBTITLES');
  if (subs.length) {
    html += `<div class="tl-group"><div class="tl-group-label">Subtitles</div>`;
    for (const t of subs) {
      const info = [t.name, t.language, t.isForced ? 'forced' : ''].filter(Boolean).join(' · ');
      html += `<div class="tl-lane tl-lane--aux">`;
      html += `  <div class="tl-lane-res">${escapeHtml(t.groupId)}</div>`;
      html += `  <div class="tl-lane-aux-info">${escapeHtml(info)}</div>`;
      if (t.uri) html += openLink(t.uri);
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Timeline dispatch ────────────────────────────────────────────────────────

function renderTimeline() {
  const el = $('view-timeline');
  if (!currentParsed) {
    el.innerHTML = `<div class="tl-empty">Timeline is only available for HLS manifests.</div>`;
    return;
  }
  el.innerHTML = currentParsed.isMaster
    ? renderTimelineMaster(currentParsed)
    : renderTimelineMedia(currentParsed);
}

// ─── Tab switching ────────────────────────────────────────────────────────────

let currentView      = 'source';
let timelineRendered = false;

function switchView(view) {
  currentView = view;
  $('tab-source').classList.toggle('tab-btn--active', view === 'source');
  $('tab-timeline').classList.toggle('tab-btn--active', view === 'timeline');
  $('view-source').hidden  = view !== 'source';
  $('view-timeline').hidden = view !== 'timeline';

  if (view === 'timeline' && !timelineRendered) {
    renderTimeline();
    timelineRendered = true;
  }
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
let currentChain      = [];
let currentParsed     = null;

async function loadManifest(url) {
  if (!url) return;

  currentUrl        = url;
  currentRawContent = '';
  currentParsed     = null;
  timelineRendered  = false;

  $('url-bar').value              = url;
  $('status-text').textContent    = '';
  $('status-meta').textContent    = '';
  $('manifest-content').innerHTML = '';
  $('download-btn').disabled      = true;
  document.title = new URL(url).pathname.split('/').pop() + ' — Manifest Viewer';

  // Always start on source view when loading a new manifest
  if (currentView !== 'source') switchView('source');

  try {
    const { content, status, contentType } = await fetchManifest(url);
    currentRawContent = content;

    const format = detectFormat(url, contentType);

    if (format === 'hls') {
      currentParsed = parseHls(content, url);
    }

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
  if (url) window.location.href = viewerUrlFor(url);
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

function urlFilename(url) {
  try { return new URL(url).pathname.split('/').pop() || url; } catch { return url; }
}

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

  $('back-btn').disabled = history.length <= 1;
  $('back-btn').addEventListener('click', () => history.back());

  $('url-bar').addEventListener('keydown', e => {
    if (e.key === 'Enter') navigate($('url-bar').value.trim());
  });
  $('go-btn').addEventListener('click', () => navigate($('url-bar').value.trim()));

  $('tab-source').addEventListener('click',   () => switchView('source'));
  $('tab-timeline').addEventListener('click', () => switchView('timeline'));

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
