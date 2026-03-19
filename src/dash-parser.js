'use strict';

// ─── DASH/MPD parser for Timeline view ────────────────────────────────────────

function parseDashDuration(str) {
  if (!str) return null;
  const m = /^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(str);
  if (!m) return null;
  return (parseFloat(m[1] || 0) * 365.25 * 86400 +
          parseFloat(m[2] || 0) * 30.44  * 86400 +
          parseFloat(m[3] || 0) * 86400 +
          parseFloat(m[4] || 0) * 3600 +
          parseFloat(m[5] || 0) * 60 +
          parseFloat(m[6] || 0));
}

// Resolve $Identifier$ and $Identifier%0Nd$ substitutions in DASH template URLs.
function dashSubstitute(template, repId, bandwidth, number, time) {
  return template.replace(/\$(\w+?)(?:%0(\d+)d)?\$/g, (match, id, width) => {
    let val;
    switch (id) {
      case 'RepresentationID': val = repId;     break;
      case 'Bandwidth':        val = bandwidth; break;
      case 'Number':           val = number;    break;
      case 'Time':             val = time;      break;
      case '$':                return '$';
      default:                 return match;
    }
    return width ? String(val).padStart(parseInt(width), '0') : String(val);
  });
}

// Inherited attribute: first non-null value walking rep → as → period.
function inherited(els, attr) {
  for (const el of els) {
    const v = el && el.getAttribute(attr);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

// First matching child element walking rep → as → period.
function inheritedEl(els, tag) {
  for (const el of els) {
    if (!el) continue;
    const child = el.querySelector(`:scope > ${tag}`);
    if (child) return child;
  }
  return null;
}

function resolveSegmentTemplate(tmpl, repId, bandwidth, periodStartSec, periodDurSec) {
  const timescale = parseInt(tmpl.getAttribute('timescale')) || 1;
  const media     = tmpl.getAttribute('media') || '';
  const startNum  = parseInt(tmpl.getAttribute('startNumber') ?? '1');
  const pto       = parseInt(tmpl.getAttribute('presentationTimeOffset') || '0');

  const stl = tmpl.querySelector('SegmentTimeline');

  if (stl) {
    // ── SegmentTimeline mode ──────────────────────────────────────────────────
    const segs = [];
    let t = 0, num = startNum;
    for (const s of stl.querySelectorAll('S')) {
      const st = s.getAttribute('t');
      if (st !== null) t = parseInt(st);
      const d = parseInt(s.getAttribute('d'));
      const r = parseInt(s.getAttribute('r') || '0');
      for (let i = 0; i <= r; i++) {
        const startSec = periodStartSec + (t - pto) / timescale;
        const durSec   = d / timescale;
        const uri      = media ? dashSubstitute(media, repId, bandwidth, num, t) : '';
        segs.push({ seq: num, start: startSec, duration: durSec, uri });
        t += d;
        num++;
      }
    }
    return segs;
  }

  // ── Fixed-duration mode ($Number$ or $Time$) ─────────────────────────────
  const dur = parseInt(tmpl.getAttribute('duration'));
  if (!dur || periodDurSec == null) return [];
  const total = Math.ceil(periodDurSec * timescale / dur);
  const segs  = [];
  for (let i = 0; i < total; i++) {
    const num      = startNum + i;
    const t        = pto + i * dur;
    const startSec = periodStartSec + (i * dur) / timescale;
    const durSec   = Math.min(dur / timescale, periodDurSec - i * dur / timescale);
    const uri      = media ? dashSubstitute(media, repId, bandwidth, num, t) : '';
    segs.push({ seq: num, start: startSec, duration: durSec, uri });
  }
  return segs;
}

function resolveSegmentList(segList, periodStartSec) {
  const timescale = parseInt(segList.getAttribute('timescale')) || 1;
  const dur       = parseInt(segList.getAttribute('duration') || '0');
  const pto       = parseInt(segList.getAttribute('presentationTimeOffset') || '0');

  // SegmentList may embed a SegmentTimeline to carry explicit t/d/r timing.
  const stl = segList.querySelector('SegmentTimeline');
  const urls = [...segList.querySelectorAll('SegmentURL')];
  const segs = [];
  let idx = 0;

  if (stl) {
    let t = 0;
    for (const s of stl.querySelectorAll('S')) {
      const st = s.getAttribute('t');
      if (st !== null) t = parseInt(st);
      const d = parseInt(s.getAttribute('d'));
      const r = parseInt(s.getAttribute('r') || '0');
      for (let i = 0; i <= r; i++) {
        const urlEl    = urls[idx];
        const uri      = urlEl?.getAttribute('media')      || '';
        const byterange = urlEl?.getAttribute('mediaRange') || null;
        segs.push({ seq: idx, start: periodStartSec + (t - pto) / timescale, duration: d / timescale, uri, byterange });
        t += d;
        idx++;
      }
    }
  } else {
    for (const urlEl of urls) {
      const uri       = urlEl.getAttribute('media')      || '';
      const byterange = urlEl.getAttribute('mediaRange') || null;
      segs.push({ seq: idx, start: periodStartSec + (idx * dur - pto) / timescale, duration: dur / timescale, uri, byterange });
      idx++;
    }
  }
  return segs;
}

function parseDashMpd(content, baseUrl) {
  const doc = new DOMParser().parseFromString(content, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.nodeName === 'parsererror' || !mpd.nodeName.toLowerCase().includes('mpd')) return null;

  const totalDur = parseDashDuration(mpd.getAttribute('mediaPresentationDuration'));
  const result   = {
    isDash:                    true,
    duration:                  totalDur,
    type:                      mpd.getAttribute('type')                      || 'static',
    availabilityStartTime:     mpd.getAttribute('availabilityStartTime')     || null,
    availabilityEndTime:       mpd.getAttribute('availabilityEndTime')       || null,
    publishTime:               mpd.getAttribute('publishTime')               || null,
    minimumUpdatePeriod:       mpd.getAttribute('minimumUpdatePeriod')       || null,
    timeShiftBufferDepth:      mpd.getAttribute('timeShiftBufferDepth')      || null,
    suggestedPresentationDelay:mpd.getAttribute('suggestedPresentationDelay')|| null,
    periods:                   [],
  };

  let implicitStart = 0;

  for (const period of mpd.querySelectorAll(':scope > Period')) {
    const pStart = parseDashDuration(period.getAttribute('start')) ?? implicitStart;
    const pDur   = parseDashDuration(period.getAttribute('duration'))
                ?? (totalDur != null ? totalDur - pStart : null);
    const pId    = period.getAttribute('id') || null;

    const adaptationSets = [];

    for (const as of period.querySelectorAll(':scope > AdaptationSet')) {
      // mimeType / contentType may live on the AdaptationSet or on individual
      // Representations — check both, falling back to the first Representation.
      const repMime     = as.querySelector(':scope > Representation')?.getAttribute('mimeType') || '';
      const mimeType    = as.getAttribute('mimeType')    || repMime;
      const contentType = as.getAttribute('contentType') || '';
      const lang        = as.getAttribute('lang')        || '';
      const asLabel     = as.querySelector('Label')?.textContent.trim()
                       || as.getAttribute('label') || '';

      const isVideo = mimeType.includes('video') || contentType === 'video';
      const isAudio = mimeType.includes('audio') || contentType === 'audio';
      const isText  = mimeType.includes('text')  || contentType === 'text'
                   || mimeType.includes('vtt')   || mimeType.includes('ttml');

      const reps = [];

      for (const rep of as.querySelectorAll(':scope > Representation')) {
        const repId     = rep.getAttribute('id') || '';
        const bandwidth = parseInt(rep.getAttribute('bandwidth')) || 0;
        const width     = parseInt(inherited([rep, as], 'width')     || '0');
        const height    = parseInt(inherited([rep, as], 'height')    || '0');
        const codecs    = inherited([rep, as], 'codecs')    || '';
        const frameRate = inherited([rep, as], 'frameRate') || '';

        // Precedence: Representation > AdaptationSet > Period
        const tmpl = inheritedEl([rep, as, period], 'SegmentTemplate');
        const list = inheritedEl([rep, as],          'SegmentList');

        let segs = [];
        if (tmpl) {
          segs = resolveSegmentTemplate(tmpl, repId, bandwidth, pStart, pDur);
        } else if (list) {
          segs = resolveSegmentList(list, pStart);
        }

        if (segs.length) {
          reps.push({ id: repId, bandwidth, width, height, codecs, frameRate, segs });
        }
      }

      if (reps.length) {
        adaptationSets.push({ mimeType, isVideo, isAudio, isText, lang, label: asLabel, reps });
      }
    }

    result.periods.push({ id: pId, start: pStart, duration: pDur, adaptationSets });
    implicitStart = pStart + (pDur ?? 0);
  }

  return result;
}
