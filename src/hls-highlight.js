'use strict';

// ─── HLS source view renderer ─────────────────────────────────────────────────

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
