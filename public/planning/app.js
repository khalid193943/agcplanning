/* =================================================================
   PLANNING AGC — Système de gestion d'emploi du temps
   ================================================================= */

/* ---------- GRILLE HORAIRE (chaque case = 1 heure comptée) ---------- */
const DAYS = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi"];

// Définition des créneaux. type: 'course' = heure de cours comptée,
// 'break' = pause (non comptée), 'lunch' = déjeuner (non comptée)
const PERIODS = [
  {label:"08h00 – 09h00", type:"course"},
  {label:"09h00 – 10h00", type:"course"},
  {label:"10h00 – 10h15", type:"break"},
  {label:"10h15 – 11h00", type:"course"},
  {label:"11h00 – 12h00", type:"course"},
  {label:"12h00 – 12h30", type:"lunch"},
  {label:"12h30 – 13h30", type:"course"},
  {label:"13h30 – 14h30", type:"course"},
  {label:"14h30 – 15h30", type:"course"},
];
// Index des créneaux de cours réels
const COURSE_PERIODS = PERIODS.map((p,i)=>({...p,idx:i})).filter(p=>p.type==="course");

// Le vendredi : matin uniquement (4 cases) -> on ferme l'après-midi
const FRIDAY_CLOSED_FROM = "12h30 – 13h30"; // tout ce qui suit ce label le vendredi est fermé
function isOpen(day, periodIdx){
  const p = PERIODS[periodIdx];
  if(p.type!=="course") return false;
  if(day==="Vendredi"){
    // vendredi : seulement les 4 créneaux du matin
    const closedStart = PERIODS.findIndex(x=>x.label===FRIDAY_CLOSED_FROM);
    if(periodIdx>=closedStart) return false;
  }
  return true;
}
// Liste ordonnée des (day, periodIdx) ouverts = 32 cases
function openSlots(){
  const out=[];
  DAYS.forEach(day=>{
    PERIODS.forEach((p,pi)=>{ if(isOpen(day,pi)) out.push({day,pi}); });
  });
  return out;
}
const TOTAL_HOURS = openSlots().length; // = 32

/* ---------- ÉTAT ---------- */

let state = {
  subjects: [],   // {id,name,color}
  teachers: [],   // {id,name, avail:{day:{periodIdx:true}}}
  classes:  [],   // {id,name, items:[{subjectId,teacherId,hours}]}
  currentClass: null,
  // plan[classId][day][periodIdx] = {subjectId, teacherId} | null
  plan: {}
};

function uid(p){ return (p||'x')+Math.random().toString(36).slice(2,9); }
/* =================================================================
   STOCKAGE EN LIGNE — base de données PostgreSQL
   Aucune donnée n'est conservée dans le navigateur : tout est lu et
   enregistré sur le serveur. Tant qu'une modification n'est pas
   confirmée par le serveur, l'indicateur le signale et l'application
   réessaie automatiquement.
   ================================================================= */
const API = '/api/planning';

let REV = 0;             // révision serveur connue de cet appareil
let DIRTY = false;       // des modifications attendent d'être enregistrées
let WRITING = false;     // une écriture est en cours
let CHANGE_SEQ = 0;      // compteur de modifications
let SAVE_TIMER = null;
let RETRY_TIMER = null;
let RETRY_DELAY = 2000;
let PENDING_CP = null;   // point de restauration à créer au prochain enregistrement
let CONFLICT = null;
let SESSION_LOST = false;
let BOOTED = false;

class ApiError extends Error{
  constructor(status, body){ super('HTTP ' + status); this.status = status; this.body = body; }
}

async function api(method, url, body){
  const opts = { method, headers:{}, cache:'no-store', credentials:'same-origin' };
  if(body !== undefined){ opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try{ r = await fetch(url, opts); }
  catch(e){ throw new ApiError(0, null); }
  let j = null;
  try{ j = await r.json(); }catch(e){}
  if(!r.ok) throw new ApiError(r.status, j);
  return j;
}

/* ---------- Indicateur de synchronisation ---------- */
function setSyncStatus(kind, extra){
  const el = document.getElementById('syncStatus');
  if(!el) return;
  const map = {
    loading : ['loader',       'Chargement…',            'wait'],
    saving  : ['refresh-cw',   'Enregistrement…',        'wait'],
    ok      : ['cloud-check',  'Enregistré en ligne',    'ok'],
    retry   : ['cloud-off',    'Non enregistré — nouvel essai' + (extra ? ' dans ' + extra + ' s' : ''), 'bad'],
    conflict: ['circle-alert', 'Conflit à régler',       'bad'],
    session : ['lock',         'Session expirée',        'bad']
  };
  const [icon, label, cls] = map[kind] || map.ok;
  el.className = 'sync ' + cls;
  el.innerHTML = '<i data-lucide="' + icon + '" class="ic"></i><span>' + label + '</span>';
  refreshIcons();
}

function normalizeState(){
  state.subjects ||= []; state.teachers ||= []; state.classes ||= []; state.plan ||= {};
  state.settings ||= {};
  if(!/^\d{4}-\d{4}$/.test(state.settings.schoolYear||'')) state.settings.schoolYear = defaultSchoolYear();
  // ancienne version : une seule matière par enseignant -> liste de matières
  const knownSubjects = new Set(state.subjects.map(s=>s.id));
  state.teachers.forEach(t=>{
    if(!Array.isArray(t.subjectIds)) t.subjectIds = t.subjectId ? [t.subjectId] : [];
    t.subjectIds = [...new Set(t.subjectIds)].filter(id=>knownSubjects.has(id));
    delete t.subjectId;
  });
  if(state.currentClass && !state.classes.some(c=>c.id===state.currentClass)) state.currentClass = null;
  if(!state.currentClass && state.classes[0]) state.currentClass = state.classes[0].id;
}

function renderAll(){
  renderSubjects(); renderTeachers(); renderClasses(); renderPlanSelect(); renderSchool();
  try{ renderPlan(); }catch(e){}
}

function markCheckpoint(note){ if(!PENDING_CP) PENDING_CP = String(note || 'Point de restauration').slice(0, 150); }

/* ---------- Enregistrement ---------- */
function save(){
  try{ refreshOverview(); }catch(e){}
  CHANGE_SEQ++;
  DIRTY = true;
  if(!BOOTED || CONFLICT || SESSION_LOST) return;
  setSyncStatus('saving');
  clearTimeout(SAVE_TIMER);
  SAVE_TIMER = setTimeout(flush, 800);
}

async function flush(){
  clearTimeout(SAVE_TIMER); SAVE_TIMER = null;
  if(!DIRTY || WRITING || CONFLICT || SESSION_LOST || !BOOTED) return;
  WRITING = true;
  const sent = CHANGE_SEQ;
  const cp = PENDING_CP;
  try{
    const j = await api('PUT', API, { state: state, baseRev: REV, checkpoint: cp });
    REV = j.rev;
    if(PENDING_CP === cp) PENDING_CP = null;
    RETRY_DELAY = 2000;
    if(CHANGE_SEQ === sent){ DIRTY = false; setSyncStatus('ok'); }
  }catch(e){
    if(e.status === 409) showConflict(e.body || {});
    else if(e.status === 401) sessionLost();
    else scheduleRetry();
  }finally{
    WRITING = false;
  }
  if(DIRTY && !CONFLICT && !SESSION_LOST && !RETRY_TIMER) SAVE_TIMER = setTimeout(flush, 300);
}

function scheduleRetry(){
  const secs = Math.round(RETRY_DELAY / 1000);
  setSyncStatus('retry', secs);
  clearTimeout(RETRY_TIMER);
  RETRY_TIMER = setTimeout(()=>{ RETRY_TIMER = null; flush(); }, RETRY_DELAY);
  RETRY_DELAY = Math.min(RETRY_DELAY * 2, 30000);
}

const pause = (ms)=>new Promise(r=>setTimeout(r, ms));

/* Force l'enregistrement et attend la réponse du serveur. */
async function flushNow(){
  clearTimeout(RETRY_TIMER); RETRY_TIMER = null;
  for(let i = 0; i < 6 && (DIRTY || WRITING) && !CONFLICT && !SESSION_LOST; i++){
    while(WRITING) await pause(80);
    if(DIRTY) await flush();
    while(WRITING) await pause(80);
    if(DIRTY && RETRY_TIMER) break;          // serveur injoignable : on n'insiste pas ici
  }
  return !DIRTY;
}

/* ---------- Conflit : deux appareils ont modifié en même temps ---------- */
function showConflict(j){
  CONFLICT = { data: j.data || null, rev: Number(j.rev || 0) };
  setSyncStatus('conflict');
  document.getElementById('conflictBar').style.display = 'flex';
}
function resolveConflict(choice){
  document.getElementById('conflictBar').style.display = 'none';
  const c = CONFLICT; CONFLICT = null;
  if(!c) return;
  if(choice === 'server'){
    if(c.data){ state = c.data; normalizeState(); }
    REV = c.rev; DIRTY = false;
    renderAll(); setSyncStatus('ok');
    toast('Version du serveur rechargée');
  }else{
    REV = c.rev;
    PENDING_CP = null;
    markCheckpoint('Version remplacée depuis un autre appareil');   // rien n'est perdu
    DIRTY = true;
    flush();
  }
}

/* ---------- Session expirée ---------- */
function sessionLost(){
  SESSION_LOST = true;
  setSyncStatus('session');
  document.getElementById('sessionBar').style.display = 'flex';
}

/* ---------- Veille : modifications faites sur un autre appareil ---------- */
async function watchServer(){
  if(!BOOTED || document.hidden || CONFLICT || SESSION_LOST || WRITING) return;
  try{
    const p = await api('GET', API + '?probe=1');
    if(!p || Number(p.rev) === REV) return;
    const j = await api('GET', API);
    if(Number(j.rev) === REV) return;
    if(DIRTY){ showConflict(j); return; }
    if(j.data){
      state = j.data; normalizeState(); REV = Number(j.rev);
      renderAll();
      toast('Planning mis à jour depuis un autre appareil');
    }
  }catch(e){
    if(e.status === 401) sessionLost();
  }
}

const byId = (arr,id)=>arr.find(x=>x.id===id);

/* ---------- BIBLIOTHÈQUE DE MATIÈRES PAR CYCLE (AGC) ---------- */
const CYCLE_LIBRARY = {
  maternelle:[
    ["Éveil (sensoriel, moteur)","#e67e22"],
    ["Activités artistiques et manuelles","#9b59b6"],
    ["Langage et communication","#2980b9"],
    ["Découverte du monde","#16a085"],
    ["Pré-lecture et pré-mathématiques","#c0392b"],
  ],
  primaire:[
    ["Langue Arabe","#c0392b"],["Langue Française","#2e7d32"],["Mathématiques","#1f5fbf"],
    ["Éveil Scientifique","#16a085"],["Éducation Islamique","#7f8c8d"],
    ["Histoire-Géographie","#d35400"],["EPS","#27ae60"],["Éducation Artistique","#9b59b6"],
  ],
  college:[
    ["Mathématiques","#1f5fbf"],["Langue Arabe","#c0392b"],["Langue Française","#2e7d32"],
    ["Physique-Chimie","#8e44ad"],["SVT","#16a085"],["Histoire-Géographie","#d35400"],
    ["Éducation Islamique","#7f8c8d"],["Anglais","#2980b9"],["EPS","#27ae60"],["Informatique","#34495e"],
  ],
  lycee:[
    ["Mathématiques","#1f5fbf"],["Physique-Chimie","#8e44ad"],["SVT","#16a085"],
    ["Langue Arabe","#c0392b"],["Langue Française","#2e7d32"],["Anglais","#2980b9"],
    ["Philosophie","#34495e"],["Histoire-Géographie","#d35400"],["Éducation Islamique","#7f8c8d"],
    ["Informatique","#2c3e50"],["EPS","#27ae60"],
  ],
};
function loadCycle(cycle){
  const lib=CYCLE_LIBRARY[cycle]; if(!lib) return;
  let added=0;
  lib.forEach(([name,color])=>{
    const exists=state.subjects.some(s=>s.name.toLowerCase()===name.toLowerCase());
    if(!exists){ state.subjects.push({id:uid('s'),name,color}); added++; }
  });
  save(); renderSubjects(); renderClasses();
  toast(added?`${added} matière(s) ajoutée(s)`:'Ces matières existent déjà');
}

/* ---------- TOAST ---------- */
let toastT;
function toast(msg){
  const t=document.getElementById('toast');
  document.getElementById('toastMsg').textContent=msg;
  t.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2600);
}

/* ---------- ICÔNES LUCIDE : recréer après chaque rendu ---------- */
function refreshIcons(){ if(window.lucide) lucide.createIcons(); }

/* ---------- MODALE DE CONFIRMATION (remplace confirm()) ---------- */
let _confirmCb=null;
function askConfirm({title,text,okLabel,danger}={}, cb){
  _confirmCb=cb;
  document.getElementById('confirmTitle').textContent=title||'Confirmer';
  document.getElementById('confirmText').textContent=text||'Êtes-vous sûr ?';
  const ok=document.getElementById('confirmOk');
  ok.textContent=okLabel||'Confirmer';
  ok.className='btn '+(danger===false?'primary':'danger-soft');
  const icWrap=document.getElementById('confirmIc');
  icWrap.className='m-ic '+(danger===false?'info':'danger');
  icWrap.innerHTML=`<i data-lucide="${danger===false?'circle-question-mark':'triangle-alert'}" class="ic"></i>`;
  document.getElementById('confirmModal').classList.add('show');
  refreshIcons();
}
function closeConfirm(){ document.getElementById('confirmModal').classList.remove('show'); _confirmCb=null; }

/* ---------- PROMPT MODALE SIMPLE (remplace prompt() pour renommer) ---------- */
function askRename(currentValue, label, cb){
  // réutilise la modale de confirmation en y injectant un champ
  _confirmCb=()=>{ const v=document.getElementById('renameInput').value.trim(); if(v) cb(v); };
  document.getElementById('confirmTitle').textContent=label||'Renommer';
  document.getElementById('confirmText').innerHTML=`<input type="text" id="renameInput" value="${esc(currentValue)}" style="margin-top:4px">`;
  const ok=document.getElementById('confirmOk'); ok.textContent='Enregistrer'; ok.className='btn primary';
  const icWrap=document.getElementById('confirmIc'); icWrap.className='m-ic info';
  icWrap.innerHTML=`<i data-lucide="pencil" class="ic"></i>`;
  document.getElementById('confirmModal').classList.add('show');
  refreshIcons();
  setTimeout(()=>{const i=document.getElementById('renameInput');if(i){i.focus();i.select();}},50);
}

/* =================================================================
   DONNÉES PRÉ-DÉFINIES AGC
   Répartition d'heures par niveau (chaque niveau totalise 32h/sem).
   Les classes de chaque niveau partagent la même répartition.
   ================================================================= */
