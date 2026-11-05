import Redis from 'ioredis';

// Reuse Redis connection across warm serverless invocations
let ioRedisClient = null;

function getRedisAdapter() {
  const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
  const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  // 1. Standard Redis TCP/TLS URL (Vercel Redis / Redis Cloud / Upstash TCP)
  if (redisUrl) {
    if (!ioRedisClient) {
      ioRedisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        connectTimeout: 8000,
        tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
      });
    }
    return {
      async get(key) {
        return await ioRedisClient.get(key);
      },
      async mget(keys) {
        if (!keys || keys.length === 0) return [];
        return await ioRedisClient.mget(keys);
      },
      async set(key, value) {
        return await ioRedisClient.set(key, value);
      },
      async del(keys) {
        if (!keys || keys.length === 0) return 0;
        const arr = Array.isArray(keys) ? keys : [keys];
        return await ioRedisClient.del(...arr);
      }
    };
  }

  // 2. Upstash / Vercel KV REST API fallback
  if (restUrl && restToken) {
    const execRest = async (commandArray) => {
      const res = await fetch(restUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${restToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(commandArray)
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Redis REST Error (${res.status}): ${text}`);
      }
      const data = await res.json();
      return data.result;
    };

    return {
      async get(key) {
        return await execRest(['GET', key]);
      },
      async mget(keys) {
        if (!keys || keys.length === 0) return [];
        return await execRest(['MGET', ...keys]);
      },
      async set(key, value) {
        return await execRest(['SET', key, value]);
      },
      async del(keys) {
        if (!keys || keys.length === 0) return 0;
        const arr = Array.isArray(keys) ? keys : [keys];
        return await execRest(['DEL', ...arr]);
      }
    };
  }

  throw new Error(
    'Redis nincs konfigurálva! Kérlek ellenőrizd a Vercel-en a REDIS_URL vagy KV_REST_API_URL környezeti változókat.'
  );
}

const META_KEY = 'math_note:meta';
const pageKey = (idx) => `math_note:page:${idx}`;
const pdfChunkKey = (idx) => `math_note:pdf_chunk:${idx}`;

async function clearPreviousNote(redis) {
  let maxPages = 30;
  let maxChunks = 20;

  try {
    const rawMeta = await redis.get(META_KEY);
    if (rawMeta) {
      const oldMeta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
      if (oldMeta.pageCount && oldMeta.pageCount > maxPages) maxPages = oldMeta.pageCount;
      if (oldMeta.pdfChunkCount && oldMeta.pdfChunkCount > maxChunks) maxChunks = oldMeta.pdfChunkCount;
    }
  } catch (_) {
    // Ignore parse error and clean up standard range
  }

  const keysToDelete = [META_KEY];
  for (let i = 0; i < maxPages; i++) keysToDelete.push(pageKey(i));
  for (let i = 0; i < maxChunks; i++) keysToDelete.push(pdfChunkKey(i));

  await redis.del(keysToDelete);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let redis;
  try {
    redis = getRedisAdapter();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    // =========================================================================
    // GET: Retrieve current note, direct page image, or original PDF chunks
    // =========================================================================
    if (req.method === 'GET') {
      const { page, downloadPdf } = req.query || {};

      // 1. Direct binary image endpoint for OneNote HTML <img src="..."> paste
      if (page !== undefined) {
        const idx = parseInt(page, 10);
        if (isNaN(idx) || idx < 0) {
          return res.status(400).send('Invalid page index');
        }
        const dataUrl = await redis.get(pageKey(idx));
        if (!dataUrl) {
          return res.status(404).send('Page not found');
        }
        const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (!match) {
          return res.status(500).send('Invalid image format');
        }
        const mimeType = match[1];
        const buffer = Buffer.from(match[2], 'base64');
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.status(200).send(buffer);
      }

      const rawMeta = await redis.get(META_KEY);
      if (!rawMeta) {
        return res.status(200).json({ note: null });
      }

      const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;

      // 2. If client requests the original PDF data URL for download
      if (downloadPdf === '1') {
        const chunkCount = meta.pdfChunkCount || 0;
        if (chunkCount === 0) {
          return res.status(404).json({ error: 'Original PDF not stored' });
        }
        const keys = [];
        for (let i = 0; i < chunkCount; i++) keys.push(pdfChunkKey(i));
        const chunks = await redis.mget(keys);
        const fullPdfDataUrl = (chunks || []).join('');
        return res.status(200).json({ pdfDataUrl: fullPdfDataUrl, fileName: meta.fileName });
      }

      // 3. Default GET: Return active note metadata + all rendered page images
      const pageCount = meta.pageCount || 0;
      let pages = [];
      if (pageCount > 0) {
        const keys = [];
        for (let i = 0; i < pageCount; i++) keys.push(pageKey(i));
        const fetchedPages = await redis.mget(keys);
        pages = (fetchedPages || []).filter(Boolean);
      }

      return res.status(200).json({
        note: {
          ...meta,
          pages
        }
      });
    }

    // =========================================================================
    // POST: Upload a new note (automatically deletes the previous one!)
    // =========================================================================
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const { action } = body;

      // Single-shot save (when payload is compact)
      if (action === 'save_all') {
        const { meta, pages = [], pdfChunks = [] } = body;
        await clearPreviousNote(redis);

        for (let i = 0; i < pages.length; i++) {
          await redis.set(pageKey(i), pages[i]);
        }
        for (let i = 0; i < pdfChunks.length; i++) {
          await redis.set(pdfChunkKey(i), pdfChunks[i]);
        }

        const finalMeta = {
          ...meta,
          pageCount: pages.length,
          pdfChunkCount: pdfChunks.length,
          createdAt: Date.now()
        };
        await redis.set(META_KEY, JSON.stringify(finalMeta));
        return res.status(200).json({ ok: true, note: finalMeta });
      }

      // Multi-step chunked upload (for larger PDFs so Vercel 4.5MB limit is never hit)
      if (action === 'init') {
        // Step 1: Delete previous note from Redis immediately
        await clearPreviousNote(redis);
        return res.status(200).json({ ok: true });
      }

      if (action === 'page') {
        const { index, dataUrl } = body;
        await redis.set(pageKey(index), dataUrl);
        return res.status(200).json({ ok: true });
      }

      if (action === 'pdf_chunk') {
        const { index, data } = body;
        await redis.set(pdfChunkKey(index), data);
        return res.status(200).json({ ok: true });
      }

      if (action === 'finalize') {
        const { meta } = body;
        const finalMeta = {
          ...meta,
          createdAt: Date.now()
        };
        await redis.set(META_KEY, JSON.stringify(finalMeta));
        return res.status(200).json({ ok: true, note: finalMeta });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    // =========================================================================
    // DELETE: Delete current note from Redis
    // =========================================================================
    if (req.method === 'DELETE') {
      await clearPreviousNote(redis);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Redis API error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}
