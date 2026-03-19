'use strict';

// ─── Timeline constants & helpers ─────────────────────────────────────────────

const DISC_LINE_PX = 2; // width of the disc boundary overlay line

function splitIntoRuns(segs) {
  const runs = [];
  let cur = [];
  for (const seg of segs) {
    if (seg.discontinuity && cur.length > 0) { runs.push(cur); cur = []; }
    cur.push(seg);
  }
  if (cur.length > 0) runs.push(cur);
  return runs;
}

function runDuration(run) {
  return run.reduce((s, seg) => s + seg.duration, 0);
}

function tickInterval(totalSec, pxPerSec) {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return candidates.find(c => c * pxPerSec >= 60) ?? candidates[candidates.length - 1];
}

function formatTick(s) {
  if (s < 60) return `${s}s`;
  const m   = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}:${String(rem).padStart(2, '0')}`;
  const h   = Math.floor(m / 60);
  const min = m % 60;
  return `${h}:${String(min).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function segFilename(seg) {
  try { return new URL(seg.uri).pathname.split('/').pop() || ''; }
  catch { return (seg.rawUri ?? seg.uri ?? '').split('/').pop() || ''; }
}

// ─── Segment hover tooltip ────────────────────────────────────────────────────

function buildTipHtml(d) {
  const row = (key, val) =>
    `<div class="tt-row"><span class="tt-key">${key}</span><span class="tt-val">${val}</span></div>`;
  const sep = () => '<div class="tt-sep"></div>';

  let html = `<div class="tt-head">Segment #${d.seq}</div><div class="tt-body">`;

  if (d.disc != null) html += row('Disc run', `#${d.disc}`);
  html += row('Duration', `${d.dur.toFixed(3)}s`);
  html += sep();
  html += row('Time', `${d.gStart.toFixed(3)}s \u2192 ${d.gEnd.toFixed(3)}s`);
  if (d.dStart != null) html += row('Within disc', `${d.dStart.toFixed(3)}s \u2192 ${d.dEnd.toFixed(3)}s`);
  html += sep();
  const uri   = d.uri || '';
  const fname = uri.split('/').pop().split('?')[0] || uri;
  if (uri) {
    html += row('File', escapeHtml(fname));
    html += `<div class="tt-uri-block" title="${escapeHtml(uri)}">${escapeHtml(uri)}</div>`;
  }

  if (d.resolution || d.bandwidth || d.frameRate || d.codecs) {
    html += sep();
    if (d.resolution) html += row('Resolution', escapeHtml(d.resolution));
    if (d.bandwidth)  html += row('Bitrate',    `${(d.bandwidth / 1000).toFixed(0)} Kbps`);
    if (d.frameRate)  html += row('Frame rate', `${escapeHtml(d.frameRate)} fps`);
    if (d.codecs)     html += row('Codecs',     `<span class="tt-small">${escapeHtml(d.codecs)}</span>`);
  }

  const extras = [];
  if (d.key)       extras.push(row('Encryption', escapeHtml(d.key.method)));
  if (d.key?.uri)  extras.push(row('Key URI',    `<span class="tt-small">${escapeHtml(d.key.uri)}</span>`));
  if (d.byterange) extras.push(row('Byte range', escapeHtml(d.byterange)));
  if (d.pdt)       extras.push(row('PDT',        escapeHtml(d.pdt)));
  if (d.title)     extras.push(row('Title',      escapeHtml(d.title)));
  if (extras.length) { html += sep(); html += extras.join(''); }

  html += '</div>';
  return html;
}

// ─── Timeline HTML builder ────────────────────────────────────────────────────

function buildTimelineHtml(rows, zoomFactor = 1) {
  const validRows = rows.filter(r => r.segs.length > 0);
  if (!validRows.length) return `<div class="tl2-empty">No segment data available.</div>`;

  // Split each row into discontinuity runs
  const rowRuns  = validRows.map(row => splitIntoRuns(row.segs));
  const numRuns  = Math.max(...rowRuns.map(r => r.length), 1);

  // Per-run max duration across all rows (aligns discontinuity boundaries)
  const maxRunDurs = Array.from({ length: numRuns }, (_, ri) =>
    Math.max(...rowRuns.map(runs => ri < runs.length ? runDuration(runs[ri]) : 0))
  );
  const totalDuration = maxRunDurs.reduce((s, d) => s + d, 0);

  if (totalDuration <= 0) return `<div class="tl2-empty">No timed segments found.</div>`;

  // Scale: target ~120px per average segment
  const totalSegs = validRows.reduce((s, r) => s + r.segs.length, 0);
  const avgDur    = totalDuration / (totalSegs / validRows.length);
  const pxPerSec  = Math.max(120 / avgDur, 6) * zoomFactor;

  // Global run offsets in seconds
  const runOffsSec = [];
  let tOff = 0;
  for (const dur of maxRunDurs) { runOffsSec.push(tOff); tOff += dur; }

  // No gap zones — segments sit at exact time positions.
  const trackW   = Math.ceil(totalDuration * pxPerSec);
  const interval = tickInterval(totalDuration, pxPerSec);

  const toX = (ri, tRel) =>
    Math.round((runOffsSec[ri] + tRel) * pxPerSec);

  let html = '';

  // ── Ruler ──
  html += `<div class="tl2-ruler">`;
  html += `<div class="tl2-corner"><span class="tl2-zoom-hint">Ctrl+scroll to zoom</span></div>`;
  html += `<div class="tl2-ruler-inner" style="width:${trackW}px">`;
  for (let ri = 0; ri < numRuns; ri++) {
    // Stop half an interval before run end to avoid crowding the next run's t=0 tick.
    const tickStop = maxRunDurs[ri] - interval * 0.5;
    for (let t = 0; t <= tickStop; t += interval) {
      const x = toX(ri, t);
      html += `<div class="tl2-tick" style="left:${x}px">${escapeHtml(formatTick(Math.round(runOffsSec[ri] + t)))}</div>`;
    }
    if (ri < numRuns - 1) {
      const sepX = toX(ri, maxRunDurs[ri]);
      html += `<div class="tl2-disc-line" style="left:${sepX - 1}px"></div>`;
    }
  }
  html += `</div></div>`;

  // ── Discontinuity index row ──
  if (numRuns > 1) {
    html += `<div class="tl2-row tl2-row--disc-index">`;
    html += `<div class="tl2-row-label"><span class="tl2-row-name">Disc #</span></div>`;
    html += `<div class="tl2-row-track" style="width:${trackW}px">`;
    for (let ri = 0; ri < numRuns; ri++) {
      const x = toX(ri, 0);
      const w = toX(ri, maxRunDurs[ri]) - x - 1;
      if (w >= 1) {
        html += `<div class="tl2-disc-idx" style="left:${x}px;width:${w}px">#${ri}</div>`;
      }
      if (ri < numRuns - 1) {
        const sepX = toX(ri, maxRunDurs[ri]);
        html += `<div class="tl2-disc-line" style="left:${sepX - 1}px"></div>`;
      }
    }
    html += `</div></div>`;
  }

  // ── Segment rows ──
  for (let rowIdx = 0; rowIdx < validRows.length; rowIdx++) {
    const row  = validRows[rowIdx];
    const runs = rowRuns[rowIdx];

    const rowMod = row.isAudio ? ' tl2-row--audio' : row.isIframe ? ' tl2-row--iframe' : row.isSubtitle ? ' tl2-row--subtitle' : '';
    html += `<div class="tl2-row${rowMod}">`;

    const [namePart = '', ...subParts] = row.label.split('\n');
    html += `<div class="tl2-row-label">`;
    html += `<span class="tl2-row-name">${escapeHtml(namePart)}</span>`;
    for (const sub of subParts) html += `<span class="tl2-row-sub">${escapeHtml(sub)}</span>`;
    if (row.error) html += `<span class="tl2-row-err">fetch failed</span>`;
    html += `</div>`;

    html += `<div class="tl2-row-track" style="width:${trackW}px">`;
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      let tRel = 0;
      let alt  = false;

      for (const seg of run) {
        const tStart = tRel;
        tRel += seg.duration;
        const tEnd = tRel;

        const globalStart = runOffsSec[ri] + tStart;
        const globalEnd   = runOffsSec[ri] + tEnd;
        const x = toX(ri, tStart);
        const w = toX(ri, tEnd) - x - 1;
        if (w < 1) continue; // sub-pixel at current zoom — skip, zoom in to see

        const cls     = seg.key ? 'tl2-seg--enc'
                      : row.isAudio    ? 'tl2-seg--audio'
                      : row.isIframe   ? 'tl2-seg--iframe'
                      : row.isSubtitle ? 'tl2-seg--subtitle'
                      : 'tl2-seg--video';
        const fname   = segFilename(seg);
        const tipData = escapeHtml(JSON.stringify({
          seq: seg.seq, disc: ri, dur: seg.duration,
          gStart: globalStart, gEnd: globalEnd,
          dStart: tStart,      dEnd: tEnd,
          uri: seg.rawUri, key: seg.key,
          byterange: seg.byterange, pdt: seg.programDateTime, title: seg.title,
          codecs: row.codecs || '', bandwidth: row.bandwidth || 0,
          resolution: row.resolution || '', frameRate: row.frameRate || '',
        }));

        html += `<div class="tl2-seg ${cls}${alt ? ' tl2-seg--alt' : ''}" ` +
                `style="left:${x}px;width:${w}px" data-tip="${tipData}">`;
        if (w >= 30) html += `<span class="tl2-seg-seq">#${seg.seq}</span>`;
        if (w >= 50 && fname) html += `<span class="tl2-seg-fname">${escapeHtml(fname)}</span>`;
        if (w >= 90) html += `<span class="tl2-seg-time">${globalStart.toFixed(1)}\u2013${globalEnd.toFixed(1)}s</span>`;
        html += `</div>`;
        alt = !alt;
      }

      // Disc boundary between this run and the next.
      if (ri < numRuns - 1) {
        const sepX    = toX(ri, maxRunDurs[ri]);
        const rowEndX = toX(ri, runDuration(run));
        // If this row is shorter than the max run duration, fill the empty
        // region with a hatched band so it's visually distinct from content.
        if (rowEndX < sepX - 1) {
          html += `<div class="tl2-disc-sep" style="left:${rowEndX}px;width:${sepX - rowEndX}px"></div>`;
        }
        // Always overlay the thin disc-line at the shared boundary pixel.
        html += `<div class="tl2-disc-line" style="left:${sepX - 1}px"></div>`;
      }
    }
    html += `</div></div>`;
  }

  return html;
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function buildMediaRows(parsed, baseUrl) {
  return [{ label: urlFilename(baseUrl), segs: parsed.segments }];
}

function simplifyVideoCodec(codecsStr) {
  if (!codecsStr) return '';
  for (const c of codecsStr.split(',').map(s => s.trim())) {
    if (/^avc1/i.test(c))       return 'H.264';
    if (/^hvc1|^hev1/i.test(c)) return 'H.265';
    if (/^av01/i.test(c))       return 'AV1';
    if (/^vp09/i.test(c))       return 'VP9';
  }
  return '';
}

async function buildMasterRows(parsed, baseUrl) {
  // Deduplicate by URI — the same video playlist is listed once per audio group
  const seen = new Set();
  const unique = parsed.streams.filter(s => seen.has(s.uri) ? false : seen.add(s.uri));
  const sorted = unique.sort((a, b) => b.bandwidth - a.bandwidth);

  const videoRows = await Promise.all(sorted.map(async stream => {
    const bwLabel = stream.bandwidth >= 1_000_000
      ? `${(stream.bandwidth / 1_000_000).toFixed(2)} Mbps`
      : `${(stream.bandwidth / 1000).toFixed(0)} Kbps`;
    const codecLabel = simplifyVideoCodec(stream.codecs);
    const fpsLabel   = stream.frameRate ? `${parseFloat(stream.frameRate).toFixed(0)}fps` : '';
    const detailParts = [codecLabel, fpsLabel].filter(Boolean);
    const namePart = stream.resolution || bwLabel;
    const label = detailParts.length
      ? `${namePart}\n${bwLabel}\n${detailParts.join(' · ')}`
      : `${namePart}\n${bwLabel}`;
    try {
      const { content } = await fetchManifest(stream.uri);
      const child = parseHls(content, stream.uri);
      return { label, segs: child.segments, url: stream.uri,
               codecs: stream.codecs, bandwidth: stream.bandwidth,
               resolution: stream.resolution, frameRate: stream.frameRate };
    } catch {
      return { label, segs: [], url: stream.uri, error: true,
               codecs: stream.codecs, bandwidth: stream.bandwidth,
               resolution: stream.resolution, frameRate: stream.frameRate };
    }
  }));

  const iframeRows = await Promise.all(
    [...parsed.iframes].sort((a, b) => b.bandwidth - a.bandwidth).map(async iframe => {
      const bwLabel = iframe.bandwidth >= 1_000_000
        ? `${(iframe.bandwidth / 1_000_000).toFixed(2)} Mbps`
        : `${(iframe.bandwidth / 1000).toFixed(0)} Kbps`;
      const codecLabel = simplifyVideoCodec(iframe.codecs);
      const namePart = iframe.resolution || bwLabel;
      const label = codecLabel
        ? `${namePart}\n${bwLabel}\n${codecLabel}`
        : `${namePart}\n${bwLabel}`;
      try {
        const { content } = await fetchManifest(iframe.uri);
        const child = parseHls(content, iframe.uri);
        return { label, segs: child.segments, url: iframe.uri, isIframe: true,
                 codecs: iframe.codecs, bandwidth: iframe.bandwidth, resolution: iframe.resolution };
      } catch {
        return { label, segs: [], url: iframe.uri, isIframe: true, error: true,
                 codecs: iframe.codecs, bandwidth: iframe.bandwidth, resolution: iframe.resolution };
      }
    })
  );

  const audioRows = await Promise.all(
    parsed.media.filter(m => m.uri && m.type === 'AUDIO').map(async track => {
      const label = `${track.name}${track.language ? ` (${track.language})` : ''}\n${track.groupId}`;
      try {
        const { content } = await fetchManifest(track.uri);
        const child = parseHls(content, track.uri);
        return { label, segs: child.segments, url: track.uri, isAudio: true };
      } catch {
        return { label, segs: [], url: track.uri, isAudio: true, error: true };
      }
    })
  );

  const subtitleRows = await Promise.all(
    parsed.media.filter(m => m.uri && m.type === 'SUBTITLES').map(async track => {
      const label = `${track.name}${track.language ? ` (${track.language})` : ''}\n${track.groupId}`;
      try {
        const { content } = await fetchManifest(track.uri);
        const child = parseHls(content, track.uri);
        return { label, segs: child.segments, url: track.uri, isSubtitle: true };
      } catch {
        return { label, segs: [], url: track.uri, isSubtitle: true, error: true };
      }
    })
  );

  return [...videoRows, ...iframeRows, ...audioRows, ...subtitleRows];
}

// ─── DASH timeline ────────────────────────────────────────────────────────────

function buildDashRows(parsed) {
  const video = [], audio = [], text = [];

  for (const period of parsed.periods) {
    for (const as of period.adaptationSets) {
      const sortedReps = [...as.reps].sort((a, b) => b.bandwidth - a.bandwidth);
      for (const rep of sortedReps) {
        const bwLabel = rep.bandwidth >= 1_000_000
          ? `${(rep.bandwidth / 1_000_000).toFixed(2)} Mbps`
          : `${(rep.bandwidth / 1000).toFixed(0)} Kbps`;

        let label;
        if (as.isVideo) {
          const namePart   = rep.width && rep.height ? `${rep.width}x${rep.height}` : bwLabel;
          const codecLabel = simplifyVideoCodec(rep.codecs);
          const fpsLabel   = rep.frameRate ? `${parseFloat(rep.frameRate).toFixed(0)}fps` : '';
          const detail     = [codecLabel, fpsLabel].filter(Boolean).join(' · ');
          label = detail ? `${namePart}\n${bwLabel}\n${detail}` : `${namePart}\n${bwLabel}`;
        } else {
          const namePart = as.label || as.lang || (as.isAudio ? 'Audio' : 'Subtitle');
          label = as.lang && as.label && as.lang !== as.label
            ? `${namePart}\n${as.lang}\n${bwLabel}`
            : `${namePart}\n${bwLabel}`;
        }

        const row = {
          label,
          segs: rep.segs,
          isAudio:    as.isAudio,
          isSubtitle: as.isText,
          // pass metadata for tooltip
          bandwidth:  rep.bandwidth,
          resolution: rep.width && rep.height ? `${rep.width}x${rep.height}` : '',
          codecs:     rep.codecs,
          frameRate:  rep.frameRate,
        };
        if (as.isAudio)      audio.push(row);
        else if (as.isText)  text.push(row);
        else                 video.push(row);
      }
    }
  }

  return [...video, ...audio, ...text];
}

function buildDashTimelineHtml(rows, zoomFactor = 1) {
  const validRows = rows.filter(r => r.segs.length > 0);
  if (!validRows.length) return `<div class="tl2-empty">No segment data available.</div>`;

  // Find the absolute time range across all rows
  let minT = Infinity, maxT = -Infinity;
  for (const row of validRows) {
    for (const seg of row.segs) {
      if (seg.start            < minT) minT = seg.start;
      if (seg.start + seg.duration > maxT) maxT = seg.start + seg.duration;
    }
  }
  if (!isFinite(minT) || maxT <= minT) return `<div class="tl2-empty">No timed segments found.</div>`;

  const totalDuration = maxT - minT;
  const totalSegs = validRows.reduce((s, r) => s + r.segs.length, 0);
  const avgDur    = totalDuration / (totalSegs / validRows.length);
  const pxPerSec  = Math.max(120 / avgDur, 6) * zoomFactor;
  const trackW    = Math.ceil(totalDuration * pxPerSec);
  const interval  = tickInterval(totalDuration, pxPerSec);
  const toX       = t => Math.round((t - minT) * pxPerSec);

  let html = '';

  // ── Ruler ──
  html += `<div class="tl2-ruler">`;
  html += `<div class="tl2-corner"><span class="tl2-zoom-hint">Ctrl+scroll to zoom</span></div>`;
  html += `<div class="tl2-ruler-inner" style="width:${trackW}px">`;
  for (let t = minT; t < maxT - interval * 0.5; t += interval) {
    html += `<div class="tl2-tick" style="left:${toX(t)}px">${escapeHtml(formatTick(Math.round(t)))}</div>`;
  }
  html += `</div></div>`;

  // ── Rows ──
  for (const row of validRows) {
    const rowMod = row.isAudio ? ' tl2-row--audio' : row.isSubtitle ? ' tl2-row--subtitle' : '';
    html += `<div class="tl2-row${rowMod}">`;

    const [namePart = '', ...subParts] = row.label.split('\n');
    html += `<div class="tl2-row-label">`;
    html += `<span class="tl2-row-name">${escapeHtml(namePart)}</span>`;
    for (const sub of subParts) html += `<span class="tl2-row-sub">${escapeHtml(sub)}</span>`;
    html += `</div>`;

    html += `<div class="tl2-row-track" style="width:${trackW}px">`;
    let alt = false;
    for (const seg of row.segs) {
      const x = toX(seg.start);
      const w = Math.max(1, Math.round(seg.duration * pxPerSec) - 1);
      const segEnd = seg.start + seg.duration;

      const cls    = row.isAudio ? 'tl2-seg--audio' : row.isSubtitle ? 'tl2-seg--subtitle' : 'tl2-seg--video';
      const altCls = alt ? ' tl2-seg--alt' : '';
      const fname  = segFilename(seg);

      const tipData = escapeHtml(JSON.stringify({
        seq: seg.seq, dur: seg.duration,
        gStart: seg.start, gEnd: segEnd,
        uri: seg.uri,
        bandwidth: row.bandwidth, resolution: row.resolution,
        codecs: row.codecs, frameRate: row.frameRate,
      }));

      html += `<div class="tl2-seg ${cls}${altCls}" style="left:${x}px;width:${w}px" data-tip="${tipData}">`;
      if (w >= 30) html += `<span class="tl2-seg-seq">#${seg.seq}</span>`;
      if (w >= 50 && fname) html += `<span class="tl2-seg-fname">${escapeHtml(fname)}</span>`;
      if (w >= 90) html += `<span class="tl2-seg-time">${seg.start.toFixed(1)}\u2013${segEnd.toFixed(1)}s</span>`;
      html += `</div>`;
      alt = !alt;
    }
    html += `</div></div>`;
  }

  return html;
}

// ─── Segment list HTML builder ────────────────────────────────────────────────

function buildSegmentListHtml(rows, isDash, baseUrl) {
  const validRows = rows.filter(r => r.segs.length > 0);
  if (!validRows.length) return `<div class="sl-empty">No segment data available.</div>`;

  let html = '<div class="sl-view">';

  for (const row of validRows) {
    const totalDur = row.segs.reduce((s, seg) => s + seg.duration, 0);
    const [namePart = '', ...subParts] = row.label.split('\n');

    html += '<div class="sl-track">';
    html += '<div class="sl-track-header">';
    html += `<span class="sl-track-toggle" aria-hidden="true">&#9660;</span>`;
    html += `<span class="sl-track-name">${escapeHtml(namePart)}</span>`;
    if (subParts.length) {
      html += `<span class="sl-track-meta">${subParts.map(escapeHtml).join(' · ')}</span>`;
    }
    html += `<span class="sl-track-count">${row.segs.length} segment${row.segs.length !== 1 ? 's' : ''} · ${totalDur.toFixed(3)}s total</span>`;
    if (row.error) html += `<span class="sl-track-err">fetch failed</span>`;
    html += '</div>';

    html += '<table class="sl-table"><thead><tr>';
    html += '<th class="sl-th-seq">#</th>';
    if (!isDash) {
      html += '<th class="sl-th-start">Start (in run)</th>';
      html += '<th class="sl-th-end">End (in run)</th>';
    } else {
      html += '<th class="sl-th-start">Start</th>';
      html += '<th class="sl-th-end">End</th>';
    }
    html += '<th class="sl-th-dur">Duration</th>';
    html += '<th class="sl-th-uri">Segment</th>';
    html += '</tr></thead><tbody>';

    if (!isDash) {
      // HLS: split by discontinuity runs; times are relative within each run
      let discRunIdx = 0;
      let tRel = 0;
      for (const seg of row.segs) {
        if (seg.discontinuity) {
          html += `<tr class="sl-disc-row"><td colspan="5">` +
            `<span class="sl-disc-label">discontinuity · run #${++discRunIdx}</span>` +
            `</td></tr>`;
          tRel = 0;
        }
        const start = tRel;
        tRel += seg.duration;
        const end = tRel;
        const uri = seg.uri || '';
        const fname = uri ? uri.split('/').pop().split('?')[0] || uri : '';

        html += '<tr class="sl-seg-row">';
        html += `<td class="sl-seq">#${escapeHtml(String(seg.seq))}</td>`;
        html += `<td class="sl-time">${start.toFixed(3)}s</td>`;
        html += `<td class="sl-time">${end.toFixed(3)}s</td>`;
        html += `<td class="sl-dur">${seg.duration.toFixed(3)}s</td>`;
        if (uri) {
          html += `<td class="sl-uri"><a href="${escapeHtml(uri)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(uri)}">${escapeHtml(fname)}</a></td>`;
        } else {
          html += `<td class="sl-uri sl-uri--none">—</td>`;
        }
        html += '</tr>';
      }
    } else {
      // DASH: absolute times; insert period separators at significant time gaps
      let prevEnd = null;
      let periodIdx = 0;
      for (const seg of row.segs) {
        if (prevEnd !== null && seg.start > prevEnd + 0.1) {
          html += `<tr class="sl-period-row"><td colspan="5">` +
            `<span class="sl-period-label">period #${++periodIdx}</span>` +
            `</td></tr>`;
        }
        const end = seg.start + seg.duration;
        const rawUri = seg.uri || '';
        const resolvedUri = rawUri ? resolveUrl(rawUri, baseUrl) : '';
        const fname = resolvedUri ? resolvedUri.split('/').pop().split('?')[0] || rawUri : '';

        html += '<tr class="sl-seg-row">';
        html += `<td class="sl-seq">#${escapeHtml(String(seg.seq))}</td>`;
        html += `<td class="sl-time">${seg.start.toFixed(3)}s</td>`;
        html += `<td class="sl-time">${end.toFixed(3)}s</td>`;
        html += `<td class="sl-dur">${seg.duration.toFixed(3)}s</td>`;
        if (resolvedUri) {
          html += `<td class="sl-uri"><a href="${escapeHtml(resolvedUri)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(resolvedUri)}">${escapeHtml(fname)}</a></td>`;
        } else {
          html += `<td class="sl-uri sl-uri--none">—</td>`;
        }
        html += '</tr>';
        prevEnd = end;
      }
    }

    html += '</tbody></table></div>';
  }

  html += '</div>';
  return html;
}

// ─── Segment list render entry point ──────────────────────────────────────────

async function renderSegments() {
  const el = $('view-segments');
  if (!currentParsed) {
    el.innerHTML = `<div class="sl-empty">Load a manifest to view segments.</div>`;
    return;
  }
  try {
    if (!cachedTimelineRows) {
      if (currentParsed.isDash) {
        cachedTimelineRows = buildDashRows(currentParsed);
      } else if (currentParsed.isMaster) {
        el.innerHTML = `<div class="sl-loading">Fetching renditions\u2026</div>`;
        cachedTimelineRows = await buildMasterRows(currentParsed, currentUrl);
      } else {
        cachedTimelineRows = buildMediaRows(currentParsed, currentUrl);
      }
    }
    el.innerHTML = buildSegmentListHtml(cachedTimelineRows, !!currentParsed.isDash, currentUrl);
    for (const header of el.querySelectorAll('.sl-track-header')) {
      header.addEventListener('click', () => {
        header.closest('.sl-track').classList.toggle('sl-track--collapsed');
      });
    }
  } catch (err) {
    el.innerHTML = `<div class="sl-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── Timeline render entry point ──────────────────────────────────────────────

async function renderTimeline() {
  const el = $('view-timeline');
  if (!currentParsed) {
    el.innerHTML = `<div class="tl2-empty">Load a manifest to view the timeline.</div>`;
    return;
  }
  try {
    if (!cachedTimelineRows) {
      if (currentParsed.isDash) {
        cachedTimelineRows = buildDashRows(currentParsed);
      } else if (currentParsed.isMaster) {
        el.innerHTML = `<div class="tl2-loading">Fetching renditions\u2026</div>`;
        cachedTimelineRows = await buildMasterRows(currentParsed, currentUrl);
      } else {
        cachedTimelineRows = buildMediaRows(currentParsed, currentUrl);
      }
    }
    el.innerHTML = currentParsed.isDash
      ? buildDashTimelineHtml(cachedTimelineRows, timelineZoom)
      : buildTimelineHtml(cachedTimelineRows, timelineZoom);
  } catch (err) {
    el.innerHTML = `<div class="tl2-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}