const LEVEL_PLANS = {
  "Collège": {
    classes:["1AC","2AC","3AC"],
    hours:{
      "Mathématiques":6, "Langue Arabe":5, "Langue Française":5,
      "Physique-Chimie":3, "SVT":3, "Histoire-Géographie":2,
      "Éducation Islamique":2, "Anglais":2, "EPS":2, "Informatique":2
    }
  },
  "Lycée": {
    classes:["Tronc Commun","1Bac","2Bac"],
    hours:{
      "Mathématiques":6, "Physique-Chimie":4, "SVT":3, "Langue Arabe":3,
      "Langue Française":4, "Anglais":3, "Philosophie":2,
      "Histoire-Géographie":2, "Éducation Islamique":2, "Informatique":1, "EPS":2
    }
  }
};

// Couleur par matière (réutilisée partout)
const SUBJECT_COLORS = {
  "Mathématiques":"#1f5fbf","Langue Arabe":"#c0392b","Langue Française":"#2e7d32",
  "Physique-Chimie":"#8e44ad","SVT":"#16a085","Histoire-Géographie":"#d35400",
  "Éducation Islamique":"#7f8c8d","Anglais":"#2980b9","Langue Anglaise":"#2980b9",
  "EPS":"#27ae60","Informatique":"#34495e","Philosophie":"#2c3e50",
  "Éveil Scientifique":"#16a085","Éducation Artistique":"#9b59b6",
  "Langage et communication":"#2980b9","Pré-lecture et pré-mathématiques":"#c0392b",
  "Éveil (sensoriel, moteur)":"#e67e22","Découverte du monde":"#16a085",
  "Activités artistiques et manuelles":"#9b59b6"
};
function colorFor(name){ return SUBJECT_COLORS[name] || '#1f5fbf'; }

/* Pré-remplit matières + enseignants nommés (roster réel AGC) + classes.
   Scénario réaliste et volontairement tendu : profs partagés Collège/Lycée,
   certains à temps partiel ou avec des jours d'indisponibilité. */
function seedAGC(){
  const ALL=()=>{ const a={}; DAYS.forEach(d=>{a[d]={}; PERIODS.forEach((p,pi)=>{ if(isOpen(d,pi)) a[d][pi]=true; });}); return a; };
  // dispo personnalisée : on part de tout dispo puis on retire des jours/demi-journées
  function avail(opts){
    const a=ALL();
    const lunchIdx=PERIODS.findIndex(x=>x.type==='lunch');
    (opts?.offDays||[]).forEach(d=>{ if(a[d]) Object.keys(a[d]).forEach(pi=>a[d][pi]=false); });
    if(opts?.morningsOnly){ DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{ if(isOpen(d,pi)&&pi>lunchIdx) a[d][pi]=false; })); }
    if(opts?.afternoonsOnly){ DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{ if(isOpen(d,pi)&&pi<lunchIdx) a[d][pi]=false; })); }
    (opts?.offSlots||[]).forEach(([d,pi])=>{ if(a[d]) a[d][pi]=false; });
    return a;
  }

  // 1) Matières
  const subjId={};
  function ensureSubject(name){
    let s=state.subjects.find(x=>x.name.toLowerCase()===name.toLowerCase());
    if(!s){ s={id:uid('s'),name,color:colorFor(name)}; state.subjects.push(s); }
    subjId[name]=s.id; return s.id;
  }
  // s'assurer que toutes les matières des plans existent
  Object.values(LEVEL_PLANS).forEach(plan=>Object.keys(plan.hours).forEach(ensureSubject));

  // 2) ROSTER nommé réaliste (Collège + Lycée).
  //    Noms marocains, une matière par prof. Maths : un titulaire collège +
  //    un VACATAIRE (payé à l'heure) qui couvre 3AC et tout le lycée.
  const ROSTER={
    // MATHS — titulaire collège + vacataire tous niveaux
    "M. Ahmed Benani":     { assigns:[["Collège","Mathématiques",["1AC","2AC"]]] },
    "M. Rachid El Fassi":  { assigns:[["Collège","Mathématiques",["3AC"]],
                                      ["Lycée","Mathématiques",["Tronc Commun","1Bac","2Bac"]]] }, // vacataire, 24h
    // ARABE — partagé collège + lycée
    "Mme. Fatima Zahra":   { assigns:[["Collège","Langue Arabe",["1AC","2AC","3AC"]],
                                      ["Lycée","Langue Arabe",["Tronc Commun","1Bac","2Bac"]]] },
    // FRANÇAIS — séparé collège / lycée
    "M. Karim Alaoui":     { assigns:[["Collège","Langue Française",["1AC","2AC","3AC"]]] },
    "Mme. Nadia Bennis":   { assigns:[["Lycée","Langue Française",["Tronc Commun","1Bac","2Bac"]]] },
    // PHYSIQUE-CHIMIE
    "M. Youssef Idrissi":  { assigns:[["Collège","Physique-Chimie",["1AC","2AC","3AC"]],
                                      ["Lycée","Physique-Chimie",["Tronc Commun","1Bac","2Bac"]]] },
    // SVT
    "Mme. Sara Tazi":      { assigns:[["Collège","SVT",["1AC","2AC","3AC"]],
                                      ["Lycée","SVT",["Tronc Commun","1Bac","2Bac"]]] },
    // HISTOIRE-GÉOGRAPHIE
    "M. Omar Saidi":       { assigns:[["Collège","Histoire-Géographie",["1AC","2AC","3AC"]],
                                      ["Lycée","Histoire-Géographie",["Tronc Commun","1Bac","2Bac"]]] },
    // ÉDUCATION ISLAMIQUE
    "Mme. Khadija Amrani": { assigns:[["Collège","Éducation Islamique",["1AC","2AC","3AC"]],
                                      ["Lycée","Éducation Islamique",["Tronc Commun","1Bac","2Bac"]]] },
    // ANGLAIS
    "Mme. Leila Berrada":  { assigns:[["Collège","Anglais",["1AC","2AC","3AC"]],
                                      ["Lycée","Anglais",["Tronc Commun","1Bac","2Bac"]]] },
    // EPS
    "M. Hassan Ouali":     { assigns:[["Collège","EPS",["1AC","2AC","3AC"]],
                                      ["Lycée","EPS",["Tronc Commun","1Bac","2Bac"]]] },
    // INFORMATIQUE
    "M. Mehdi Chraibi":    { assigns:[["Collège","Informatique",["1AC","2AC","3AC"]],
                                      ["Lycée","Informatique",["Tronc Commun","1Bac","2Bac"]]] },
    // PHILOSOPHIE (lycée uniquement)
    "M. Nabil Lahlou":     { assigns:[["Lycée","Philosophie",["Tronc Commun","1Bac","2Bac"]]] },
  };

  // créer les enseignants et construire la table d'affectation "classe|matière" -> teacherId
  const teachId={};
  Object.entries(ROSTER).forEach(([name,info])=>{
    // matières enseignées = toutes celles de ses affectations
    const subjectIds = [...new Set((info.assigns||[]).map(a=>subjId[a[1]]).filter(Boolean))];
    let t=state.teachers.find(x=>x.name===name);
    if(!t){ t={id:uid('t'),name,subjectIds,avail:info.avail||ALL()}; state.teachers.push(t); }
    else { if(info.avail) t.avail=info.avail; t.subjectIds ||= []; subjectIds.forEach(id=>{ if(!t.subjectIds.includes(id)) t.subjectIds.push(id); }); }
    (info.assigns||[]).forEach(([lvl,subj,classes])=>{
      classes.forEach(cn=>{ teachId[`${cn}|${subj}`]=t.id; });
    });
  });

  // 3) Classes
  Object.entries(LEVEL_PLANS).forEach(([level,plan])=>{
    plan.classes.forEach(className=>{
      if(state.classes.some(c=>c.name===className)) return;
      const items=Object.entries(plan.hours).map(([subjName,h])=>({
        subjectId:subjId[subjName], teacherId:teachId[`${className}|${subjName}`]||'', hours:h
      }));
      state.classes.push({id:uid('c'),name:className,items});
    });
  });
  if(!state.currentClass && state.classes[0]) state.currentClass=state.classes[0].id;
  save();
}

/* =================================================================
   RENDU — CONFIGURATION
   ================================================================= */

/* ----- Matières ----- */
function renderSubjects(){
  const box=document.getElementById('subjList');
  if(!state.subjects.length){ box.innerHTML='<div class="empty"><i data-lucide="book-open"></i>Aucune matière. Ajoutez-en une ou chargez un cycle.</div>'; refreshIcons(); return; }
  box.innerHTML='';
  state.subjects.forEach(s=>{
    const el=document.createElement('div'); el.className='row-item';
    el.innerHTML=`<span class="swatch" style="background:${s.color}"></span>
      <span class="nm">${esc(s.name)}</span><span class="sp"></span>
      <button class="ico-btn" data-edit-subj="${s.id}" title="Renommer"><i data-lucide="pencil" class="ic"></i></button>
      <button class="ico-btn danger" data-del-subj="${s.id}" title="Supprimer"><i data-lucide="trash" class="ic"></i></button>`;
    box.appendChild(el);
  });
  refreshIcons();
}

/* ----- Enseignants ----- */
function teachersForSubject(subjectId){
  // ne renvoie que les profs dont la matière attitrée correspond
  return state.teachers.filter(t=>teaches(t,subjectId));
}
function renderTeacherSubjOptions(){
  const box=document.getElementById('teacherSubj'); if(!box) return;
  const keep=new Set([...box.querySelectorAll('.chip-opt.on')].map(b=>b.dataset.sid));
  box.innerHTML = state.subjects.length
    ? state.subjects.map(s=>`<button type="button" class="chip-opt${keep.has(s.id)?' on':''}" data-sid="${s.id}" aria-pressed="${keep.has(s.id)}" style="--c:${s.color}"><span class="dot"></span>${esc(s.name)}</button>`).join('')
    : '<span class="chip-empty">Créez d\'abord une matière</span>';
}
function renderTeachers(){
  renderTeacherSubjOptions();
  const box=document.getElementById('teacherList');
  if(!state.teachers.length){ box.innerHTML='<div class="empty"><i data-lucide="users"></i>Aucun enseignant. Ajoutez-en un ci-dessus.</div>'; refreshIcons(); return; }
  box.innerHTML='';
  state.teachers.forEach(t=>{
    const count=countAvail(t);
    const subs=teacherSubjects(t);
    const wrap=document.createElement('div'); wrap.className='row-item';
    wrap.style.flexDirection='column'; wrap.style.alignItems='stretch';
    wrap.innerHTML=`
      <div style="display:flex;align-items:center;gap:11px;width:100%">
        <span class="nm">${esc(t.name)}</span>
        <span class="t-subjects">${subs.length?subs.map(s=>`<span class="subj-chip" style="--c:${s.color}">${esc(s.name)}</span>`).join(''):'<span class="subj-chip none">Aucune matière</span>'}</span>
        <span class="sp"></span>
        <span class="mt">${count} h dispo</span>
        <button class="ico-btn" data-toggle-avail="${t.id}" title="Disponibilités"><i data-lucide="clock" class="ic"></i></button>
        <button class="ico-btn" data-edit-teacher="${t.id}" title="Renommer"><i data-lucide="pencil" class="ic"></i></button>
        <button class="ico-btn" data-subj-teacher="${t.id}" title="Matières enseignées"><i data-lucide="book-open" class="ic"></i></button>
        <button class="ico-btn danger" data-del-teacher="${t.id}" title="Supprimer"><i data-lucide="trash" class="ic"></i></button>
      </div>
      <div class="avail-region" id="avail-${t.id}" style="display:none"></div>`;
    box.appendChild(wrap);
  });
  refreshIcons();
}
function countAvail(t){
  let n=0; DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{ if(isOpen(d,pi)&&t.avail?.[d]?.[pi]) n++; })); return n;
}
function renderAvailGrid(teacherId){
  const t=byId(state.teachers,teacherId); if(!t) return;
  const region=document.getElementById('avail-'+teacherId);
  let h=`<div class="avail-tools">
      <button class="btn sm" data-avail-all="${teacherId}">Tout cocher</button>
      <button class="btn sm" data-avail-none="${teacherId}">Tout décocher</button>
      <button class="btn sm" data-avail-morning="${teacherId}">Matins seulement</button>
    </div>
    <table class="av-tbl"><thead><tr><th></th>`;
  PERIODS.forEach(p=>{ h+=`<th>${p.type==='course'?p.label.replace(' – ','–'):(p.type==='lunch'?'🍴':'⏸')}</th>`; });
  h+=`</tr></thead><tbody>`;
  DAYS.forEach(day=>{
    h+=`<tr><td class="dl">${day}</td>`;
    PERIODS.forEach((p,pi)=>{
      if(!isOpen(day,pi)){ h+=`<td class="av-cell dim"></td>`; return; }
      const on=t.avail?.[day]?.[pi];
      h+=`<td class="av-cell ${on?'on':'off'}" data-av="${teacherId}|${day}|${pi}">${on?'✓':''}</td>`;
    });
    h+=`</tr>`;
  });
  h+=`</tbody></table>`;
  region.innerHTML=h;
}

/* ----- Classes ----- */
function renderClasses(){
  const box=document.getElementById('classContainer');
  if(!state.classes.length){ box.innerHTML='<div class="empty"><i data-lucide="school"></i>Aucune classe. Ajoutez-en une ou chargez Collège + Lycée.</div>'; refreshIcons(); return; }
  box.innerHTML='';
  state.classes.forEach(c=>{
    const totalH=c.items.reduce((s,i)=>s+(+i.hours||0),0);
    const card=document.createElement('div'); card.className='class-card';
    let rows=c.items.map((it,idx)=>subjRowHtml(c.id,it,idx)).join('');
    if(!c.items.length) rows='<div class="empty" style="padding:14px"><i data-lucide="circle-plus"></i>Ajoutez les matières de cette classe.</div>';
    const hClass = totalH===TOTAL_HOURS?'ok':(totalH>TOTAL_HOURS?'over':'warn');
    const hIcon = totalH===TOTAL_HOURS?'check':(totalH>TOTAL_HOURS?'triangle-alert':'minus');
    card.innerHTML=`
      <div class="cc-head">
        <h4>${esc(c.name)}</h4>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="hours-pill ${hClass}"><i data-lucide="${hIcon}" class="ic-sm"></i> ${totalH}/${TOTAL_HOURS} h</span>
          <button class="ico-btn danger" data-del-class="${c.id}" title="Supprimer la classe"><i data-lucide="trash" class="ic"></i></button>
        </div>
      </div>
      <div class="cc-body">
        <div id="subjrows-${c.id}">${rows}</div>
        <button class="btn sm" data-add-item="${c.id}" style="margin-top:6px"><i data-lucide="plus" class="ic"></i> Ajouter une matière</button>
      </div>`;
    box.appendChild(card);
  });
  refreshIcons();
}
function subjRowHtml(classId,it,idx){
  const subjOpts=['<option value="">— Matière —</option>'].concat(
    state.subjects.map(s=>`<option value="${s.id}" ${s.id===it.subjectId?'selected':''}>${esc(s.name)}</option>`)).join('');
  // n'afficher que les enseignants de la matière sélectionnée
  const eligible = it.subjectId ? teachersForSubject(it.subjectId) : [];
  let teacherOpts;
  if(!it.subjectId){
    teacherOpts='<option value="">— Choisir la matière d\'abord —</option>';
  } else if(!eligible.length){
    teacherOpts='<option value="">— Aucun prof pour cette matière —</option>';
  } else {
    teacherOpts=['<option value="">— Enseignant —</option>'].concat(
      eligible.map(t=>`<option value="${t.id}" ${t.id===it.teacherId?'selected':''}>${esc(t.name)}</option>`)).join('');
  }
  return `<div class="subj-row" data-row="${classId}|${idx}">
      <select data-item-subj="${classId}|${idx}">${subjOpts}</select>
      <select data-item-teacher="${classId}|${idx}">${teacherOpts}</select>
      <input type="number" min="1" max="${TOTAL_HOURS}" value="${it.hours||''}" placeholder="h/sem" data-item-hours="${classId}|${idx}">
      <button class="ico-btn danger" data-del-item="${classId}|${idx}" title="Retirer"><i data-lucide="x" class="ic"></i></button>
    </div>`;
}

