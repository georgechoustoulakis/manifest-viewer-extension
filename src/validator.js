'use strict';

// ─── HLS Validator ────────────────────────────────────────────────────────────

function vlFmtKbps(bps) {
  return `${Math.round(bps / 1000)} kb/s`;
}

function vlStreamTag(s, idx) {
  const parts = [`#${idx + 1}`];
  if (s.resolution) parts.push(s.resolution);
  parts.push(vlFmtKbps(s.bandwidth));
  return parts.join(' · ');
}

// ── Master playlist validation ────────────────────────────────────────────────

function validateHlsMaster(parsed, rawContent, contentType) {
  const issues = [];
  const add = (sev, code, title, detail, items = []) =>
    issues.push({ severity: sev, code, title, detail, items });

  const streams = parsed.streams || [];
  const media   = parsed.media   || [];
  const iframes = parsed.iframes || [];

  // Content-Type
  if (contentType && !contentType.includes('mpegurl') && !contentType.includes('m3u')) {
    add('warning', 'HLS-CT',
      'Non-standard Content-Type',
      `HLS playlists should be served as application/vnd.apple.mpegurl or audio/mpegurl. Got: ${contentType}`);
  }

  // ── Per-stream checks ──────────────────────────────────────────────────────

  // BANDWIDTH required (RFC 8216 §4.3.4.2)
  const noBw = streams.filter(s => !s.bandwidth);
  if (noBw.length) {
    add('error', 'HLS-M01',
      'Missing BANDWIDTH on EXT-X-STREAM-INF',
      'BANDWIDTH is a required attribute on every EXT-X-STREAM-INF tag (RFC 8216 §4.3.4.2)',
      noBw.map(s => vlStreamTag(s, streams.indexOf(s))));
  }

  // CODECS required (Apple HLS Authoring Spec §2.1)
  const noCodecs = streams.filter(s => !s.codecs);
  if (noCodecs.length) {
    add('error', 'HLS-M02',
      'Missing CODECS attribute on EXT-X-STREAM-INF',
      'CODECS MUST always be provided so players can select the right decoder without probing segments (Apple HLS Authoring Spec §2.1)',
      noCodecs.map(s => vlStreamTag(s, streams.indexOf(s))));
  }

  // AVERAGE-BANDWIDTH recommended (Apple HLS Authoring Spec §2.1)
  const noAvgBw = streams.filter(s => !s.averageBandwidth);
  if (noAvgBw.length) {
    add('warning', 'HLS-M03',
      'Missing AVERAGE-BANDWIDTH attribute',
      'AVERAGE-BANDWIDTH SHOULD be included; players use it for smarter initial variant selection under constrained bandwidth',
      noAvgBw.map(s => vlStreamTag(s, streams.indexOf(s))));
  }

  // FRAME-RATE recommended (Apple HLS Authoring Spec §2.1)
  const noFr = streams.filter(s => !s.frameRate);
  if (noFr.length) {
    add('warning', 'HLS-M04',
      'Missing FRAME-RATE attribute',
      'FRAME-RATE SHOULD be specified on all video EXT-X-STREAM-INF tags (Apple HLS Authoring Spec §2.1)',
      noFr.map(s => vlStreamTag(s, streams.indexOf(s))));
  }

  // RESOLUTION recommended (Apple HLS Authoring Spec §2.1)
  const noRes = streams.filter(s => !s.resolution);
  if (noRes.length) {
    add('warning', 'HLS-M05',
      'Missing RESOLUTION attribute',
      'RESOLUTION SHOULD be specified for all video variants (Apple HLS Authoring Spec §2.1)',
      noRes.map(s => vlStreamTag(s, streams.indexOf(s))));
  }

  // ── Structural checks ──────────────────────────────────────────────────────

  // I-frame playlists required (Apple HLS Authoring Spec §2.4)
  if (iframes.length === 0) {
    add('error', 'HLS-M06',
      'No EXT-X-I-FRAME-STREAM-INF playlists',
      'I-frame playlists MUST be provided to enable trick-play (scrubbing and scanning UI) per Apple HLS Authoring Spec §2.4');
  }

  // Low-bandwidth variant ≤ 192 kb/s (Apple HLS Authoring Spec §3.1)
  if (streams.length > 0) {
    const minBw = Math.min(...streams.map(s => s.bandwidth));
    if (minBw > 192_000) {
      add('error', 'HLS-M07',
        'No variant ≤ 192 kb/s for cellular delivery',
        'Multivariant playlists MUST contain a variant with peak BANDWIDTH ≤ 192 kb/s for iOS cellular delivery (Apple HLS Authoring Spec §3.1)',
        [`Lowest variant: ${vlFmtKbps(minBw)}`]);
    }
  }

  // EXT-X-INDEPENDENT-SEGMENTS (Apple HLS Authoring Spec §2.3)
  if (!rawContent.includes('#EXT-X-INDEPENDENT-SEGMENTS')) {
    add('warning', 'HLS-M08',
      'EXT-X-INDEPENDENT-SEGMENTS absent from multivariant playlist',
      'When absent here, EXT-X-INDEPENDENT-SEGMENTS MUST be present in every individual video media playlist (RFC 8216 §4.3.5.1)');
  }

  // No separate audio renditions (Apple HLS Authoring Spec §2.5)
  const audioGroupIds = new Set(media.filter(m => m.type === 'AUDIO').map(m => m.groupId));
  if (audioGroupIds.size === 0) {
    add('warning', 'HLS-M09',
      'No EXT-X-MEDIA TYPE=AUDIO renditions',
      'Audio SHOULD be delivered as separate renditions rather than muxed into video segments; enables language switching and codec flexibility (Apple HLS Authoring Spec §2.5)');
  }

  // No subtitles / captions
  const hasCaptions = media.some(m => m.type === 'CLOSED-CAPTIONS' || m.type === 'SUBTITLES');
  if (!hasCaptions) {
    add('warning', 'HLS-M10',
      'No subtitles or closed captions',
      'Captions SHOULD be provided for accessibility via EXT-X-MEDIA TYPE=SUBTITLES or CLOSED-CAPTIONS');
  }

  // AUDIO group reference consistency
  const audioRefRe = /^#EXT-X-STREAM-INF:[^\n]*\bAUDIO="([^"]+)"/gm;
  let m;
  while ((m = audioRefRe.exec(rawContent)) !== null) {
    if (!audioGroupIds.has(m[1])) {
      add('error', 'HLS-M11',
        `EXT-X-STREAM-INF references undefined AUDIO group "${m[1]}"`,
        `No EXT-X-MEDIA TYPE=AUDIO with GROUP-ID="${m[1]}" exists in this playlist`);
    }
  }

  // CLOSED-CAPTIONS group reference consistency
  const ccGroupIds = new Set(media.filter(m => m.type === 'CLOSED-CAPTIONS').map(m => m.groupId));
  const ccRefRe = /^#EXT-X-STREAM-INF:[^\n]*\bCLOSED-CAPTIONS="([^"]+)"/gm;
  while ((m = ccRefRe.exec(rawContent)) !== null) {
    if (m[1] !== 'NONE' && !ccGroupIds.has(m[1])) {
      add('error', 'HLS-M12',
        `EXT-X-STREAM-INF references undefined CLOSED-CAPTIONS group "${m[1]}"`,
        `No EXT-X-MEDIA TYPE=CLOSED-CAPTIONS with GROUP-ID="${m[1]}" exists in this playlist`);
    }
  }

  // PROGRAM-ID deprecated (RFC 8216 removed it)
  if (/PROGRAM-ID\s*=/.test(rawContent)) {
    add('warning', 'HLS-M13',
      'Deprecated PROGRAM-ID attribute',
      'PROGRAM-ID was removed from the HLS specification in RFC 8216 and is no longer valid on EXT-X-STREAM-INF');
  }

  // Bandwidth ordering (convention)
  const bws = streams.map(s => s.bandwidth);
  if (streams.length > 1 && !bws.every((b, i) => i === 0 || b >= bws[i - 1])) {
    add('info', 'HLS-M14',
      'Variants not in ascending BANDWIDTH order',
      'By convention, EXT-X-STREAM-INF tags should be listed in ascending order of BANDWIDTH');
  }

  // Missing EXT-X-VERSION
  if (parsed.version === null) {
    add('info', 'HLS-M15',
      'No EXT-X-VERSION tag',
      'EXT-X-VERSION should be declared; its absence implies version 1');
  }

  return issues;
}

