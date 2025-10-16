'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const lyricsFinder = require('lyrics-finder');
const Genius = require('genius-lyrics');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// unified log stream (console + file)
const logFilePath = path.join(__dirname, '..', 'lyric-finder.log');
const logFile = fs.createWriteStream(logFilePath, { flags: 'a' });
function logLine() {
  const line = Array.from(arguments).map((a) => {
    try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
  const msg = `${new Date().toISOString()} ${line}`;
  process.stdout.write(msg + '\n');
  try { logFile.write(msg + '\n'); } catch (_) {}
}

// Clean up provider-specific noise from lyrics
function sanitizeLyrics(raw) {
  if (!raw) return raw;
  let text = String(raw).replace(/\r/g, '');
  // Remove concatenated header like "21 ContributorsHow Great Is Our God Lyrics"
  text = text.replace(/^\s*\d+\s*Contributors.*?Lyrics\s*/i, '');
  // Remove generic leading headers ending with "Lyrics"
  text = text.replace(/^\s*.*?Lyrics\s*/i, '');
  // Remove "Read More" blocks
  text = text.replace(/\bRead More\b[\s\S]*?\n/gi, '');
  // Remove teaser sections
  text = text.replace(/You might also like[\s\S]*?\n/gi, '');
  // Remove trailing "Embed" footers
  text = text.replace(/\n?\s*\d*\s*Embed\s*$/i, '');
  // If there's a section header like [Verse], [Chorus], [Intro], trim everything before the first one
  const verse1Re = /^\[\s*verse\s*1\b[^\]]*\]/im; // e.g., [Verse 1] or [Verse 1:]
  const anyVerseRe = /^\[\s*verse\b[^\]]*\]/im; // any verse header
  const anyHeaderRe = /^\[(?:verse|chorus|intro|bridge|pre-chorus|prechorus|refrain|outro)[^\]]*\]/im;
  const verse1Match = text.match(verse1Re);
  const anyVerseMatch = text.match(anyVerseRe);
  const anyMatch = text.match(anyHeaderRe);
  const cutIndex = (verse1Match?.index ?? -1) >= 0 ? verse1Match.index : (anyVerseMatch?.index ?? -1) >= 0 ? anyVerseMatch.index : (anyMatch?.index ?? -1);
  if (cutIndex > 0) {
    text = text.slice(cutIndex).trimStart();
  }
  // Collapse 3+ newlines
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// View engine and static assets
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', { stream: { write: (msg) => { process.stdout.write(msg); try { logFile.write(msg); } catch (_) {} } } }));
// Additional request logger to ensure visibility on all consoles
app.use((req, res, next) => {
  const startHr = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - startHr) / 1_000_000;
    logLine(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durMs.toFixed(1)} ms)`);
  });
  next();
});

// Routes
// Serve root-level brand assets if not in /public
app.get(['/Logo-NoBg.png','/Logo.png','/favicon.png'], (req, res, next) => {
  try {
    return res.sendFile(path.join(__dirname, '..', req.path.replace(/^\//, '')));
  } catch (_) {
    return next();
  }
});

app.get('/', (req, res) => {
  res.render('index', { lyrics: null, error: null, query: { song: '' } });
});

app.get('/about', (req, res) => {
  res.render('about');
});

// Lyrics fetch endpoint (POST from form)
app.post('/lyrics', async (req, res) => {
  const songQuery = (req.body?.song || '').trim();
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  logLine(`[${requestId}] incoming query:`, songQuery);
  if (!songQuery) {
    return res.render('index', { lyrics: null, error: 'Please enter a song name.', query: { song: '' } });
  }

  try {
    // helper to parse artist/title from freeform query
    const parseQuery = (q) => {
      const normalized = q.replace(/\s+/g, ' ').trim();
      // patterns: "artist - title", "title - artist", "title by artist"
      const byMatch = normalized.match(/^(.+?)\s+by\s+(.+)$/i);
      if (byMatch) return { title: byMatch[1].trim(), artist: byMatch[2].trim() };
      const dashParts = normalized.split(' - ');
      if (dashParts.length === 2) {
        // try both orientations
        return {
          title: dashParts[1].trim(),
          artist: dashParts[0].trim(),
          alt: { title: dashParts[0].trim(), artist: dashParts[1].trim() }
        };
      }
      return { title: normalized, artist: null };
    };

    const parsed = parseQuery(songQuery);
    logLine(`[${requestId}] parsed query:`, parsed);

    const start = Date.now();
    let lyrics = null;
    let provider = null;
    // Attempt 1: lyrics-finder with parsed artist/title
    try {
      if (parsed.artist) {
        lyrics = await lyricsFinder(parsed.artist, parsed.title);
        provider = lyrics ? 'lyrics-finder(parsed)' : null;
      }
      if (!lyrics && parsed?.alt) {
        lyrics = await lyricsFinder(parsed.alt.artist, parsed.alt.title);
        provider = lyrics ? 'lyrics-finder(alt)' : null;
      }
      if (!lyrics) {
        lyrics = await lyricsFinder(null, songQuery); // freeform
        provider = lyrics ? 'lyrics-finder(freeform)' : null;
      }
      logLine(`[${requestId}] lyrics-finder result:`, lyrics ? `found (${lyrics.length} chars) via ${provider}` : 'none');
    } catch (e1) {
      logLine(`[${requestId}] lyrics-finder error:`, e1?.message || e1);
    }

    // Fallback to Genius if first provider fails
    if (!lyrics) {
      try {
        const genius = new Genius.Client();
        const results = await genius.songs.search(songQuery);
        logLine(`[${requestId}] genius search results:`, results?.length || 0);
        // Log top 5 candidates
        results?.slice(0,5).forEach((r, i) => {
          logLine(`[${requestId}]   [${i}] ${r.title} — ${r.artist?.name || 'Unknown'} (${r.id})`);
        });
        if (results && results.length > 0) {
          // naive heuristic: prefer results whose title contains the parsed title words
          const needle = (parsed.title || songQuery).toLowerCase();
          const ranked = results.map(r => ({
            item: r,
            score: (r.title || '').toLowerCase().includes(needle) ? 2 : 0 + (r.artist?.name && parsed.artist && r.artist.name.toLowerCase().includes(parsed.artist.toLowerCase()) ? 1 : 0)
          })).sort((a,b)=>b.score-a.score);
          const chosen = (ranked[0] || { item: results[0] }).item;
          logLine(`[${requestId}] genius chosen: ${chosen.title} — ${chosen.artist?.name}`);
          lyrics = await chosen.lyrics();
          provider = lyrics ? 'genius' : null;
          logLine(`[${requestId}] genius lyrics:`, lyrics ? `found (${lyrics.length} chars)` : 'none');
        }
      } catch (_) {
        logLine(`[${requestId}] genius provider error`);
      }
    }

    logLine(`[${requestId}] total lookup time: ${Date.now() - start}ms`);
    if (!lyrics) {
      return res.render('index', { lyrics: null, error: `No lyrics found for "${songQuery}".`, query: { song: songQuery } });
    }
    // If lyrics come from Genius, start at [Verse 1] when present
    let finalLyrics = lyrics;
    if (provider === 'genius') {
      const verse1Regex = /^\[\s*verse\s*1\b[^\]]*\]/im;
      const m = finalLyrics.match(verse1Regex);
      let cutAt = m && m.index !== undefined ? m.index : -1;
      if (cutAt < 0) {
        const lower = finalLyrics.toLowerCase();
        cutAt = lower.indexOf('[verse 1]');
      }
      if (cutAt > 0) {
        logLine('[trim] Starting at [Verse 1] offset', cutAt);
        finalLyrics = finalLyrics.slice(cutAt).trimStart();
      } else {
        logLine('[trim] [Verse 1] not found for provider genius');
      }
    }
    return res.render('index', { lyrics: finalLyrics, error: null, query: { song: songQuery }, provider });
  } catch (err) {
    logLine(`[${requestId}] unhandled error:`, err?.message || err);
    return res.render('index', { lyrics: null, error: 'Something went wrong fetching lyrics. Try again.', query: { song: songQuery } });
  }
});

// Health
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  logLine(`Lyric-Finder listening on http://localhost:${PORT}`);
});

// Keep process attached and log shutdown reasons
process.stdin.resume();
process.on('SIGINT', () => {
  logLine('Received SIGINT (Ctrl+C). Shutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  logLine('Received SIGTERM. Shutting down...');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  logLine('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  logLine('Unhandled Rejection:', reason);
});