/* =================================================================
   ALGORITHME DE GÉNÉRATION AUTOMATIQUE
   Contraintes :
   - respecter les disponibilités enseignant
   - un enseignant ne peut pas être sur 2 classes au même créneau
   - une matière <= 2h/jour, et si 2h le même jour => consécutives
   - respecter le nombre d'heures demandé par matière
   - heures non plaçables => marquées (warn / conflit) pour correction
   ================================================================= */

// occupation enseignant global : teacherBusy[teacherId][day][pi] = classId
function buildTeacherBusy(exceptClassId){
  const busy={};
  state.classes.forEach(c=>{
    if(c.id===exceptClassId) return;
    const grid=state.plan[c.id]; if(!grid) return;
    DAYS.forEach(day=>PERIODS.forEach((p,pi)=>{
      const cell=grid[day]?.[pi];
      if(cell && cell.teacherId){
        (busy[cell.teacherId] ||= {})[day] ||= {};
        busy[cell.teacherId][day][pi]=c.id;
      }
    }));
  });
  return busy;
}

function emptyGrid(){
  const g={}; DAYS.forEach(d=>{ g[d]=Array(PERIODS.length).fill(null); }); return g;
}

// Ordre de parcours des jours pendant la génération (modifié par classe)
let currentDayOrder = DAYS.slice();

function generateClass(classId){
  const c=byId(state.classes,classId); if(!c) return {placed:0,failed:[]};
  const grid=emptyGrid();
  const teacherBusy=buildTeacherBusy(classId);
  // helper local: marquer un enseignant occupé
  function setBusy(tid,day,pi){ if(!tid)return; (teacherBusy[tid] ||= {})[day] ||= {}; teacherBusy[tid][day][pi]=classId; }
  function teacherFree(tid,day,pi){ return !(teacherBusy[tid]?.[day]?.[pi]); }

  // Rotation des jours selon la position de la classe : évite que toutes les
  // classes empilent leurs cours exactement sur les mêmes créneaux (réduit les
  // conflits d'enseignants partagés).
  const classIndex=state.classes.findIndex(x=>x.id===classId);
  const off=((classIndex%DAYS.length)+DAYS.length)%DAYS.length;
  currentDayOrder=DAYS.slice(off).concat(DAYS.slice(0,off));

  // perDay[subjectId][day] = nb heures déjà posées ce jour
  const perDay={};
  const failed=[]; // {subjectName, remaining}

  // Trier matières : les plus contraintes d'abord (plus d'heures, enseignant le moins dispo).
  // Un léger décalage par classe (classIndex) varie l'ordre entre classes sœurs,
  // ce qui répartit mieux les enseignants partagés sur des créneaux différents.
  const items=[...c.items].filter(it=>it.subjectId).map((it,i)=>({...it,hours:+it.hours||0,_ord:i}));
  items.sort((a,b)=>{
    const ta=byId(state.teachers,a.teacherId), tb=byId(state.teachers,b.teacherId);
    const da=ta?countAvail(ta):0, db=tb?countAvail(tb):0;
    if(b.hours!==a.hours) return b.hours-a.hours; // plus d'heures d'abord
    if(da!==db) return da-db;                      // enseignant le moins disponible d'abord
    // tiebreak décalé par classe pour désynchroniser les classes sœurs
    return ((a._ord+classIndex)%items.length) - ((b._ord+classIndex)%items.length);
  });

  // Slots de cours ouverts ordonnés (par jour puis créneau)
  const slots=openSlots();

  items.forEach(it=>{
    const subj=byId(state.subjects,it.subjectId);
    const teacher=it.teacherId?byId(state.teachers,it.teacherId):null;
    perDay[it.subjectId] ||= {};
    let remaining=it.hours;

    // Stratégie : poser par blocs (paires consécutives d'abord, puis unités)
    // tant qu'il reste >=2h, tenter une paire consécutive le même jour ;
    // sinon poser 1h.
    let guard=0;
    while(remaining>0 && guard++<500){
      let placedThis=false;

      if(remaining>=2){
        // chercher une paire consécutive valable
        const pair=findConsecutivePair(grid,perDay,it,teacher,teacherFree);
        if(pair){
          place(grid,it,pair.day,pair.pi1,subj,teacher); setBusy(it.teacherId,pair.day,pair.pi1);
          place(grid,it,pair.day,pair.pi2,subj,teacher); setBusy(it.teacherId,pair.day,pair.pi2);
          perDay[it.subjectId][pair.day]=(perDay[it.subjectId][pair.day]||0)+2;
          remaining-=2; placedThis=true; continue;
        }
      }
      // poser 1h (max 2h/jour respecté)
      const single=findSingle(grid,perDay,it,teacher,teacherFree);
      if(single){
        place(grid,it,single.day,single.pi,subj,teacher); setBusy(it.teacherId,single.day,single.pi);
        perDay[it.subjectId][single.day]=(perDay[it.subjectId][single.day]||0)+1;
        remaining-=1; placedThis=true; continue;
      }
      if(!placedThis) break; // plus de place valable
    }

    if(remaining>0) failed.push({subject:subj?subj.name:'?', teacher:teacher?teacher.name:null, remaining});
  });

  // 2e passe : forcer les heures manquantes sur des cases libres.
  // On privilégie les cases où l'enseignant est AUSSI libre (pour éviter les conflits),
  // puis on accepte n'importe quelle case libre. Ces heures sont marquées pour
  // correction manuelle (sans prof dispo / hors disponibilité).
  items.forEach(it=>{
    const subj=byId(state.subjects,it.subjectId);
    const teacher=it.teacherId?byId(state.teachers,it.teacherId):null;
    let need=it.hours-countSubjectInGrid(grid,it.subjectId);
    let guard=0;
    while(need>0 && guard++<200){
      const slot=findAnyFree(grid,perDay,it,teacherFree);
      if(!slot) break;
      place(grid,it,slot.day,slot.pi,subj,teacher,true); // forced=true
      setBusy(it.teacherId,slot.day,slot.pi);
      perDay[it.subjectId][slot.day]=(perDay[it.subjectId][slot.day]||0)+1;
      need--;
    }
  });

  state.plan[classId]=grid;
  save();
  const placedTotal=countPlaced(grid);
  return {placed:placedTotal, failed};
}

function place(grid,it,day,pi,subj,teacher,forced){
  grid[day][pi]={subjectId:it.subjectId, teacherId:it.teacherId||null, forced:!!forced};
}

/* Passe de réparation SÛRE : tente de résoudre les conflits d'enseignant en
   déplaçant un bloc complet d'une matière (1h isolée OU paire 2h consécutives)
   vers un emplacement où toutes les contraintes restent respectées :
   - enseignant libre globalement et disponible
   - matière <= 2h/jour
   - si bloc de 2h, les deux créneaux restent consécutifs
   Si aucun déplacement sûr n'existe, on laisse le conflit (signalé à l'écran). */
function repairConflicts(maxRounds){
  for(let round=0; round<(maxRounds||6); round++){
    const a=analyzePlan();
    if(!a.conflictList.length) return true;
    let movedAny=false;

    // occupation enseignant : tid|day|pi -> [{classId,d,pi}]
    const busy={};
    state.classes.forEach(c=>{const g=state.plan[c.id];if(!g)return;
      DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{const cell=g[d]?.[pi];if(cell&&cell.teacherId)(busy[cell.teacherId+'|'+d+'|'+pi]=busy[cell.teacherId+'|'+d+'|'+pi]||[]).push({classId:c.id,d,pi});}));
    });

    for(const key of Object.keys(busy)){
      const list=busy[key]; if(list.length<2) continue;
      const tid=key.split('|')[0];
      for(let i=1;i<list.length && !movedAny;i++){
        const {classId,d,pi}=list[i];
        if(tryRelocate(classId,d,pi,tid)){ movedAny=true; }
      }
      if(movedAny) break; // recalculer l'occupation après chaque déplacement
    }
    if(!movedAny) break;
  }
  save();
  return analyzePlan().conflictList.length===0;
}

// teacher occupé globalement à (day,pi), en ignorant une liste de cases exclues
function teacherBusyGlobal(tid,day,pi,exclude){
  let busy=false;
  state.classes.forEach(c=>{const g=state.plan[c.id];if(!g)return;
    const x=g[day]?.[pi];
    if(x&&x.teacherId===tid){
      const skip=(exclude||[]).some(e=>e.classId===c.id&&e.day===day&&e.pi===pi);
      if(!skip) busy=true;
    }});
  return busy;
}

// Tente de déplacer le cours en (fromDay,fromPi) de classId vers un créneau sûr.
// Gère le bloc consécutif : si la matière forme une paire ce jour, déplace la paire.
function tryRelocate(classId,fromDay,fromPi,tid){
  const grid=state.plan[classId];
  const cell=grid[fromDay][fromPi]; if(!cell) return false;
  const teacher=cell.teacherId?byId(state.teachers,cell.teacherId):null;

  // déterminer si cette heure fait partie d'une paire consécutive ce jour
  const sameDaySlots=[];
  PERIODS.forEach((p,pi)=>{ if(grid[fromDay][pi]?.subjectId===cell.subjectId) sameDaySlots.push(pi); });
  let block=[fromPi];
  if(sameDaySlots.length===2 && areTeachingAdjacent(sameDaySlots[0],sameDaySlots[1])) block=sameDaySlots.slice();

  const exclude=block.map(pi=>({classId,day:fromDay,pi}));

  // chercher une destination
  for(const day of DAYS){
    // compter heures de la matière ce jour hors le bloc source
    let cnt=0; PERIODS.forEach((p,pi)=>{ if(grid[day][pi]?.subjectId===cell.subjectId && !(day===fromDay&&block.includes(pi))) cnt++; });
    if(block.length===2){
      if(cnt>0) continue; // déjà des heures -> 2h impossible
      // chercher une paire libre consécutive
      const ci=PERIODS.map((p,pi)=>pi).filter(pi=>isOpen(day,pi));
      for(let k=0;k<ci.length-1;k++){
        const x=ci[k], y=ci[k+1];
        if(!areTeachingAdjacent(x,y)) continue;
        if((grid[day][x]&&!(day===fromDay&&block.includes(x)))||(grid[day][y]&&!(day===fromDay&&block.includes(y)))) continue;
        if(teacher&&(!teacher.avail?.[day]?.[x]||!teacher.avail?.[day]?.[y])) continue;
        if(teacherBusyGlobal(tid,day,x,exclude)||teacherBusyGlobal(tid,day,y,exclude)) continue;
        if(day===fromDay&&block.includes(x)&&block.includes(y)) continue; // même place
        // effectuer le déplacement
        const c0=grid[fromDay][block[0]], c1=grid[fromDay][block[1]];
        block.forEach(pi=>grid[fromDay][pi]=null);
        grid[day][x]=c0; grid[day][y]=c1;
        return true;
      }
    } else {
      if(cnt>=2) continue;
      for(let pi=0;pi<PERIODS.length;pi++){
        if(!isOpen(day,pi)) continue;
        if(grid[day][pi]&&!(day===fromDay&&pi===fromPi)) continue;
        if(day===fromDay&&pi===fromPi) continue;
        if(teacher&&!teacher.avail?.[day]?.[pi]) continue;
        if(teacherBusyGlobal(tid,day,pi,exclude)) continue;
        grid[day][pi]=cell; grid[fromDay][fromPi]=null;
        return true;
      }
    }
  }
  return false;
}
function countSubjectInGrid(grid,subjectId){
  let n=0; DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{ if(grid[d][pi]?.subjectId===subjectId) n++; })); return n;
}
function countPlaced(grid){
  let n=0; DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{ if(grid[d][pi]) n++; })); return n;
}

// paire consécutive : deux créneaux de cours qui se suivent (pi voisins ouverts), même jour,
// matière pas déjà à 2h ce jour, enseignant libre (si défini)
function findConsecutivePair(grid,perDay,it,teacher,teacherFree){
  for(const day of currentDayOrder){
    if((perDay[it.subjectId][day]||0) >= 2) continue;
    // créneaux de cours ouverts ce jour, dans l'ordre
    const ci=PERIODS.map((p,pi)=>pi).filter(pi=>isOpen(day,pi));
    for(let k=0;k<ci.length-1;k++){
      const a=ci[k], b=ci[k+1];
      // a et b doivent être consécutifs PÉDAGOGIQUEMENT (pas séparés par déjeuner)
      if(!areTeachingAdjacent(a,b)) continue;
      if(grid[day][a]||grid[day][b]) continue;
      if(teacher){ if(!teacher.avail?.[day]?.[a] || !teacher.avail?.[day]?.[b]) continue;
                   if(!teacherFree(it.teacherId,day,a)||!teacherFree(it.teacherId,day,b)) continue; }
      return {day,pi1:a,pi2:b};
    }
  }
  return null;
}
// deux créneaux sont "adjacents pédagogiquement" si entre eux il n'y a qu'une pause courte (pas le déjeuner)
function areTeachingAdjacent(a,b){
  if(b<=a) return false;
  for(let i=a+1;i<b;i++){ if(PERIODS[i].type==='lunch') return false; }
  // autoriser uniquement si rien d'autre qu'une 'break' entre les deux
  for(let i=a+1;i<b;i++){ if(PERIODS[i].type==='course') return false; }
  return true;
}