// ── Media playlist validation ─────────────────────────────────────────────────

function validateHlsMedia(parsed, rawContent, contentType, label) {
  const issues = [];
  const add = (sev, code, title, detail, items = []) =>
    issues.push({ severity: sev, code, title, detail, items });

  const segs    = parsed.segments || [];
  const version = parsed.version  ?? 1;

  // Content-Type (only meaningful for a directly-loaded media playlist)
  if (!label && contentType && !contentType.includes('mpegurl') && !contentType.includes('m3u')) {
    add('warning', 'HLS-CT',
      'Non-standard Content-Type',
      `HLS playlists should be served as application/vnd.apple.mpegurl or audio/mpegurl. Got: ${contentType}`);
  }

  // EXT-X-TARGETDURATION required (RFC 8216 §4.3.3.1)
  if (parsed.targetDuration == null) {
    add('error', 'HLS-P01',
      'Missing EXT-X-TARGETDURATION',
      'EXT-X-TARGETDURATION is REQUIRED in every media playlist (RFC 8216 §4.3.3.1)');
  } else {
    // No segment may exceed TARGETDURATION (rounded to nearest integer)
    const overTarget = segs.filter(s => Math.round(s.duration) > parsed.targetDuration);
    if (overTarget.length) {
      add('error', 'HLS-P02',
        `Segment duration exceeds EXT-X-TARGETDURATION (${parsed.targetDuration}s)`,
        'The EXTINF duration of each segment, rounded to the nearest integer, MUST NOT exceed EXT-X-TARGETDURATION (RFC 8216 §4.3.3.1)',
        overTarget.slice(0, 8).map(s => `#${s.seq}: ${s.duration.toFixed(3)}s`));
    }

    // Apple recommendation: 6-second target
    if (parsed.targetDuration > 6) {
      add('warning', 'HLS-P03',
        `EXT-X-TARGETDURATION is ${parsed.targetDuration}s (Apple recommends 6s)`,
        'Apple recommends a 6-second target segment duration for optimal ABR switching and startup time');
    }

    // Short non-final segments (encoding issue indicator)
    if (segs.length > 1) {
      const shortSegs = segs
        .slice(0, -1)
        .filter(s => !s.discontinuity && s.duration < parsed.targetDuration * 0.5);
      if (shortSegs.length > 1) {
        add('warning', 'HLS-P04',
          `${shortSegs.length} non-final segment${shortSegs.length !== 1 ? 's are' : ' is'} less than half the target duration`,
          'Short mid-stream segments (excluding discontinuity boundaries) may indicate an encoding or segmentation issue',
          shortSegs.slice(0, 6).map(s => `#${s.seq}: ${s.duration.toFixed(3)}s`));
      }
    }
  }

  // EXT-X-ENDLIST + EXT-X-PLAYLIST-TYPE consistency
  if (parsed.hasEndList && parsed.playlistType === null) {
    add('error', 'HLS-P05',
      'EXT-X-ENDLIST present but EXT-X-PLAYLIST-TYPE absent',
      'A completed VOD playlist MUST also declare EXT-X-PLAYLIST-TYPE:VOD');
  }

  // EXT-X-INDEPENDENT-SEGMENTS (RFC 8216 §4.3.5.1)
  if (!rawContent.includes('#EXT-X-INDEPENDENT-SEGMENTS')) {
    add('warning', 'HLS-P06',
      'Missing EXT-X-INDEPENDENT-SEGMENTS',
      'Every segment SHOULD be independently decodable. This tag MUST be present in each media playlist when absent from the multivariant playlist (RFC 8216 §4.3.5.1)');
  }

  // Version compatibility: floating-point EXTINF (RFC 8216 §7 — version 3+)
  const usesFloatDuration = segs.some(s => s.duration !== Math.trunc(s.duration));
  if (usesFloatDuration && version < 3) {
    add('error', 'HLS-P07',
      'Decimal-precision EXTINF durations require EXT-X-VERSION ≥ 3',
      `Playlist uses floating-point EXTINF values but declares version ${version} (RFC 8216 §7)`);
  }

  // Version compatibility: EXT-X-BYTERANGE (version 4+)
  if (segs.some(s => s.byterange) && version < 4) {
    add('error', 'HLS-P08',
      'EXT-X-BYTERANGE requires EXT-X-VERSION ≥ 4',
      `Playlist uses byte ranges but declares version ${version} (RFC 8216 §7)`);
  }

  // Version compatibility: EXT-X-MAP (version 5+, or 6+ outside EXT-X-I-FRAMES-ONLY)
  if (rawContent.includes('#EXT-X-MAP')) {
    const minMapVer = rawContent.includes('#EXT-X-I-FRAMES-ONLY') ? 5 : 6;
    if (version < minMapVer) {
      add('error', 'HLS-P09',
        `EXT-X-MAP requires EXT-X-VERSION ≥ ${minMapVer} in this context`,
        `Playlist uses EXT-X-MAP but declares version ${version} (RFC 8216 §7)`);
    }
  }

  // Version compatibility: EXT-X-KEY IV (version 2+)
  if (/^#EXT-X-KEY:[^\n]*\bIV=/m.test(rawContent) && version < 2) {
    add('error', 'HLS-P10',
      'EXT-X-KEY IV attribute requires EXT-X-VERSION ≥ 2',
      `Playlist declares an AES-128 IV but uses version ${version} (RFC 8216 §7)`);
  }

  // Live: EXT-X-PROGRAM-DATE-TIME recommended (RFC 8216 §4.3.2.6)
  const isLive = !parsed.hasEndList && parsed.playlistType !== 'VOD';
  if (isLive && segs.length > 0 && !segs.some(s => s.programDateTime)) {
    add('warning', 'HLS-P11',
      'Live playlist missing EXT-X-PROGRAM-DATE-TIME',
      'EXT-X-PROGRAM-DATE-TIME SHOULD be present in live playlists to enable synchronized playback and DVR seek by wall-clock time (RFC 8216 §4.3.2.6)');
  }

  // No segments
  if (segs.length === 0) {
    add('warning', 'HLS-P12',
      'Playlist contains no media segments',
      'The media playlist has no EXTINF-tagged segments');
  }

  return issues;
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function buildValidationHtml(masterIssues, mediaResults) {
  const allIssues = [
    ...masterIssues,
    ...mediaResults.flatMap(r => r.issues),
  ];
  const nErr  = allIssues.filter(i => i.severity === 'error').length;
  const nWarn = allIssues.filter(i => i.severity === 'warning').length;
  const nInfo = allIssues.filter(i => i.severity === 'info').length;

  let html = `<div class="vl-view">`;

  // Summary strip
  html += `<div class="vl-summary">`;
  if (nErr === 0 && nWarn === 0) {
    html += `<span class="vl-badge vl-badge--ok">&#10003;&ensp;No errors or warnings</span>`;
  } else {
    if (nErr)  html += `<span class="vl-badge vl-badge--error">&#10006;&ensp;${nErr} error${nErr !== 1 ? 's' : ''}</span>`;
    if (nWarn) html += `<span class="vl-badge vl-badge--warn">&#9888;&ensp;${nWarn} warning${nWarn !== 1 ? 's' : ''}</span>`;
  }
  if (nInfo) html += `<span class="vl-badge vl-badge--info">&#9432;&ensp;${nInfo} info</span>`;
  html += `</div>`;

  // Master / standalone section
  if (masterIssues.length > 0) {
    html += vlSection('Multivariant Playlist', masterIssues);
  }

  // Per-variant sections
  for (const { label, issues } of mediaResults) {
    if (issues.length > 0) html += vlSection(label, issues);
  }

  if (allIssues.length === 0) {
    html += `<div class="vl-pass">&#10003;&ensp;All checks passed.</div>`;
  }

  html += `</div>`;
  return html;
}

function vlSection(title, issues) {
  const errors   = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos    = issues.filter(i => i.severity === 'info');

  let html = `<div class="vl-section">`;
  html += `<div class="vl-section-title">${escapeHtml(title)}</div>`;
  if (errors.length) {
    html += `<div class="vl-group-label vl-group-label--error">Errors &mdash; Must Fix</div>`;
    for (const iss of errors)   html += vlIssue(iss);
  }
  if (warnings.length) {
    html += `<div class="vl-group-label vl-group-label--warn">Warnings &mdash; Should Fix</div>`;
    for (const iss of warnings) html += vlIssue(iss);
  }
  if (infos.length) {
    html += `<div class="vl-group-label vl-group-label--info">Info</div>`;
    for (const iss of infos)    html += vlIssue(iss);
  }
  html += `</div>`;
  return html;
}

function vlIssue(iss) {
  const icon = iss.severity === 'error' ? '&#10006;'
             : iss.severity === 'warning' ? '&#9888;'
             : '&#9432;';
  let html = `<div class="vl-issue vl-issue--${iss.severity}">`;
  html += `<div class="vl-issue-header">`;
  html += `<span class="vl-issue-icon">${icon}</span>`;
  html += `<span class="vl-issue-title">${escapeHtml(iss.title)}</span>`;
  html += `<span class="vl-issue-code">${escapeHtml(iss.code)}</span>`;
  html += `</div>`;
  if (iss.detail) {
    html += `<div class="vl-issue-detail">${escapeHtml(iss.detail)}</div>`;
  }
  if (iss.items?.length) {
    html += `<ul class="vl-issue-items">`;
    for (const item of iss.items) html += `<li>${escapeHtml(item)}</li>`;
    html += `</ul>`;
  }
  html += `</div>`;
  return html;
}

// ── Entry point called from app.js ────────────────────────────────────────────

async function renderValidation() {
  const el = $('view-validate');

  if (!currentParsed) {
    el.innerHTML = `<div class="vl-empty">Load a manifest to validate.</div>`;
    return;
  }
  if (currentParsed.isDash) {
    el.innerHTML = `<div class="vl-empty">DASH validation is not yet supported.</div>`;
    return;
  }

  el.innerHTML = `<div class="vl-loading">Validating&#8230;</div>`;

  const masterHasIndepSeg = currentRawContent.includes('#EXT-X-INDEPENDENT-SEGMENTS');
  let masterIssues   = [];
  const mediaResults = [];

  try {
    if (currentParsed.isMaster) {
      masterIssues = validateHlsMaster(currentParsed, currentRawContent, currentContentType);

      for (let i = 0; i < currentParsed.streams.length; i++) {
        const s     = currentParsed.streams[i];
        const label = vlStreamTag(s, i);
        try {
          const { content, contentType } = await fetchManifest(s.uri);
          const varParsed = parseHls(content, s.uri);
          let varIssues   = validateHlsMedia(varParsed, content, contentType || '', label);

          // Suppress HLS-P06 (missing EXT-X-INDEPENDENT-SEGMENTS in variant) if master carries it
          if (masterHasIndepSeg) {
            varIssues = varIssues.filter(iss => iss.code !== 'HLS-P06');
          }

          mediaResults.push({ label, issues: varIssues });
        } catch (err) {
          mediaResults.push({
            label,
            issues: [{
              severity: 'error',
              code: 'HLS-FETCH',
              title: 'Failed to fetch variant playlist',
              detail: err.message,
              items: [s.uri],
            }],
          });
        }
      }
    } else {
      // Standalone media playlist
      masterIssues = validateHlsMedia(currentParsed, currentRawContent, currentContentType);
    }
  } catch (err) {
    el.innerHTML = `<div class="vl-empty">Validation error: ${escapeHtml(err.message)}</div>`;
    return;
  }

  el.innerHTML = buildValidationHtml(masterIssues, mediaResults);
}
