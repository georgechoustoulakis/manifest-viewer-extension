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
  catch { return seg.rawUri.split('/').pop() || ''; }
}

// ─── Segment hover tooltip ────────────────────────────────────────────────────

function buildTipHtml(d) {
  const row = (key, val) =>
    `<div class="tt-row"><span class="tt-key">${key}</span><span class="tt-val">${val}</span></div>`;
  const sep = () => '<div class="tt-sep"></div>';

  let html = `<div class="tt-head">Segment #${d.seq}</div><div class="tt-body">`;

  html += row('Disc run',    `#${d.disc}`);
  html += row('Duration',    `${d.dur.toFixed(3)}s`);
  html += sep();
  html += row('Global',      `${d.gStart.toFixed(3)}s \u2192 ${d.gEnd.toFixed(3)}s`);
  html += row('Within disc', `${d.dStart.toFixed(3)}s \u2192 ${d.dEnd.toFixed(3)}s`);
  html += sep();
  const fname = d.uri.split('/').pop().split('?')[0] || d.uri;
  html += row('File', escapeHtml(fname));
  html += `<div class="tt-uri-block" title="${escapeHtml(d.uri)}">${escapeHtml(d.uri)}</div>`;

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
  html += `<div class="tl2-corner"></div>`;
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

    html += `<div class="tl2-row${row.isAudio ? ' tl2-row--audio' : ''}">`;

    const [namePart = '', subPart = ''] = row.label.split('\n');
    html += `<div class="tl2-row-label">`;
    html += `<span class="tl2-row-name">${escapeHtml(namePart)}</span>`;
    if (subPart)   html += `<span class="tl2-row-sub">${escapeHtml(subPart)}</span>`;
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

        const cls     = seg.key ? 'tl2-seg--enc' : row.isAudio ? 'tl2-seg--audio' : 'tl2-seg--video';
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

async function buildMasterRows(parsed, baseUrl) {
  const sorted = [...parsed.streams].sort((a, b) => b.bandwidth - a.bandwidth);

  const videoRows = await Promise.all(sorted.map(async stream => {
    const bwLabel = stream.bandwidth >= 1_000_000
      ? `${(stream.bandwidth / 1_000_000).toFixed(2)} Mbps`
      : `${(stream.bandwidth / 1000).toFixed(0)} Kbps`;
    const label = stream.resolution ? `${stream.resolution}\n${bwLabel}` : bwLabel;
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

  return [...videoRows, ...audioRows];
}

// ─── Timeline render entry point ──────────────────────────────────────────────

async function renderTimeline() {
  const el = $('view-timeline');
  if (!currentParsed) {
    el.innerHTML = `<div class="tl2-empty">Timeline is only available for HLS manifests.</div>`;
    return;
  }
  try {
    if (!cachedTimelineRows) {
      if (currentParsed.isMaster) {
        el.innerHTML = `<div class="tl2-loading">Fetching renditions\u2026</div>`;
        cachedTimelineRows = await buildMasterRows(currentParsed, currentUrl);
      } else {
        cachedTimelineRows = buildMediaRows(currentParsed, currentUrl);
      }
    }
    el.innerHTML = buildTimelineHtml(cachedTimelineRows, timelineZoom);
  } catch (err) {
    el.innerHTML = `<div class="tl2-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}