function findSingle(grid,perDay,it,teacher,teacherFree){
  for(const day of currentDayOrder){
    const ex=[]; PERIODS.forEach((p,pi)=>{ if(grid[day][pi]?.subjectId===it.subjectId) ex.push(pi); });
    if(ex.length>=2) continue;
    for(let pi=0;pi<PERIODS.length;pi++){
      if(!isOpen(day,pi)||grid[day][pi]) continue;
      if(ex.length===1 && !areTeachingAdjacent(Math.min(ex[0],pi),Math.max(ex[0],pi))) continue; // 2e heure consécutive
      if(teacher){ if(!teacher.avail?.[day]?.[pi]) continue;
                   if(!teacherFree(it.teacherId,day,pi)) continue; }
      return {day,pi};
    }
  }
  return null;
}
function findAnyFree(grid,perDay,it,teacherFree){
  // Place une heure restante en respectant STRICTEMENT les règles :
  //  - jamais plus de 2h/jour pour la matière
  //  - si c'est la 2e heure du jour, elle doit être consécutive à la 1ère
  // Préférence : d'abord avec enseignant libre, sinon n'importe quel créneau valable.
  function existingSlots(day){ const a=[]; PERIODS.forEach((p,pi)=>{ if(grid[day][pi]?.subjectId===it.subjectId) a.push(pi); }); return a; }
  for(const needFree of [true,false]){
    for(const day of currentDayOrder){
      const ex=existingSlots(day);
      if(ex.length>=2) continue;            // déjà 2h -> on saute (cap strict)
      for(let pi=0;pi<PERIODS.length;pi++){
        if(!isOpen(day,pi)||grid[day][pi]) continue;
        if(ex.length===1 && !areTeachingAdjacent(Math.min(ex[0],pi),Math.max(ex[0],pi))) continue; // 2e heure: consécutive seulement
        if(needFree && it.teacherId && teacherFree && !teacherFree(it.teacherId,day,pi)) continue;
        return {day,pi};
      }
    }
  }
  return null;
}

/* =================================================================
   DÉTECTION DE CONFLITS (analyse de tout le plan, toutes classes)
   ================================================================= */
function analyzePlan(){
  // conflits enseignant : même prof, même créneau, 2 classes
  const busy={}; // tid|day|pi -> [classId]
  const conflictCells=new Set(); // "classId|day|pi"
  state.classes.forEach(c=>{
    const grid=state.plan[c.id]; if(!grid) return;
    DAYS.forEach(day=>PERIODS.forEach((p,pi)=>{
      const cell=grid[day]?.[pi]; if(!cell||!cell.teacherId) return;
      const k=cell.teacherId+'|'+day+'|'+pi;
      (busy[k] ||= []).push({classId:c.id,day,pi,teacherId:cell.teacherId});
    }));
  });
  const conflictList=[];
  Object.values(busy).forEach(list=>{
    if(list.length>1){
      const t=byId(state.teachers,list[0].teacherId);
      const cls=list.map(x=>byId(state.classes,x.classId)?.name).join(' & ');
      conflictList.push(`${t?t.name:'?'} : ${cls} — ${list[0].day} ${PERIODS[list[0].pi].label}`);
      list.forEach(x=>conflictCells.add(x.classId+'|'+x.day+'|'+x.pi));
    }
  });

  // heures manquantes / forcées par classe
  const issues=[]; // textual
  let noTeacherCells=0;
  state.classes.forEach(c=>{
    const grid=state.plan[c.id]; if(!grid) return;
    // forced cells
    DAYS.forEach(day=>PERIODS.forEach((p,pi)=>{
      const cell=grid[day]?.[pi];
      if(cell&&cell.forced) noTeacherCells++;
    }));
    // heures par matière vs demandé
    c.items.forEach(it=>{
      if(!it.subjectId) return;
      const want=+it.hours||0;
      const got=countSubjectInGrid(grid,it.subjectId);
      if(got<want){
        const s=byId(state.subjects,it.subjectId);
        issues.push(`${c.name} : ${s?s.name:'?'} — ${got}/${want}h placées (${want-got}h manquante·s)`);
      }
    });
    // total
    const total=countPlaced(grid);
    if(total>0 && total!==TOTAL_HOURS){
      issues.push(`${c.name} : ${total}/${TOTAL_HOURS}h au total`);
    }
  });

  return {conflictCells, conflictList, issues, noTeacherCells};
}

/* =================================================================
   RENDU — PLANNING (3 modes : class / teacher / subject)
   ================================================================= */
let planMode='class';      // 'class' | 'teacher' | 'subject'
let currentEntity=null;    // id du prof ou de la matière selon le mode

function renderPlanSelect(){
  const sel=document.getElementById('planClassSelect');
  const lbl=document.getElementById('selectLabel');
  if(planMode==='class'){
    lbl.textContent='Classe affichée';
    sel.innerHTML = state.classes.length
      ? state.classes.map(c=>`<option value="${c.id}" ${c.id===state.currentClass?'selected':''}>${esc(c.name)}</option>`).join('')
      : '<option value="">— Aucune classe —</option>';
    if(!state.currentClass && state.classes[0]) state.currentClass=state.classes[0].id;
  } else if(planMode==='teacher'){
    lbl.textContent='Enseignant affiché';
    // uniquement les profs réellement affectés quelque part
    const used=new Set(); state.classes.forEach(c=>c.items.forEach(it=>{ if(it.teacherId) used.add(it.teacherId); }));
    const list=state.teachers.filter(t=>used.has(t.id));
    if(!currentEntity && list[0]) currentEntity=list[0].id;
    sel.innerHTML = list.length
      ? list.map(t=>`<option value="${t.id}" ${t.id===currentEntity?'selected':''}>${esc(t.name)}</option>`).join('')
      : '<option value="">— Aucun enseignant affecté —</option>';
  } else {
    lbl.textContent='Matière affichée';
    const used=new Set(); state.classes.forEach(c=>c.items.forEach(it=>{ if(it.subjectId) used.add(it.subjectId); }));
    const list=state.subjects.filter(s=>used.has(s.id));
    if(!currentEntity && list[0]) currentEntity=list[0].id;
    sel.innerHTML = list.length
      ? list.map(s=>`<option value="${s.id}" ${s.id===currentEntity?'selected':''}>${esc(s.name)}</option>`).join('')
      : '<option value="">— Aucune matière —</option>';
  }
}

function renderPlan(){
  renderPlanSelect();
  // les boutons de génération n'ont de sens qu'en mode classe
  const genActions=document.getElementById('genActions');
  document.getElementById('genOneBtn').style.display = planMode==='class'?'':'none';
  document.getElementById('genAllBtn').style.display = planMode==='class'?'':'none';
  document.getElementById('clearPlanBtn').style.display = planMode==='class'?'':'none';

  if(planMode==='class') renderClassPlan();
  else renderEntityPlan(); // teacher ou subject (lecture seule)
  refreshIcons();
}

/* ----- Vue par CLASSE (éditable) ----- */
function renderClassPlan(){
  const c = state.currentClass?byId(state.classes,state.currentClass):null;
  const table=document.getElementById('planTable');
  const titleEl=document.getElementById('planTitle');
  document.getElementById('planLegend').style.display='';
  document.getElementById('planStats').style.display='';
  if(!c){
    table.innerHTML='<tbody><tr><td style="padding:30px;text-align:center;color:#888">Créez d\'abord une classe dans Configuration.</td></tr></tbody>';
    document.getElementById('planStats').innerHTML='';
    document.getElementById('planAlerts').innerHTML='';
    titleEl.style.display='none';
    return;
  }
  const analysis=analyzePlan();
  const grid=state.plan[c.id]||emptyGrid();
  titleEl.style.display='block';
  titleEl.textContent='Emploi du temps — '+c.name;
  document.getElementById('printSubtitle').textContent='Emploi du temps — Classe '+c.name;

  let h=planHeadRow();
  DAYS.forEach(day=>{
    h+=`<tr><th>${day}</th>`;
    PERIODS.forEach((p,pi)=>{
      if(p.type!=='course'){ if(day===DAYS[0]) h+=pauseCellHTML(p); return; }
      if(!isOpen(day,pi)){ const cs=closedSpan(day,pi); if(cs) h+=`<td class="slot closed" colspan="${cs}"><span class="closed-lbl"><i data-lucide="moon" class="ic-sm"></i>Pas de cours</span></td>`; return; }
      const cell=grid[day]?.[pi];
      if(cell){
        const s=byId(state.subjects,cell.subjectId);
        const t=cell.teacherId?byId(state.teachers,cell.teacherId):null;
        const isConf=analysis.conflictCells.has(c.id+'|'+day+'|'+pi);
        const noTeach=cell.forced || !cell.teacherId;
        const cls=isConf?'conflict':(noTeach?'noteacher':'');
        const bg=s?s.color:'#888';
        let badge='';
        if(isConf) badge='<span class="badge c"><i data-lucide="triangle-alert" class="ic"></i>prof occupé</span>';
        else if(noTeach) badge='<span class="badge w"><i data-lucide="user-x" class="ic"></i>sans prof</span>';
        h+=`<td class="slot" data-day="${day}" data-pi="${pi}">
              <div class="placed ${cls}" draggable="true" data-cell="${day}|${pi}" style="background:${bg}">
                <button class="p-del" data-del-cell="${day}|${pi}" title="Retirer"><i data-lucide="x" class="ic"></i></button>
                <span class="p-subj">${s?esc(s.name):'?'}</span>
                <span class="p-meta">${t?esc(t.name):'—'}</span>${badge}</div></td>`;
      } else {
        // CASE VIDE cliquable -> ajouter une séance
        h+=`<td class="slot empty-slot" data-day="${day}" data-pi="${pi}" data-add="${day}|${pi}">
              <span class="add-hint"><i data-lucide="circle-plus" class="ic"></i></span></td>`;
      }
    });
    h+='</tr>';
  });
  h+='</tbody>';
  table.innerHTML=h;

  attachPlanDnD();
  attachEmptySlots();
  renderStats(c,grid,analysis);
  renderAlerts(c,grid,analysis);
}

/* ----- Vue par ENSEIGNANT ou MATIÈRE (lecture seule, multi-classes) ----- */
function renderEntityPlan(){
  const table=document.getElementById('planTable');
  const titleEl=document.getElementById('planTitle');
  document.getElementById('planLegend').style.display='none';
  document.getElementById('planStats').style.display='';
  if(!currentEntity){
    table.innerHTML=`<tbody><tr><td style="padding:30px;text-align:center;color:#888">Aucun ${planMode==='teacher'?'enseignant affecté':'matière'} à afficher.</td></tr></tbody>`;
    document.getElementById('planStats').innerHTML='';
    document.getElementById('planAlerts').innerHTML='';
    titleEl.style.display='none';
    return;
  }
  const isTeacher=planMode==='teacher';
  const ent = isTeacher?byId(state.teachers,currentEntity):byId(state.subjects,currentEntity);
  const entName=ent?ent.name:'?';
  titleEl.style.display='block';
  titleEl.textContent=(isTeacher?'Emploi du temps — ':'Matière — ')+entName;
  document.getElementById('printSubtitle').textContent=(isTeacher?'Emploi du temps — ':'Matière — ')+entName;

  // construire : pour chaque (day,pi) la liste des affectations correspondant à l'entité
  // cell occupée par cette entité dans une classe -> on récupère classe + matière/prof
  const map={}; // day|pi -> [{className, subjectName, color, teacherName, conflict}]
  const analysis=analyzePlan();
  state.classes.forEach(c=>{
    const grid=state.plan[c.id]; if(!grid) return;
    DAYS.forEach(day=>PERIODS.forEach((p,pi)=>{
      const cell=grid[day]?.[pi]; if(!cell) return;
      const match = isTeacher ? cell.teacherId===currentEntity : cell.subjectId===currentEntity;
      if(!match) return;
      const s=byId(state.subjects,cell.subjectId);
      const t=cell.teacherId?byId(state.teachers,cell.teacherId):null;
      const conf=analysis.conflictCells.has(c.id+'|'+day+'|'+pi);
      (map[day+'|'+pi]=map[day+'|'+pi]||[]).push({
        className:c.name, subjectName:s?s.name:'?', color:s?s.color:'#888',
        teacherName:t?t.name:'—', conflict:conf
      });
    }));
  });

  let h=planHeadRow();
  let totalHours=0, clashCount=0;
  DAYS.forEach(day=>{
    h+=`<tr><th>${day}</th>`;
    PERIODS.forEach((p,pi)=>{
      if(p.type!=='course'){ if(day===DAYS[0]) h+=pauseCellHTML(p); return; }
      if(!isOpen(day,pi)){ const cs=closedSpan(day,pi); if(cs) h+=`<td class="slot closed" colspan="${cs}"><span class="closed-lbl"><i data-lucide="moon" class="ic-sm"></i>Pas de cours</span></td>`; return; }
      const list=map[day+'|'+pi]||[];
      if(!list.length){ h+=`<td class="slot"></td>`; return; }
      totalHours+=list.length;
      // si plusieurs affectations sur le même créneau pour cette entité => chevauchement
      const clash=list.length>1 || list.some(x=>x.conflict);
      if(clash) clashCount++;
      const main=list[0];
      const bg=isTeacher?main.color:main.color;
      // contenu : classe + matière (mode prof) / classe + prof (mode matière)
      const lines=list.map(x=> isTeacher
        ? `<span class="p-subj">${esc(x.className)} · ${esc(x.subjectName)}</span>`
        : `<span class="p-subj">${esc(x.className)} · ${esc(x.teacherName)}</span>`).join('');
      let badge = clash?'<span class="badge c"><i data-lucide="triangle-alert" class="ic"></i>chevauchement</span>':'';
      h+=`<td class="slot"><div class="placed ${clash?'conflict':''}" style="background:${bg}">${lines}${badge}</div></td>`;
    });
    h+='</tr>';
  });
  h+='</tbody>';
  table.innerHTML=h;

  // stats pour l'entité
  const box=document.getElementById('planStats');
  box.innerHTML=`
    <div class="stat good"><span class="n">${totalHours}</span><span class="l">Heures / semaine</span></div>
    <div class="stat ${clashCount?'bad':'good'}"><span class="n">${clashCount}</span><span class="l">Chevauchements</span></div>`;
  // alerte
  const al=document.getElementById('planAlerts');
  if(clashCount){
    al.innerHTML=`<div class="alert err"><i data-lucide="octagon-alert" class="ic"></i><div><b>${entName}</b> a ${clashCount} créneau(x) en chevauchement (deux classes en même temps). Corrigez en mode « Par classe ».</div></div>`;
  } else if(totalHours){
    al.innerHTML=`<div class="alert ok"><i data-lucide="circle-check" class="ic"></i><div>Emploi du temps cohérent — ${totalHours} h par semaine, aucun chevauchement. Prêt à imprimer ou envoyer.</div></div>`;
  } else {
    al.innerHTML=`<div class="alert tip"><i data-lucide="info" class="ic"></i><div>Aucune séance pour le moment. Générez les emplois du temps en mode « Par classe ».</div></div>`;
  }
}

function planHeadRow(){
  let h='<thead><tr><th>Jour</th>';
  PERIODS.forEach(p=>{
    if(p.type==='course'){ h+=`<th>${p.label}</th>`; }
    else { h+=`<th class="th-pause th-${p.type}">${p.label.replace(' – ','<br>')}</th>`; }
  });
  return h+'</tr></thead><tbody>';
}

