'use strict';

// ─── DASH/MPD source view renderer ───────────────────────────────────────────

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
