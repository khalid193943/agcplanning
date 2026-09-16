/* =================================================================
   /api/planning  —  stockage serveur du Planning AGC
   Donnees conservees dans Vercel Blob (stockage natif de Vercel).
   Aucun service tiers.

   Variables d'environnement attendues sur Vercel :
     BLOB_READ_WRITE_TOKEN  (ajoutee automatiquement par Vercel Blob)
     AGC_USER               (identifiant, defaut : agc)
     AGC_PASSWORD           (mot de passe, defaut : agc2026)
     BLOB_ACCESS            (optionnel : "private" ou "public")
   ================================================================= */
const { put, head } = require('@vercel/blob');

const PATH  = 'planning-agc/data.json';
const USER  = process.env.AGC_USER     || 'agc';
const PASS  = process.env.AGC_PASSWORD || 'agc2026';
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';

let ACCESS = (process.env.BLOB_ACCESS || 'private').toLowerCase();

/* ---------- Authentification ---------- */
function authOk(req){
  const raw = req.headers['x-agc-auth'];
  if(!raw) return false;
  let txt = '';
  try{ txt = Buffer.from(String(raw), 'base64').toString('utf8'); }catch(e){ return false; }
  const i = txt.indexOf('::');
  if(i < 0) return false;
  return txt.slice(0, i) === USER && txt.slice(i + 2) === PASS;
}

/* ---------- Lecture du document ---------- */
async function readDoc(){
  let meta;
  try{
    meta = await head(PATH);
  }catch(e){
    return { doc: null, etag: null, stamp: '' };   // fichier pas encore cree
  }
  const sep = meta.url.indexOf('?') >= 0 ? '&' : '?';
  const url = meta.url + sep + 'cache=0&_=' + Date.now();
  const headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
  let doc = null;
  try{
    const r = await fetch(url, { headers: headers, cache: 'no-store' });
    if(r.ok) doc = await r.json();
  }catch(e){ /* illisible : traite comme vide */ }
  const stamp = String(meta.etag || '') + '|' + String(meta.uploadedAt || '');
  return { doc: doc, etag: meta.etag || null, stamp: stamp };
}

/* ---------- Ecriture ---------- */
async function writeDoc(doc, etag){
  const body = JSON.stringify(doc);
  const opts = {
    access          : ACCESS,
    allowOverwrite  : true,
    addRandomSuffix : false,
    contentType     : 'application/json',
    cacheControlMaxAge: 0
  };
  if(etag) opts.ifMatch = etag;
  try{
    return await put(PATH, body, opts);
  }catch(e){
    const msg = String((e && e.message) || '');
    // Acces prive indisponible sur ce plan -> bascule en public
    if(ACCESS === 'private' && /access|private|not supported|invalid/i.test(msg)){
      ACCESS = 'public';
      opts.access = 'public';
      return await put(PATH, body, opts);
    }
    throw e;
  }
}

function isConflictError(e){
  const msg  = String((e && e.message) || '');
  const name = String((e && e.name) || '');
  return /precondition|ifmatch|if-match|etag|conflict/i.test(msg + ' ' + name);
}

/* ---------- Point d'entree ---------- */
module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');

  if(!authOk(req)){
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Simple verification des identifiants (ecran de connexion)
  if(req.method === 'GET' && req.query && req.query.check){
    return res.status(200).json({ ok: true, storage: TOKEN ? 'blob' : 'none' });
  }

  if(!TOKEN){
    return res.status(503).json({ ok: false, error: 'storage_not_configured' });
  }

  try{
    /* --- Veille legere : empreinte seule, sans telecharger le fichier --- */
    if(req.method === 'GET' && req.query && req.query.probe){
      try{
        const meta = await head(PATH);
        return res.status(200).json({
          ok: true,
          stamp: String(meta.etag || '') + '|' + String(meta.uploadedAt || '')
        });
      }catch(e){
        return res.status(200).json({ ok: true, stamp: '' });
      }
    }

    /* --- Lecture complete --- */
    if(req.method === 'GET'){
      const cur = await readDoc();
      return res.status(200).json({
        ok   : true,
        data : cur.doc ? cur.doc.state : null,
        rev  : cur.doc ? (cur.doc.rev || 0) : 0,
        stamp: cur.stamp
      });
    }

    /* --- Enregistrement --- */
    if(req.method === 'POST'){
      const body = req.body || {};
      if(!body.state || typeof body.state !== 'object'){
        return res.status(400).json({ ok: false, error: 'bad_payload' });
      }

      const cur = await readDoc();

      // Quelqu'un d'autre a enregistre depuis notre derniere lecture
      if(cur.doc && Number(cur.doc.rev || 0) > Number(body.baseRev || 0)){
        return res.status(409).json({
          ok: false, conflict: true,
          data : cur.doc.state,
          rev  : cur.doc.rev || 0,
          stamp: cur.stamp
        });
      }

      const doc = { state: body.state, rev: Date.now(), savedAt: new Date().toISOString() };

      try{
        await writeDoc(doc, cur.etag);
      }catch(e){
        if(isConflictError(e)){
          const again = await readDoc();
          return res.status(409).json({
            ok: false, conflict: true,
            data : again.doc ? again.doc.state : null,
            rev  : again.doc ? (again.doc.rev || 0) : 0,
            stamp: again.stamp
          });
        }
        throw e;
      }

      let stamp = '';
      try{
        const meta = await head(PATH);
        stamp = String(meta.etag || '') + '|' + String(meta.uploadedAt || '');
      }catch(e){}

      return res.status(200).json({ ok: true, rev: doc.rev, stamp: stamp });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  }catch(e){
    return res.status(500).json({ ok: false, error: 'server_error', detail: String((e && e.message) || e) });
  }
};