function renderStats(c,grid,analysis){
  const total=countPlaced(grid);
  const conf=[...analysis.conflictCells].filter(k=>k.startsWith(c.id+'|')).length;
  let forced=0; DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{ if(grid[d]?.[pi]?.forced) forced++; }));
  const box=document.getElementById('planStats');
  box.innerHTML=`
    <div class="stat ${total===TOTAL_HOURS?'good':'warn'}"><span class="n">${total}/${TOTAL_HOURS}</span><span class="l">Heures placées</span></div>
    <div class="stat ${conf?'bad':'good'}"><span class="n">${conf}</span><span class="l">Conflits d'enseignant</span></div>
    <div class="stat ${forced?'warn':'good'}"><span class="n">${forced}</span><span class="l">Sans prof disponible</span></div>`;
}

function renderAlerts(c,grid,analysis){
  const box=document.getElementById('planAlerts');
  const myConf=analysis.conflictList;
  const myIssues=analysis.issues.filter(t=>t.startsWith(c.name+' :'));
  if(!countPlaced(grid)){
    box.innerHTML=`<div class="alert tip"><i data-lucide="lightbulb" class="ic"></i><div>Cliquez <b>« Générer cette classe »</b> pour créer l'emploi du temps automatiquement selon les disponibilités des enseignants.</div></div>`;
    return;
  }
  let out='';
  if(myConf.length){
    out+=`<div class="alert err"><i data-lucide="octagon-alert" class="ic"></i><div><b>Conflits d'enseignant à corriger :</b><ul>${myConf.slice(0,8).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div></div>`;
  }
  if(myIssues.length){
    out+=`<div class="alert warn"><i data-lucide="triangle-alert" class="ic"></i><div><b>À vérifier pour ${esc(c.name)} :</b><ul>${myIssues.map(x=>`<li>${esc(x.replace(c.name+' : ',''))}</li>`).join('')}</ul></div></div>`;
  }
  if(!out){
    out=`<div class="alert ok"><i data-lucide="circle-check" class="ic"></i><div><b>Parfait.</b> Emploi du temps complet, sans conflit. Toutes les heures sont placées.</div></div>`;
  }
  box.innerHTML=out;
}

/* ---------- DRAG & DROP manuel ---------- */
let dragData=null;
let dragGhost=null;
let lastDropTime=0;
function attachPlanDnD(){
  // --- Drag & drop par Pointer Events (fiable souris + tactile) ---
  document.querySelectorAll('#planTable .placed').forEach(el=>{
    el.addEventListener('pointerdown',startPointerDrag);
    // garder aussi le drag HTML5 natif comme repli
    el.setAttribute('draggable','true');
    el.addEventListener('dragstart',e=>{
      const [day,pi]=el.dataset.cell.split('|'); dragData={day,pi:+pi}; e.dataTransfer.effectAllowed='move';
    });
  });
  document.querySelectorAll('#planTable .slot[data-day]').forEach(slot=>{
    slot.addEventListener('dragover',e=>{e.preventDefault();slot.classList.add('drop-hover');});
    slot.addEventListener('dragleave',()=>slot.classList.remove('drop-hover'));
    slot.addEventListener('drop',e=>{
      e.preventDefault(); slot.classList.remove('drop-hover');
      if(!dragData) return;
      doSwap(dragData.day,dragData.pi, slot.dataset.day,+slot.dataset.pi);
      dragData=null;
    });
  });
  document.querySelectorAll('#planTable [data-del-cell]').forEach(b=>{
    b.addEventListener('pointerdown',e=>e.stopPropagation()); // ne pas démarrer un drag depuis la croix
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const [day,pi]=b.dataset.delCell.split('|');
      const grid=state.plan[state.currentClass];
      const cell=grid?.[day]?.[+pi];
      const s=cell?byId(state.subjects,cell.subjectId):null;
      askConfirm({title:'Retirer la séance ?',text:`${s?s.name:'Cette séance'} sera retirée de ce créneau.`,okLabel:'Retirer'},()=>{
        grid[day][+pi]=null; save(); renderPlan();
      });
    });
  });
}

function startPointerDrag(e){
  // seulement clic gauche / touch
  if(e.button && e.button!==0) return;
  const el=e.currentTarget;
  const [day,pi]=el.dataset.cell.split('|');
  dragData={day,pi:+pi};
  el.setPointerCapture?.(e.pointerId);

  // créer un fantôme qui suit le curseur
  dragGhost=el.cloneNode(true);
  const r=el.getBoundingClientRect();
  Object.assign(dragGhost.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',
    pointerEvents:'none',opacity:'0.85',zIndex:'300',transform:'scale(1.03)',boxShadow:'0 10px 30px rgba(0,0,0,.3)'});
  document.body.appendChild(dragGhost);
  el.style.opacity='0.35';

  const offX=e.clientX-r.left, offY=e.clientY-r.top;
  let lastSlot=null;
  function move(ev){
    if(dragGhost){ dragGhost.style.left=(ev.clientX-offX)+'px'; dragGhost.style.top=(ev.clientY-offY)+'px'; }
    const target=document.elementFromPoint(ev.clientX,ev.clientY);
    const slot=target?target.closest('#planTable .slot[data-day]'):null;
    if(slot!==lastSlot){ if(lastSlot)lastSlot.classList.remove('drop-hover'); if(slot)slot.classList.add('drop-hover'); lastSlot=slot; }
  }
  function up(ev){
    document.removeEventListener('pointermove',move);
    document.removeEventListener('pointerup',up);
    if(dragGhost){ dragGhost.remove(); dragGhost=null; }
    el.style.opacity='';
    if(lastSlot){ lastSlot.classList.remove('drop-hover');
      doSwap(dragData.day,dragData.pi, lastSlot.dataset.day,+lastSlot.dataset.pi);
    }
    dragData=null;
  }
  document.addEventListener('pointermove',move);
  document.addEventListener('pointerup',up);
  e.preventDefault();
}

// Échange (ou déplacement si cible vide) RÉEL + sauvegarde
function doSwap(fromDay,fromPi,toDay,toPi){
  lastDropTime=Date.now();
  if(fromDay===toDay && fromPi===toPi) return;
  const grid=state.plan[state.currentClass]; if(!grid) return;
  const moving=grid[fromDay][fromPi];
  const target=grid[toDay][toPi];
  grid[toDay][toPi]=moving;
  grid[fromDay][fromPi]=target||null;   // si cible vide -> déplacement ; sinon échange
  save(); renderPlan();
  toast(target?'Séances échangées':'Séance déplacée');
}

/* ---------- AJOUT DE SÉANCE sur case vide ---------- */
let addCtx=null; // {day, pi}
function attachEmptySlots(){
  document.querySelectorAll('#planTable .empty-slot').forEach(slot=>{
    slot.addEventListener('click',()=>{
      // ne pas ouvrir si un drag vient de se terminer (évite l'ouverture parasite après un dépôt)
      if(Date.now()-lastDropTime < 350) return;
      const [day,pi]=slot.dataset.add.split('|');
      openAddModal(day,+pi);
    });
  });
}
function openAddModal(day,pi){
  if(!state.subjects.length){ toast('Ajoutez d\'abord des matières'); return; }
  addCtx={day,pi};
  const lbl=PERIODS[pi].label;
  document.getElementById('addSlotInfo').textContent=`${day} · ${lbl}`;
  const subjSel=document.getElementById('addSubjSel');
  subjSel.innerHTML=state.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  // pré-sélectionner une matière encore incomplète dans cette classe
  const c=byId(state.classes,state.currentClass);
  if(c){
    const grid=state.plan[c.id]||emptyGrid();
    const incomplete=c.items.find(it=>it.subjectId && countSubjectInGrid(grid,it.subjectId) < (+it.hours||0));
    if(incomplete) subjSel.value=incomplete.subjectId;
  }
  syncAddTeacher();
  document.getElementById('addModal').classList.add('show');
  refreshIcons();
}
function syncAddTeacher(){
  const subjId=document.getElementById('addSubjSel').value;
  const tSel=document.getElementById('addTeacherSel');
  const eligible=teachersForSubject(subjId);
  const c=byId(state.classes,state.currentClass);
  const assigned=c?.items.find(it=>it.subjectId===subjId)?.teacherId||'';
  if(!eligible.length){
    tSel.innerHTML='<option value="">— Aucun prof pour cette matière —</option>';
  } else {
    tSel.innerHTML='<option value="">— Sans enseignant —</option>'+
      eligible.map(t=>`<option value="${t.id}" ${t.id===assigned?'selected':''}>${esc(t.name)}</option>`).join('');
  }
  checkAddWarn();
}
function checkAddWarn(){
  const warn=document.getElementById('addWarn');
  if(!addCtx){ warn.innerHTML=''; return; }
  const tId=document.getElementById('addTeacherSel').value;
  const {day,pi}=addCtx;
  let msg='';
  if(tId){
    const t=byId(state.teachers,tId);
    // prof dispo ?
    if(t && !t.avail?.[day]?.[pi]) msg=`⚠ ${t.name} n'est pas indiqué disponible sur ce créneau.`;
    // prof déjà occupé ailleurs ?
    let busyClass=null;
    state.classes.forEach(c=>{ if(c.id===state.currentClass) return; const x=state.plan[c.id]?.[day]?.[pi]; if(x&&x.teacherId===tId) busyClass=c.name; });
    if(busyClass) msg=`⛔ ${t.name} est déjà en cours avec ${busyClass} sur ce créneau.`;
  }
  warn.innerHTML = msg? `<div class="alert ${msg.startsWith('⛔')?'err':'warn'}" style="margin-top:4px"><i data-lucide="triangle-alert" class="ic"></i><div>${esc(msg)}</div></div>`:'';
  refreshIcons();
}
function confirmAddSession(){
  if(!addCtx) return;
  const subjId=document.getElementById('addSubjSel').value;
  const tId=document.getElementById('addTeacherSel').value;
  if(!subjId){ toast('Choisissez une matière'); return; }
  const {day,pi}=addCtx;
  const grid=state.plan[state.currentClass] || (state.plan[state.currentClass]=emptyGrid());
  grid[day][pi]={subjectId:subjId, teacherId:tId||null, forced:!tId};
  save(); closeAddModal(); renderPlan();
  toast('Séance ajoutée');
}
function closeAddModal(){ document.getElementById('addModal').classList.remove('show'); addCtx=null; }

/* =================================================================
   UTIL
   ================================================================= */
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

/* =================================================================
   ÉVÉNEMENTS
   ================================================================= */
