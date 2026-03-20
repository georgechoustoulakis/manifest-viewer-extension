'use strict';

// ─── HLS parser (used by Timeline view) ──────────────────────────────────────

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
    isMaster:       false,
    version:        null,
    targetDuration: null,
    mediaSequence:  0,
    playlistType:   null,
    hasEndList:     false,
    segments:       [],
    streams:        [],
    iframes:        [],
    media:          [],
  };

  let i = 0;
  let pendingDuration  = 0;
  let pendingTitle     = '';
  let pendingDisc      = false;
  let pendingPDT       = null;
  let pendingByterange = null;
  let currentKey       = null;
  let currentMap       = null;

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
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseHlsAttrs(line.slice(11));
      currentMap = a.URI ? { uri: resolveUrl(a.URI, baseUrl), byterange: a.BYTERANGE || null } : null;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      result.isMaster = true;
      const a = parseHlsAttrs(line.slice(18));
      i++;
      // skip any comment lines between the tag and the URI
      while (i < lines.length && lines[i].startsWith('#')) i++;
      if (i < lines.length) {
        result.streams.push({
          bandwidth:        parseInt(a.BANDWIDTH)           || 0,
          averageBandwidth: parseInt(a['AVERAGE-BANDWIDTH']) || 0,
          resolution:       a.RESOLUTION   || '',
          codecs:           a.CODECS       || '',
          frameRate:        a['FRAME-RATE'] || '',
          uri:              resolveUrl(lines[i], baseUrl),
          rawUri:           lines[i],
        });
      }
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      result.isMaster = true;
      const a = parseHlsAttrs(line.slice(26));
      if (a.URI) {
        result.iframes.push({
          bandwidth:        parseInt(a.BANDWIDTH)            || 0,
          averageBandwidth: parseInt(a['AVERAGE-BANDWIDTH']) || 0,
          resolution:       a.RESOLUTION || '',
          codecs:           a.CODECS     || '',
          uri:              resolveUrl(a.URI, baseUrl),
          rawUri:           a.URI,
        });
      }
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      result.isMaster = true;
      const a = parseHlsAttrs(line.slice(13));
      result.media.push({
        type:      a.TYPE        || '',
        groupId:   a['GROUP-ID'] || '',
        language:  a.LANGUAGE   || '',
        name:      a.NAME       || '',
        isDefault: a.DEFAULT   === 'YES',
        isForced:  a.FORCED    === 'YES',
        uri:       a.URI ? resolveUrl(a.URI, baseUrl) : '',
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
        seq:             result.mediaSequence + result.segments.length,
        uri:             resolveUrl(line, baseUrl),
        rawUri:          line,
        duration:        pendingDuration,
        title:           pendingTitle,
        discontinuity:   pendingDisc,
        key:             currentKey,
        map:             currentMap,
        programDateTime: pendingPDT,
        byterange:       pendingByterange,
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