function bind(){
  // Navigation (sidebar .nav-item ou anciens .tab)
  const navBtns=document.querySelectorAll('.nav-item, .tab');
  navBtns.forEach(btn=>{
    btn.addEventListener('click',()=>{
      navBtns.forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view-'+btn.dataset.view).classList.add('active');
      if(btn.dataset.view==='planning') renderPlan();
      window.scrollTo({top:0,behavior:'smooth'});
    });
  });

  // ----- Matières -----
  document.getElementById('addSubjBtn').addEventListener('click',addSubject);
  document.getElementById('loadCycleBtn').addEventListener('click',()=>{
    const cy=document.getElementById('cycleSelect').value;
    if(!cy){ toast('Choisissez un cycle'); return; }
    loadCycle(cy);
  });
  document.getElementById('subjName').addEventListener('keydown',e=>{if(e.key==='Enter')addSubject();});
  document.getElementById('subjList').addEventListener('click',e=>{
    const d=e.target.closest('[data-del-subj]'); const ed=e.target.closest('[data-edit-subj]');
    if(d){ delSubject(d.dataset.delSubj); }
    if(ed){ editSubject(ed.dataset.editSubj); }
  });

  // ----- Enseignants -----
  document.getElementById('addTeacherBtn').addEventListener('click',addTeacher);
  document.getElementById('teacherName').addEventListener('keydown',e=>{if(e.key==='Enter')addTeacher();});
  document.getElementById('teacherList').addEventListener('click',e=>{
    const tg=e.target.closest('[data-toggle-avail]');
    const ed=e.target.closest('[data-edit-teacher]');
    const dl=e.target.closest('[data-del-teacher]');
    const av=e.target.closest('[data-av]');
    const sj=e.target.closest('[data-subj-teacher]');
    const all=e.target.closest('[data-avail-all]'); const none=e.target.closest('[data-avail-none]'); const morn=e.target.closest('[data-avail-morning]');
    if(tg){ toggleAvail(tg.dataset.toggleAvail); }
    if(ed){ editTeacher(ed.dataset.editTeacher); }
    if(sj){ changeTeacherSubject(sj.dataset.subjTeacher); }
    if(dl){ delTeacher(dl.dataset.delTeacher); }
    if(av){ flipAvail(av.dataset.av); }
    if(all){ setAvailAll(all.dataset.availAll,true); }
    if(none){ setAvailAll(none.dataset.availNone,false); }
    if(morn){ setAvailMorning(morn.dataset.availMorning); }
  });

  // ----- Classes -----
  document.getElementById('addClassBtn').addEventListener('click',addClass);
  document.getElementById('seedBtn').addEventListener('click',()=>{
    const apply=()=>{ seedAGC(); renderSubjects(); renderTeachers(); renderClasses(); renderPlanSelect(); toast('Classes et matières AGC chargées'); };
    if(state.classes.length) askConfirm({title:'Charger Collège + Lycée ?',text:'Les classes manquantes seront ajoutées. Vos classes existantes sont conservées.',okLabel:'Charger',danger:false},apply);
    else apply();
  });
  document.getElementById('resetAllBtn').addEventListener('click',()=>{
    askConfirm({title:'Tout réinitialiser ?',text:'Matières, enseignants, classes et emplois du temps seront effacés, puis Collège + Lycée rechargés. Une copie de la version actuelle reste disponible dans l\'historique.',okLabel:'Tout réinitialiser'},()=>{
      state={subjects:[],teachers:[],classes:[],currentClass:null,plan:{},settings:state.settings||{}};
      seedAGC();
      renderSubjects(); renderTeachers(); renderClasses(); renderPlanSelect();
      toast('Réinitialisé : Collège + Lycée');
    });
  });
  document.getElementById('className').addEventListener('keydown',e=>{if(e.key==='Enter')addClass();});
  document.getElementById('classContainer').addEventListener('click',e=>{
    const ai=e.target.closest('[data-add-item]'); const di=e.target.closest('[data-del-item]'); const dc=e.target.closest('[data-del-class]');
    if(ai){ addItem(ai.dataset.addItem); }
    if(di){ delItem(di.dataset.delItem); }
    if(dc){ delClass(dc.dataset.delClass); }
  });
  document.getElementById('classContainer').addEventListener('change',e=>{
    const s=e.target.closest('[data-item-subj]'); const t=e.target.closest('[data-item-teacher]'); const h=e.target.closest('[data-item-hours]');
    if(s){ updateItem(s.dataset.itemSubj,'subjectId',s.value); }
    if(t){ updateItem(t.dataset.itemTeacher,'teacherId',t.value); }
    if(h){ updateItem(h.dataset.itemHours,'hours',h.value); }
  });

  // ----- Planning -----
  document.getElementById('planClassSelect').addEventListener('change',e=>{
    if(planMode==='class'){ state.currentClass=e.target.value; save(); }
    else { currentEntity=e.target.value; }
    renderPlan();
  });
  document.getElementById('genOneBtn').addEventListener('click',()=>{
    if(!state.currentClass){ toast('Aucune classe sélectionnée'); return; }
    const go=()=>{
      const r=generateClass(state.currentClass); renderPlan();
      toast(r.failed.length?`Généré — ${r.failed.length} matière(s) à vérifier`:'Emploi du temps généré');
    };
    if(planHasCourses(state.currentClass)){
      const c=byId(state.classes,state.currentClass);
      askConfirm({title:'Régénérer cette classe ?',text:`L'emploi du temps actuel de « ${c?c.name:''} » sera remplacé, y compris vos ajustements manuels. Une copie reste dans l'historique.`,okLabel:'Régénérer'},go);
    } else go();
  });
  document.getElementById('genAllBtn').addEventListener('click',()=>{
    if(!state.classes.length){ toast('Aucune classe'); return; }
    const go=()=>{
      state.plan={};
      state.classes.forEach(c=>generateClass(c.id));
      repairConflicts(8);
      renderPlan();
      const a=analyzePlan();
      toast(a.conflictList.length? `Généré — ${a.conflictList.length} conflit(s) à ajuster` : 'Toutes les classes générées sans conflit');
    };
    if(state.classes.some(c=>planHasCourses(c.id))){
      askConfirm({title:'Régénérer toutes les classes ?',text:'Tous les emplois du temps existants seront remplacés, y compris les ajustements faits à la main. Une copie reste dans l\'historique.',okLabel:'Tout régénérer'},go);
    } else go();
  });

  /* ---- outils de la version en ligne ---- */
  document.getElementById('saveNowBtn').addEventListener('click',async()=>{
    if(!DIRTY && !WRITING){ setSyncStatus('ok'); toast('Tout est déjà enregistré en ligne'); return; }
    setSyncStatus('saving');
    const ok=await flushNow();
    toast(ok?'Enregistré en ligne':'Enregistrement impossible pour le moment — nouvel essai automatique');
  });
  document.getElementById('historyBtn').addEventListener('click',openHistory);
  document.getElementById('historyClose').addEventListener('click',closeHistory);
  document.getElementById('historyModal').addEventListener('click',e=>{ if(e.target.id==='historyModal') closeHistory(); });
  document.getElementById('historyList').addEventListener('click',e=>{
    const b=e.target.closest('[data-restore]'); if(!b) return;
    const id=Number(b.dataset.restore), when=b.dataset.when||'';
    closeHistory();
    askConfirm({title:'Restaurer cette version ?',text:`Le planning sera remplacé par la version du ${when}. La version actuelle restera disponible dans l'historique.`,okLabel:'Restaurer',danger:false},()=>restoreVersion(id));
  });
  document.getElementById('logoutBtn').addEventListener('click',logout);
  document.getElementById('conflictServer').addEventListener('click',()=>resolveConflict('server'));
  document.getElementById('conflictMine').addEventListener('click',()=>resolveConflict('mine'));
  document.getElementById('sessionLogin').addEventListener('click',()=>window.open('/login','_blank'));
  document.getElementById('sessionRetry').addEventListener('click',()=>{
    SESSION_LOST=false;
    document.getElementById('sessionBar').style.display='none';
    if(DIRTY){ setSyncStatus('saving'); flush(); } else setSyncStatus('ok');
  });
  document.getElementById('excelViewBtn').addEventListener('click',()=>exportExcel('current'));
  document.getElementById('excelAllBtn').addEventListener('click',()=>exportExcel('full'));
  document.getElementById('clearPlanBtn').addEventListener('click',()=>{
    if(!state.currentClass)return;
    askConfirm({title:'Vider l\'emploi du temps ?',text:'Toutes les séances de cette classe seront retirées.',okLabel:'Vider'},()=>{
      state.plan[state.currentClass]=emptyGrid(); save(); renderPlan();
    });
  });
  document.getElementById('printPlanBtn').addEventListener('click',()=>window.print());

  // Sous-onglets de configuration
  document.querySelectorAll('.subtab').forEach(st=>{
    st.addEventListener('click',()=>{
      document.querySelectorAll('.subtab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.subview').forEach(x=>x.classList.remove('active'));
      st.classList.add('active');
      document.getElementById('sub-'+st.dataset.sub).classList.add('active');
      refreshIcons();
    });
  });

  // Modes du planning : classe / enseignant / matière
  document.querySelectorAll('.mode-btn').forEach(mb=>{
    mb.addEventListener('click',()=>{
      document.querySelectorAll('.mode-btn').forEach(x=>x.classList.remove('active'));
      mb.classList.add('active');
      planMode=mb.dataset.mode;
      currentEntity=null;
      renderPlan();
    });
  });

  // Modale de confirmation
  document.getElementById('confirmOk').addEventListener('click',()=>{
    const okBtn=document.getElementById('confirmOk');
    if(okBtn.classList.contains('danger-soft')) markCheckpoint('Avant : '+document.getElementById('confirmTitle').textContent);
    const cb=_confirmCb; closeConfirm(); if(cb) cb();
  });
  document.getElementById('confirmCancel').addEventListener('click',closeConfirm);
  document.getElementById('confirmModal').addEventListener('click',e=>{ if(e.target.id==='confirmModal') closeConfirm(); });

  // Modale d'ajout de séance
  document.getElementById('addCancel').addEventListener('click',closeAddModal);
  document.getElementById('addConfirm').addEventListener('click',confirmAddSession);
  document.getElementById('addModal').addEventListener('click',e=>{ if(e.target.id==='addModal') closeAddModal(); });
  document.getElementById('addSubjSel').addEventListener('change',syncAddTeacher);
  document.getElementById('addTeacherSel').addEventListener('change',checkAddWarn);
}

/* ----- Actions matières ----- */
function addSubject(){
  const name=document.getElementById('subjName').value.trim();
  const color=document.getElementById('subjColor').value;
  if(!name){ toast('Indiquez un nom de matière'); return; }
  state.subjects.push({id:uid('s'),name,color});
  document.getElementById('subjName').value='';
  save(); renderSubjects(); renderClasses();
}
function editSubject(id){ const s=byId(state.subjects,id); askRename(s.name,'Renommer la matière',(n)=>{ s.name=n; save(); renderSubjects(); renderClasses(); renderPlan(); }); }
function delSubject(id){
  askConfirm({title:'Supprimer la matière ?',text:'Elle sera retirée de toutes les classes qui l\'utilisent.',okLabel:'Supprimer'},()=>{
    state.subjects=state.subjects.filter(s=>s.id!==id);
    state.classes.forEach(c=>c.items=c.items.filter(it=>it.subjectId!==id));
    state.teachers.forEach(t=>{ t.subjectIds=(t.subjectIds||[]).filter(x=>x!==id); });
    save(); renderSubjects(); renderClasses();
  });
}

/* ----- Actions enseignants ----- */
function addTeacher(){
  const name=document.getElementById('teacherName').value.trim();
  const subjectIds=[...document.querySelectorAll('#teacherSubj .chip-opt.on')].map(b=>b.dataset.sid);
  if(!name){ toast('Indiquez un nom'); return; }
  if(!subjectIds.length){ toast('Choisissez au moins une matière enseignée'); return; }
  // par défaut : disponible sur tous les créneaux de cours
  const avail={}; DAYS.forEach(d=>{avail[d]={}; PERIODS.forEach((p,pi)=>{ if(isOpen(d,pi)) avail[d][pi]=true; });});
  state.teachers.push({id:uid('t'),name,subjectIds,avail});
  document.getElementById('teacherName').value='';
  document.querySelectorAll('#teacherSubj .chip-opt.on').forEach(b=>{ b.classList.remove('on'); b.setAttribute('aria-pressed','false'); });
  save(); renderTeachers(); renderClasses();
  toast('Enseignant ajouté');
}
function editTeacher(id){ const t=byId(state.teachers,id); askRename(t.name,'Renommer l\'enseignant',(n)=>{ t.name=n; save(); renderTeachers(); renderClasses(); renderPlan(); }); }
function changeTeacherSubject(id){
  const t=byId(state.teachers,id); if(!t) return;
  if(!state.subjects.length){ toast('Créez d\'abord une matière'); return; }
  _confirmCb=()=>{
    const ids=[...document.querySelectorAll('#subjPick .chip-opt.on')].map(b=>b.dataset.sid);
    if(!ids.length){ toast('Choisissez au moins une matière'); return; }
    t.subjectIds=ids;
    // retirer ce professeur des affectations de classe qui ne correspondent plus
    state.classes.forEach(c=>c.items.forEach(it=>{ if(it.teacherId===id && !ids.includes(it.subjectId)) it.teacherId=''; }));
    save(); renderTeachers(); renderClasses(); renderPlan();
    toast('Matières de '+t.name+' mises à jour');
  };
  document.getElementById('confirmTitle').textContent='Matières enseignées';
  document.getElementById('confirmText').innerHTML=
    `<span class="modal-sub">${esc(t.name)} — une ou plusieurs matières</span><span class="chip-select in-modal" id="subjPick">${
      state.subjects.map(s=>{ const on=teaches(t,s.id); return `<button type="button" class="chip-opt${on?' on':''}" data-sid="${s.id}" aria-pressed="${on}" style="--c:${s.color}"><span class="dot"></span>${esc(s.name)}</button>`; }).join('')
    }</span>`;
  const ok=document.getElementById('confirmOk'); ok.textContent='Enregistrer'; ok.className='btn primary';
  const icWrap=document.getElementById('confirmIc'); icWrap.className='m-ic info';
  icWrap.innerHTML=`<i data-lucide="book-open" class="ic"></i>`;
  document.getElementById('confirmModal').classList.add('show');
  refreshIcons();
}
function delTeacher(id){
  askConfirm({title:'Supprimer l\'enseignant ?',text:'Il sera retiré des matières où il est affecté.',okLabel:'Supprimer'},()=>{
    state.teachers=state.teachers.filter(t=>t.id!==id);
    state.classes.forEach(c=>c.items.forEach(it=>{ if(it.teacherId===id) it.teacherId=''; }));
    save(); renderTeachers(); renderClasses();
  });
}
function toggleAvail(id){
  const region=document.getElementById('avail-'+id);
  if(region.style.display==='none'){ renderAvailGrid(id); region.style.display='block'; }
  else region.style.display='none';
}
function flipAvail(key){
  const [id,day,pi]=key.split('|');
  const t=byId(state.teachers,id); t.avail[day] ||= {};
  t.avail[day][pi]=!t.avail[day][pi];
  save(); renderAvailGrid(id);
  // maj compteur
  const meta=document.querySelector(`#avail-${id}`).previousElementSibling;
}
function setAvailAll(id,val){
  const t=byId(state.teachers,id);
  DAYS.forEach(d=>{ t.avail[d] ||= {}; PERIODS.forEach((p,pi)=>{ if(isOpen(d,pi)) t.avail[d][pi]=val; }); });
  save(); renderAvailGrid(id); renderTeachers();
  // garder ouvert
  setTimeout(()=>{const r=document.getElementById('avail-'+id);if(r){renderAvailGrid(id);r.style.display='block';}},0);
}
function setAvailMorning(id){
  const t=byId(state.teachers,id);
  DAYS.forEach(d=>{ t.avail[d] ||= {}; PERIODS.forEach((p,pi)=>{
    if(!isOpen(d,pi)) return;
    // matin = avant le déjeuner
    const lunchIdx=PERIODS.findIndex(x=>x.type==='lunch');
    t.avail[d][pi]= pi<lunchIdx;
  });});
  save(); renderTeachers();
  setTimeout(()=>{const r=document.getElementById('avail-'+id);if(r){renderAvailGrid(id);r.style.display='block';}},0);
}

/* ----- Actions classes ----- */
function addClass(){
  const name=document.getElementById('className').value.trim();
  if(!name){ toast('Indiquez un nom de classe'); return; }
  const c={id:uid('c'),name,items:[]};
  state.classes.push(c);
  state.currentClass ||= c.id;
  document.getElementById('className').value='';
  save(); renderClasses(); renderPlanSelect();
}
function delClass(id){
  const c=byId(state.classes,id);
  askConfirm({title:'Supprimer la classe ?',text:`« ${c?c.name:''} » et son emploi du temps seront supprimés.`,okLabel:'Supprimer'},()=>{
    state.classes=state.classes.filter(c=>c.id!==id);
    delete state.plan[id];
    if(state.currentClass===id) state.currentClass=state.classes[0]?.id||null;
    save(); renderClasses(); renderPlanSelect();
  });
}
function addItem(classId){
  const c=byId(state.classes,classId);
  c.items.push({subjectId:'',teacherId:'',hours:''});
  save(); renderClasses();
}
function delItem(key){
  const [classId,idx]=key.split('|');
  const c=byId(state.classes,classId);
  c.items.splice(+idx,1); save(); renderClasses();
}
function updateItem(key,field,val){
  const [classId,idx]=key.split('|');
  const c=byId(state.classes,classId);
  const item=c.items[+idx];
  item[field]= field==='hours'? (val===''?'':Math.max(0,+val)) : val;
  if(field==='subjectId'){
    // si le prof actuel n'enseigne pas la nouvelle matière, on le retire
    const t=item.teacherId?byId(state.teachers,item.teacherId):null;
    if(!t || !teaches(t,item.subjectId)) item.teacherId='';
    save(); renderClasses(); return;
  }
  save();
  if(field==='hours') renderClasses(); // maj total
}


/* Une classe a-t-elle déjà des séances placées ? */
function planHasCourses(classId){
  const g = state.plan && state.plan[classId];
  if(!g) return false;
  return DAYS.some(d => (g[d]||[]).some(cell => cell));
}

/* =================================================================
   HISTORIQUE DES VERSIONS
   ================================================================= */
function fmtWhen(iso){
  try{ return new Date(iso).toLocaleString('fr-FR',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
  catch(e){ return String(iso); }
}
function closeHistory(){ document.getElementById('historyModal').classList.remove('show'); }
async function openHistory(){
  const list = document.getElementById('historyList');
  list.innerHTML = '<p class="hist-empty">Chargement…</p>';
  document.getElementById('historyModal').classList.add('show');
  try{
    const j = await api('GET', API + '/history');
    if(!j.versions || !j.versions.length){
      list.innerHTML = '<p class="hist-empty">Aucune version enregistrée pour le moment.<br>Elles apparaissent au fil des modifications.</p>';
      return;
    }
    list.innerHTML = j.versions.map(v => {
      const when = fmtWhen(v.savedAt);
      return '<div class="hist-row"><div class="hist-info">' +
        '<strong>' + esc(when) + '</strong>' +
        '<span>' + esc(v.note || '') + '</span>' +
        '<small>' + v.classes + ' classes · ' + v.teachers + ' enseignants · ' + v.subjects + ' matières</small>' +
        '</div><button class="btn" type="button" data-restore="' + v.id + '" data-when="' + esc(when) + '">Restaurer</button></div>';
    }).join('');
  }catch(e){
    if(e.status === 401){ closeHistory(); sessionLost(); return; }
    list.innerHTML = '<p class="hist-empty">Impossible de charger l\'historique. Vérifiez la connexion puis réessayez.</p>';
  }
}
async function restoreVersion(id){
  const ok = await flushNow();
  if(!ok && (DIRTY || CONFLICT || SESSION_LOST)){ toast('Enregistrement en attente — réessayez dans un instant'); return; }
  setSyncStatus('saving');
  try{
    const j = await api('POST', API + '/history', { id: id });
    state = j.data; normalizeState(); REV = Number(j.rev); DIRTY = false;
    renderAll(); setSyncStatus('ok');
    toast('Version restaurée');
  }catch(e){
    if(e.status === 401){ sessionLost(); return; }
    setSyncStatus('ok');
    toast('Restauration impossible, réessayez');
  }
}

/* =================================================================
   DÉCONNEXION
   ================================================================= */
async function doLogout(){
  try{ await fetch('/api/auth/logout', { method:'POST', credentials:'same-origin' }); }catch(e){}
  DIRTY = false;
  window.location.replace('/login');
}
async function logout(){
  if(DIRTY || WRITING){
    setSyncStatus('saving');
    const ok = await flushNow();
    if(!ok){
      askConfirm({title:'Modifications non enregistrées',text:'Certaines modifications n\'ont pas pu être enregistrées. Se déconnecter quand même ?',okLabel:'Se déconnecter'},doLogout);
      return;
    }
  }
  doLogout();
}

/* =================================================================
   DÉMARRAGE
   Rien n'est modifiable tant que le planning n'a pas été lu sur le
   serveur : on ne risque jamais d'écraser les données en ligne.
   ================================================================= */
function bootShow(msg){
  document.getElementById('bootMsg').textContent = msg;
  document.getElementById('bootSpin').style.display = 'block';
  document.getElementById('bootError').style.display = 'none';
  document.getElementById('bootRetry').style.display = 'none';
}
function bootFail(msg){
  document.getElementById('bootSpin').style.display = 'none';
  document.getElementById('bootMsg').textContent = 'Le planning n\'a pas pu être chargé.';
  const err = document.getElementById('bootError');
  err.textContent = msg; err.style.display = 'block';
  const btn = document.getElementById('bootRetry');
  btn.style.display = 'inline-flex';
  return new Promise(resolve => { btn.onclick = () => { btn.onclick = null; resolve(); }; });
}

/* =================================================================
   ÉTABLISSEMENT : ANNÉE SCOLAIRE, HORAIRES, PARCOURS GUIDÉ
   ================================================================= */
function defaultSchoolYear(){
  const d=new Date(); const y=d.getMonth()>=7 ? d.getFullYear() : d.getFullYear()-1;   // l'année commence en septembre
  return y+'-'+(y+1);
}
function schoolYear(){ return (state.settings && state.settings.schoolYear) || defaultSchoolYear(); }
function schoolYearLabel(){ return schoolYear().replace('-', '–'); }
function teaches(t, sid){ return !!t && Array.isArray(t.subjectIds) && t.subjectIds.includes(sid); }
function teacherSubjects(t){ return (t.subjectIds||[]).map(id=>byId(state.subjects,id)).filter(Boolean); }

function periodMinutes(label){
  const m=String(label).match(/(\d{1,2})h(\d{2})\s*[–-]\s*(\d{1,2})h(\d{2})/);
  return m ? (+m[3]*60 + +m[4]) - (+m[1]*60 + +m[2]) : 0;
}
function fmtDuration(min){
  if(min>=60){ const h=Math.floor(min/60), r=min%60; return h+' h'+(r?' '+String(r).padStart(2,'0'):''); }
  return min+' min';
}

function renderSchool(){
  const yp=document.getElementById('yearPicker');
  if(yp){
    const cur=schoolYear(), base=+defaultSchoolYear().slice(0,4);
    const years=[]; for(let y=base-1; y<=base+2; y++) years.push(y+'-'+(y+1));
    if(!years.includes(cur)) years.push(cur);
    years.sort();
    yp.innerHTML=years.map(y=>{
      const on=y===cur, s=+y.slice(0,4);
      const tag= on ? 'Appliquée partout' : s===base ? 'Année en cours' : s<base ? 'Année précédente' : 'À venir';
      return `<button type="button" class="year-opt${on?' on':''}" data-year="${y}" aria-pressed="${on}">${y.replace('-','–')}<small>${tag}</small></button>`;
    }).join('');
  }
  const tl=document.getElementById('dayTimeline');
  if(tl){
    tl.innerHTML=PERIODS.map(p=>{
      const kind = p.type==='course' ? 'Cours' : p.type==='break' ? 'Pause' : 'Pause déjeuner';
      return `<div class="tl-row${p.type==='course'?'':' pause'}"><span class="tl-time">${esc(p.label)}</span><span class="tl-kind">${kind}</span><span class="tl-dur">${fmtDuration(periodMinutes(p.label))}</span></div>`;
    }).join('');
  }
  refreshOverview();
}

/* Compteurs des onglets et étapes de mise en place : mis à jour à chaque modification */
function refreshOverview(){
  const set=(id,n)=>{ const el=document.getElementById(id); if(el) el.textContent=n; };
  set('cnt-subjects', state.subjects.length);
  set('cnt-teachers', state.teachers.length);
  set('cnt-classes', state.classes.length);
  const box=document.getElementById('setupSteps'); if(!box) return;
  const S=state.subjects.length, T=state.teachers.length, C=state.classes.length;
  const gen=state.classes.filter(c=>planHasCourses(c.id)).length;
  const noSubj=state.teachers.filter(t=>!(t.subjectIds||[]).length).length;
  const pl=(n,w)=>n+' '+w+(n>1?'s':'');
  const steps=[
    {n:1, t:'Matières', sub: S ? pl(S,'matière') : 'Ajoutez les matières enseignées', done:S>0, go:'subjects'},
    {n:2, t:'Enseignants', sub: T ? pl(T,'enseignant')+(noSubj?' · '+noSubj+' sans matière':'') : 'Ajoutez les enseignants et leurs matières', done:T>0 && !noSubj, go:'teachers'},
    {n:3, t:'Classes', sub: C ? pl(C,'classe')+' · heures et enseignants' : 'Créez les classes', done:C>0, go:'classes'},
    {n:4, t:'Emplois du temps', sub: C ? gen+' / '+C+' classes générées' : 'Générez les emplois du temps', done:C>0 && gen===C, view:'planning'}
  ];
  const todo=steps.findIndex(s=>!s.done);
  box.innerHTML=steps.map((s,i)=>`<button type="button" class="step-card${s.done?' done':''}${i===todo?' next':''}" ${s.go?`data-goto="${s.go}"`:`data-goto-view="${s.view}"`}>`+
    `<span class="sc-top"><span class="sc-num">${s.done?'✓':s.n}</span><span class="sc-title">${s.t}</span>${i===todo?'<span class="sc-badge">À faire</span>':''}</span>`+
    `<span class="sc-sub">${esc(s.sub)}</span><span class="sc-go">${i===todo?(s.go?'Commencer →':'Générer maintenant →'):(s.go?'Voir et modifier →':'Ouvrir →')}</span></button>`).join('');
}

function setSchoolYear(y){
  if(!/^\d{4}-\d{4}$/.test(y) || y===schoolYear()) return;
  state.settings ||= {};
  state.settings.schoolYear=y;
  save(); renderSchool(); renderPlan();
  toast('Année scolaire '+y.replace('-','–')+' appliquée à tous les emplois du temps');
}

function initUX(){
  // bouton « étape suivante » en bas de chaque section
  const next={ 'sub-school':['subjects','Étape suivante : Matières'], 'sub-subjects':['teachers','Étape suivante : Enseignants'], 'sub-teachers':['classes','Étape suivante : Classes'] };
  Object.entries(next).forEach(([id,[go,label]])=>{
    const sv=document.getElementById(id); if(!sv || sv.querySelector('.next-step')) return;
    sv.insertAdjacentHTML('beforeend',`<div class="next-step"><button type="button" class="btn" data-goto="${go}">${label} <i data-lucide="arrow-right" class="ic"></i></button></div>`);
  });
  const sc=document.getElementById('sub-classes');
  if(sc && !sc.querySelector('.next-step'))
    sc.insertAdjacentHTML('beforeend','<div class="next-step"><button type="button" class="btn primary" data-goto-view="planning">Passer aux emplois du temps <i data-lucide="arrow-right" class="ic"></i></button></div>');

  document.addEventListener('click',e=>{
    const chip=e.target.closest('.chip-opt');
    if(chip){ chip.classList.toggle('on'); chip.setAttribute('aria-pressed', chip.classList.contains('on')); return; }
    const g=e.target.closest('[data-goto]');
    if(g){ const tab=document.querySelector(`.subtab[data-sub="${g.dataset.goto}"]`); if(tab){ tab.click(); window.scrollTo({top:0,behavior:'smooth'}); } return; }
    const gv=e.target.closest('[data-goto-view]');
    if(gv){ const nav=document.querySelector(`.nav-item[data-view="${gv.dataset.gotoView}"]`); if(nav){ nav.click(); window.scrollTo({top:0,behavior:'smooth'}); } return; }
    const y=e.target.closest('[data-year]');
    if(y) setSchoolYear(y.dataset.year);
  });
  refreshIcons();
}

/* Année scolaire affichée sur le titre du planning et à l'impression */
function decoratePlanTitle(){
  const t=document.getElementById('planTitle');
  if(t && !t.querySelector('.year-chip')) t.insertAdjacentHTML('beforeend','<span class="year-chip">'+esc(schoolYearLabel())+'</span>');
  const py=document.getElementById('printYear');
  if(py) py.innerHTML='El Jadida<br>Année scolaire '+esc(schoolYearLabel());
}
const __renderPlanBase = renderPlan;
renderPlan = function(){ __renderPlanBase(); decoratePlanTitle(); };


/* ---------- Grille : pauses et créneaux fermés ---------- */
function pauseCellHTML(p){
  const lunch = p.type==='lunch';
  return `<td class="slot pause pause-${lunch?'lunch':'break'}" rowspan="${DAYS.length}"><div class="pause-inner">`+
    `<i data-lucide="${lunch?'utensils':'coffee'}" class="ic"></i>`+
    `<span class="pause-lbl">${lunch?'Déjeuner':'Pause'}</span>`+
    `<span class="pause-dur">${fmtDuration(periodMinutes(p.label))}</span></div></td>`;
}
/* Nombre de créneaux fermés consécutifs à partir de pi (0 s'il est déjà couvert) */
function closedSpan(day, pi){
  const closedAt = i => !!PERIODS[i] && PERIODS[i].type==='course' && !isOpen(day, i);
  if(closedAt(pi-1)) return 0;
  let n = 1; while(closedAt(pi+n)) n++;
  return n;
}

/* =================================================================
   EXPORT EXCEL (.xlsx)
   Logo de l'école en tête de chaque feuille, couleurs des matières,
   pauses mises en valeur, A4 paysage prêt à imprimer.
   La bibliothèque n'est chargée qu'au premier export.
   ================================================================= */
let EXCEL_LIB = null;
function loadExcelLib(){
  if(window.ExcelJS) return Promise.resolve();
  if(!EXCEL_LIB){
    EXCEL_LIB = new Promise((resolve, reject)=>{
      const s=document.createElement('script');
      s.src='/vendor/exceljs.min.js?v=4.4.0';
      s.onload=()=>resolve();
      s.onerror=()=>{ EXCEL_LIB=null; reject(new Error('chargement')); };
      document.head.appendChild(s);
    });
  }
  return EXCEL_LIB;
}

let XL_LOGO = null;
async function xlLogo(){
  if(XL_LOGO) return XL_LOGO;
  try{
    const r = await fetch('/brand/logo-excel.png', { cache:'force-cache' });
    if(!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for(let i=0; i<bytes.length; i+=0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i+0x8000));
    XL_LOGO = 'data:image/png;base64,' + btoa(bin);
    return XL_LOGO;
  }catch(e){ return null; }
}

const XL_FONT = 'Calibri';
const XL = {
  navy:'FF1B2A56', navySoft:'FFEEF2FF', line:'FFD5DBE7', ink:'FF1F2433', grayText:'FF8A93A6', white:'FFFFFFFF',
  gold:'FFF5B301', zebra:'FFF8FAFC', closed:'FFF1F5F9', closedText:'FF94A3B8', link:'FF1E3A8A',
  pause:{ fill:'FFFEF3C7', text:'FF92400E', line:'FFFDE68A', head:'FFFCD34D' },
  lunch:{ fill:'FFFFEDD5', text:'FF9A3412', line:'FFFED7AA', head:'FFFDBA74' }
};
const xlSolid = argb => ({ type:'pattern', pattern:'solid', fgColor:{ argb } });
const xlBorder = argb => ({ top:{style:'thin',color:{argb}}, left:{style:'thin',color:{argb}}, bottom:{style:'thin',color:{argb}}, right:{style:'thin',color:{argb}} });
const XL_BORDER = xlBorder(XL.line);

function xlArgb(hex){ const v=String(hex||'#888888').replace('#','').toUpperCase(); return 'FF'+(/^[0-9A-F]{6}$/.test(v)?v:'888888'); }
function xlTextOn(hex){
  const v=String(hex||'').replace('#','');
  if(!/^[0-9a-fA-F]{6}$/.test(v)) return XL.white;
  const L=(0.299*parseInt(v.slice(0,2),16)+0.587*parseInt(v.slice(2,4),16)+0.114*parseInt(v.slice(4,6),16))/255;
  return L>0.62 ? XL.ink : XL.white;
}
function xlSheetName(name, used){
  let n=String(name).replace(/[\\\/\?\*\[\]:]/g,' ').replace(/\s+/g,' ').trim().slice(0,31) || 'Feuille';
  const base=n; let i=2;
  while(used.has(n.toLowerCase())){ const suf=' ('+i+')'; n=base.slice(0,31-suf.length)+suf; i++; }
  used.add(n.toLowerCase());
  return n;
}
function xlFileSafe(s){ return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }

function xlCellsClass(classId){
  const grid = state.plan[classId] || emptyGrid();
  return (day, pi)=>{
    const cell = grid[day] && grid[day][pi];
    if(!cell) return null;
    const s = byId(state.subjects, cell.subjectId);
    const t = cell.teacherId ? byId(state.teachers, cell.teacherId) : null;
    return { lines:[ s ? s.name : '?', t ? t.name : '—' ], color: s ? s.color : '#888888' };
  };
}
function xlCellsEntity(entityId, mode){   // mode : 'teacher' ou 'subject'
  const map = {};
  state.classes.forEach(c=>{
    const grid = state.plan[c.id]; if(!grid) return;
    DAYS.forEach(day=>PERIODS.forEach((p, pi)=>{
      const cell = grid[day] && grid[day][pi]; if(!cell) return;
      if(mode==='teacher' ? cell.teacherId!==entityId : cell.subjectId!==entityId) return;
      const s = byId(state.subjects, cell.subjectId);
      const t = cell.teacherId ? byId(state.teachers, cell.teacherId) : null;
      (map[day+'|'+pi] ||= []).push({ cls:c.name, other: mode==='teacher' ? (s?s.name:'?') : (t?t.name:'—'), color: s?s.color:'#888888' });
    }));
  });
  return (day, pi)=>{
    const list = map[day+'|'+pi];
    if(!list || !list.length) return null;
    return { lines:[ list.map(x=>x.cls).join(' + '), ...list.map(x=>x.other) ], color:list[0].color };
  };
}
function xlCountHours(fn){
  let n=0; DAYS.forEach(d=>PERIODS.forEach((p,pi)=>{ if(p.type==='course' && isOpen(d,pi) && fn(d,pi)) n++; })); return n;
}

/* En-tête de marque : logo à gauche, titre, établissement, année, filet doré */
function xlBrandHeader(ws, nCols, title, line3, logoId){
  ws.getRow(1).height = 27; ws.getRow(2).height = 17; ws.getRow(3).height = 19; ws.getRow(4).height = 9;
  const put = (r, value, font)=>{
    ws.mergeCells(r, 2, r, nCols);
    const c = ws.getCell(r, 2); c.value = value; c.font = font; c.alignment = { vertical:'middle', horizontal:'left' };
  };
  put(1, title, { name:XL_FONT, size:18, bold:true, color:{argb:XL.navy} });
  put(2, 'Académie Georges Claude · Private Academy · El Jadida', { name:XL_FONT, size:10, color:{argb:XL.grayText} });
  put(3, line3, { name:XL_FONT, size:11, bold:true, color:{argb:XL.navy} });
  for(let c=1; c<=nCols; c++) ws.getCell(4, c).border = { bottom:{ style:'medium', color:{ argb:XL.gold } } };
  if(logoId !== null && logoId !== undefined)
    ws.addImage(logoId, { tl:{ col:0.16, row:0.1 }, ext:{ width:68, height:68 }, editAs:'oneCell' });
}

function xlTimetable(wb, sheetName, title, getCell, logoId){
  const nCols = 1 + PERIODS.length;
  const H = 6, first = H + 1, last = H + DAYS.length;   // ligne 5 : respiration sous le filet doré
  const ws = wb.addWorksheet(sheetName, {
    properties:{ tabColor:{ argb:XL.navy } },
    views:[{ state:'frozen', xSplit:1, ySplit:H, showGridLines:false }],
    pageSetup:{ paperSize:9, orientation:'landscape', fitToPage:true, fitToWidth:1, fitToHeight:1, horizontalCentered:true,
                margins:{ left:0.3, right:0.3, top:0.4, bottom:0.45, header:0.2, footer:0.2 } }
  });
  ws.headerFooter.oddFooter = '&L&8Planning AGC — Académie Georges Claude&C&8Année scolaire '+schoolYearLabel()+'&R&8Page &P / &N';
  ws.columns = [{ width:14 }].concat(PERIODS.map(p=>({ width: p.type==='course' ? 21 : 9 })));
  xlBrandHeader(ws, nCols, title, 'Année scolaire ' + schoolYearLabel(), logoId);
  ws.getRow(5).height = 9;

  // en-tête du tableau
  const hr = ws.getRow(H); hr.height = 38;
  const h0 = hr.getCell(1); h0.value = 'Jour';
  h0.font = { name:XL_FONT, size:10, bold:true, color:{argb:XL.white} }; h0.fill = xlSolid(XL.navy);
  h0.alignment = { vertical:'middle', horizontal:'center' }; h0.border = XL_BORDER;
  PERIODS.forEach((p, pi)=>{
    const c = hr.getCell(pi+2);
    c.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    if(p.type === 'course'){
      c.value = p.label;
      c.font = { name:XL_FONT, size:10, bold:true, color:{argb:XL.white} };
      c.fill = xlSolid(XL.navy); c.border = XL_BORDER;
    }else{
      const k = p.type === 'lunch' ? XL.lunch : XL.pause;
      c.value = p.label.replace(' – ', '\n');
      c.font = { name:XL_FONT, size:9, bold:true, color:{argb:k.text} };
      c.fill = xlSolid(k.head); c.border = xlBorder(k.line);
    }
  });

  // jours et séances
  DAYS.forEach((day, di)=>{
    const row = ws.getRow(first + di); row.height = 60;
    const dc = row.getCell(1); dc.value = day;
    dc.font = { name:XL_FONT, size:11, bold:true, color:{argb:XL.navy} };
    dc.fill = xlSolid(XL.navySoft); dc.alignment = { vertical:'middle', horizontal:'center' }; dc.border = XL_BORDER;
    PERIODS.forEach((p, pi)=>{
      if(p.type !== 'course' || !isOpen(day, pi)) return;   // traités à part (cellules fusionnées)
      const c = row.getCell(pi+2);
      c.border = XL_BORDER; c.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
      const v = getCell(day, pi);
      if(!v){ c.fill = xlSolid(XL.white); return; }
      const fg = xlTextOn(v.color);
      c.fill = xlSolid(xlArgb(v.color));
      c.value = { richText:[{ text:v.lines[0], font:{ name:XL_FONT, size:10, bold:true, color:{argb:fg} } }]
        .concat(v.lines.slice(1).map(l=>({ text:'\n'+l, font:{ name:XL_FONT, size:9, color:{argb:fg} } }))) };
    });
  });

  // pauses : une colonne unique sur toute la semaine
  PERIODS.forEach((p, pi)=>{
    if(p.type === 'course') return;
    const k = p.type === 'lunch' ? XL.lunch : XL.pause;
    for(let r=first; r<=last; r++){ const c = ws.getCell(r, pi+2); c.fill = xlSolid(k.fill); c.border = xlBorder(k.line); }
    const c = ws.getCell(first, pi+2);
    c.value = (p.type === 'lunch' ? 'DÉJEUNER' : 'PAUSE') + '  ·  ' + fmtDuration(periodMinutes(p.label));
    c.font = { name:XL_FONT, size:10, bold:true, color:{argb:k.text} };
    c.alignment = { vertical:'middle', horizontal:'center', textRotation:90 };
    ws.mergeCells(first, pi+2, last, pi+2);
  });

  // créneaux fermés consécutifs (vendredi après-midi) : une seule case
  DAYS.forEach((day, di)=>{
    const r = first + di;
    let start = null, stop = null;
    const close = ()=>{
      if(start === null) return;
      for(let pi=start; pi<=stop; pi++){ const c = ws.getCell(r, pi+2); c.fill = xlSolid(XL.closed); c.border = XL_BORDER; }
      const c = ws.getCell(r, start+2);
      c.value = stop > start ? 'Pas de cours' : '—';
      c.font = { name:XL_FONT, size:10, italic:true, color:{argb:XL.closedText} };
      c.alignment = { vertical:'middle', horizontal:'center' };
      if(stop > start) ws.mergeCells(r, start+2, r, stop+2);
      start = null;
    };
    PERIODS.forEach((p, pi)=>{
      if(p.type === 'course' && !isOpen(day, pi)){ if(start === null) start = pi; stop = pi; }
      else close();
    });
    close();
  });

  // pied de tableau
  const hours = xlCountHours(getCell);
  const brk = PERIODS.find(p=>p.type==='break'), lun = PERIODS.find(p=>p.type==='lunch');
  const fr = last + 2;
  ws.mergeCells(fr, 1, fr, nCols);
  const fc = ws.getCell(fr, 1);
  fc.value = hours + ' heure' + (hours>1?'s':'') + ' de cours par semaine'
    + (brk ? '   ·   Pause ' + brk.label : '') + (lun ? '   ·   Déjeuner ' + lun.label : '')
    + '   ·   Vendredi : cours le matin uniquement';
  fc.font = { name:XL_FONT, size:9.5, italic:true, color:{argb:XL.grayText} };
  return hours;
}

async function exportExcel(scope){
  toast('Préparation du fichier Excel…');
  try{ await loadExcelLib(); }
  catch(e){ toast('Module Excel indisponible — vérifiez la connexion puis réessayez'); return; }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Planning AGC'; wb.company = 'Académie Georges Claude'; wb.created = new Date();
  const logoData = await xlLogo();
  const logoId = logoData ? wb.addImage({ base64:logoData, extension:'png' }) : null;
  const used = new Set();
  const year = schoolYear();
  let fileName, count = 0;

  if(scope === 'full'){
    const idxName = xlSheetName('Sommaire', used);
    const classes = state.classes.map(c=>({ c, name:xlSheetName(c.name, used), fn:xlCellsClass(c.id) }));
    const teachers = state.teachers
      .map(t=>({ t, fn:xlCellsEntity(t.id,'teacher') }))
      .filter(x=>xlCountHours(x.fn) > 0)
      .map(x=>({ ...x, name:xlSheetName('Prof - '+x.t.name, used) }));

    const idx = wb.addWorksheet(idxName, {
      properties:{ tabColor:{ argb:XL.gold } },
      views:[{ state:'frozen', ySplit:6, showGridLines:false }],
      pageSetup:{ paperSize:9, orientation:'portrait', fitToPage:true, fitToWidth:1, fitToHeight:0, horizontalCentered:true,
                  margins:{ left:0.4, right:0.4, top:0.5, bottom:0.5, header:0.2, footer:0.2 } }
    });
    idx.headerFooter.oddFooter = '&L&8Planning AGC — Académie Georges Claude&R&8Page &P / &N';
    idx.columns = [{ width:13 }, { width:15 }, { width:38 }, { width:18 }, { width:14 }];
    xlBrandHeader(idx, 5, 'Emplois du temps', 'Année scolaire ' + schoolYearLabel() + '  ·  généré le ' + new Date().toLocaleDateString('fr-FR'), logoId);
    idx.getRow(5).height = 10;

    const head = idx.getRow(6); head.height = 26;
    ['Type', 'Nom', 'Heures / semaine', 'Feuille'].forEach((v, i)=>{
      const c = head.getCell(i+2); c.value = v;
      c.font = { name:XL_FONT, size:10, bold:true, color:{argb:XL.white} };
      c.fill = xlSolid(XL.navy); c.border = XL_BORDER;
      c.alignment = { vertical:'middle', horizontal: i===1 ? 'left' : 'center', indent: i===1 ? 1 : 0 };
    });
    let r = 7;
    const line = (type, name, hours, sheet)=>{
      const row = idx.getRow(r); row.height = 22;
      const zebra = (r % 2 === 0);
      const cells = [row.getCell(2), row.getCell(3), row.getCell(4), row.getCell(5)];
      cells.forEach(c=>{ c.border = XL_BORDER; c.fill = xlSolid(zebra ? XL.zebra : XL.white); c.alignment = { vertical:'middle', horizontal:'center' }; });
      const isClass = type === 'Classe';
      cells[0].value = type;
      cells[0].fill = xlSolid(isClass ? XL.navySoft : XL.pause.fill);
      cells[0].font = { name:XL_FONT, size:10, bold:true, color:{argb: isClass ? XL.navy : XL.pause.text} };
      cells[1].value = name;
      cells[1].font = { name:XL_FONT, size:10.5, bold:true, color:{argb:XL.ink} };
      cells[1].alignment = { vertical:'middle', horizontal:'left', indent:1 };
      cells[2].value = hours;
      cells[2].font = { name:XL_FONT, size:10, color:{argb:XL.ink} };
      cells[3].value = { text:'Ouvrir  →', hyperlink:"#'" + sheet.replace(/'/g, "''") + "'!A1" };
      cells[3].font = { name:XL_FONT, size:10, bold:true, color:{argb:XL.link}, underline:true };
      r++;
    };
    classes.forEach(x=>line('Classe', x.c.name, xlCountHours(x.fn), x.name));
    teachers.forEach(x=>line('Enseignant', x.t.name, xlCountHours(x.fn), x.name));

    classes.forEach(x=>{ xlTimetable(wb, x.name, 'Emploi du temps — ' + x.c.name, x.fn, logoId); count++; });
    teachers.forEach(x=>{ xlTimetable(wb, x.name, 'Emploi du temps — ' + x.t.name, x.fn, logoId); count++; });
    fileName = 'Emplois-du-temps-AGC-' + year + '.xlsx';
  }else{
    let ent, title, fn;
    if(planMode === 'class'){
      ent = byId(state.classes, state.currentClass);
      if(!ent){ toast('Aucune classe sélectionnée'); return; }
      title = 'Emploi du temps — ' + ent.name; fn = xlCellsClass(ent.id);
    }else if(planMode === 'teacher'){
      ent = byId(state.teachers, currentEntity);
      if(!ent){ toast('Aucun enseignant sélectionné'); return; }
      title = 'Emploi du temps — ' + ent.name; fn = xlCellsEntity(ent.id, 'teacher');
    }else{
      ent = byId(state.subjects, currentEntity);
      if(!ent){ toast('Aucune matière sélectionnée'); return; }
      title = 'Matière — ' + ent.name; fn = xlCellsEntity(ent.id, 'subject');
    }
    xlTimetable(wb, xlSheetName(ent.name, used), title, fn, logoId); count = 1;
    fileName = 'Emploi-du-temps-' + xlFileSafe(ent.name) + '-' + year + '.xlsx';
  }

  try{
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fileName;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast(count > 1 ? count + ' emplois du temps exportés dans Excel' : 'Fichier Excel téléchargé');
  }catch(e){
    toast('Export impossible : ' + (e && e.message ? e.message : 'erreur'));
  }
}

/* ---------- INIT ---------- */
async function boot(){
  refreshIcons();
  setSyncStatus('loading');
  bootShow('Chargement du planning…');
  let j = null;
  for(;;){
    try{ j = await api('GET', API); break; }
    catch(e){
      if(e.status === 401){ window.location.replace('/login'); return; }
      const msg = e.status === 503 ? 'La base de données n\'est pas configurée sur le serveur (variable DATABASE_URL).'
                : e.status === 0   ? 'Connexion au serveur impossible. Vérifiez votre accès à Internet.'
                : 'Le serveur a rencontré une erreur (code ' + e.status + ').';
      await bootFail(msg);
      bootShow('Nouvelle tentative…');
    }
  }

  REV = Number(j.rev || 0);
  BOOTED = true;
  if(j.data){ state = j.data; normalizeState(); }
  else{
    // Base vide, confirmée par le serveur : premier lancement
    normalizeState();
    seedAGC();                      // pré-remplit et enregistre en ligne
  }
  renderAll();
  bind();
  initUX();
  refreshIcons();
  if(!DIRTY) setSyncStatus('ok');
  document.getElementById('bootScreen').classList.add('hide');

  setInterval(watchServer, 30000);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) watchServer(); });
  window.addEventListener('online', ()=>{ if(DIRTY){ clearTimeout(RETRY_TIMER); RETRY_TIMER = null; flush(); } });
  window.addEventListener('beforeunload', e=>{
    if(DIRTY || WRITING){ e.preventDefault(); e.returnValue = ''; }
  });
}
boot();
