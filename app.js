/* =================================================================
   PLANNING AGC — Système de gestion d'emploi du temps
   ================================================================= */

/* ---------- GRILLE HORAIRE (chaque case = 1 heure comptée) ---------- */
const DAYS = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi"];

// Définition des créneaux. type: 'course' = heure de cours comptée,
// 'break' = pause (non comptée), 'lunch' = déjeuner (non comptée)
const PERIODS = [
  {label:"08h30 – 09h30", type:"course"},
  {label:"09h30 – 10h30", type:"course"},
  {label:"10h30 – 10h45", type:"break"},
  {label:"10h45 – 11h30", type:"course"},
  {label:"11h30 – 12h30", type:"course"},
  {label:"12h30 – 13h30", type:"lunch"},
  {label:"13h30 – 14h30", type:"course"},
  {label:"14h30 – 15h30", type:"course"},
  {label:"15h30 – 16h30", type:"course"},
];
// Index des créneaux de cours réels
const COURSE_PERIODS = PERIODS.map((p,i)=>({...p,idx:i})).filter(p=>p.type==="course");

// Le vendredi : matin uniquement (4 cases) -> on ferme l'après-midi
const FRIDAY_CLOSED_FROM = "13h30 – 14h30"; // tout ce qui suit ce label le vendredi est fermé
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
const STORAGE_KEY = "planning_agc_v2";
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
   STOCKAGE SERVEUR
   Les donnees vivent sur le serveur (Vercel Blob) et sont partagees
   par tous les postes qui se connectent avec le meme compte.
   Une copie locale sert de secours si le reseau tombe.
   ================================================================= */
const API = '/api/planning';

let AUTH    = '';     // identifiants encodes, envoyes a chaque appel
let SERVER  = false;  // true si le serveur repond
let REV     = 0;      // revision serveur connue de ce poste
let STAMP   = '';     // empreinte du fichier distant (veille)
let DIRTY   = false;  // des modifications locales ne sont pas encore enregistrees
let WRITING = false;  // une ecriture est en cours
let AGAIN   = false;  // une autre ecriture attend
let SAVE_TIMER = null;

function authHeaders(extra){
  const h = { 'x-agc-auth': AUTH };
  if(extra) Object.assign(h, extra);
  return h;
}

/* ---------- Indicateur de synchronisation ---------- */
function setSyncStatus(kind){
  const el = document.getElementById('syncStatus');
  if(!el) return;
  const map = {
    saving  : ['refresh-cw',   'Enregistrement...',     'wait'],
    ok      : ['cloud-check',  'Enregistre sur le serveur', 'ok'],
    error   : ['cloud-off',    'Serveur injoignable',   'bad'],
    local   : ['hard-drive',   'Mode local (non partage)', 'bad'],
    conflict: ['alert-circle', 'Conflit a regler',      'bad']
  };
  const [icon, label, cls] = map[kind] || map.ok;
  el.className = 'sync ' + cls;
  el.innerHTML = '<i data-lucide="'+icon+'" class="ic"></i><span>'+label+'</span>';
  refreshIcons();
}

function normalizeState(){
  state.subjects ||= []; state.teachers ||= []; state.classes ||= []; state.plan ||= {};
  if(!state.currentClass && state.classes[0]) state.currentClass = state.classes[0].id;
}

function renderAll(){
  renderSubjects(); renderTeachers(); renderClasses(); renderPlanSelect();
  try{ renderPlan(); }catch(e){}
}

/* ---------- Lecture ---------- */
async function serverRead(){
  const r = await fetch(API, { headers: authHeaders(), cache: 'no-store' });
  if(!r.ok) throw new Error('http ' + r.status);
  return r.json();   // { ok, data, rev, stamp }
}

/* ---------- Ecriture (une seule a la fois) ---------- */
async function serverWrite(silent){
  if(!SERVER){ setSyncStatus('local'); return; }
  if(WRITING){ AGAIN = true; return; }
  WRITING = true;
  try{
    const r = await fetch(API, {
      method : 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body   : JSON.stringify({ state: state, baseRev: REV })
    });
    if(r.status === 409){
      const j = await r.json();
      showConflict(j);
      return;
    }
    if(!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    REV = j.rev || REV; STAMP = j.stamp || STAMP;
    DIRTY = false;
    setSyncStatus('ok');
    if(!silent) toast('Enregistre sur le serveur');
  }catch(e){
    setSyncStatus('error');
  }finally{
    WRITING = false;
    if(AGAIN){ AGAIN = false; serverWrite(true); }
  }
}

/* ---------- Sauvegarde appelee par l'application ---------- */
function save(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
  if(!SERVER){ setSyncStatus('local'); return; }
  DIRTY = true;
  setSyncStatus('saving');
  clearTimeout(SAVE_TIMER);
  SAVE_TIMER = setTimeout(()=>serverWrite(true), 900);
}

/* ---------- Conflit : deux postes ont modifie en meme temps ---------- */
let CONFLICT = null;
function showConflict(j){
  CONFLICT = j;
  setSyncStatus('conflict');
  const bar = document.getElementById('conflictBar');
  if(bar) bar.style.display = 'flex';
}
function resolveConflict(choice){
  const bar = document.getElementById('conflictBar');
  if(bar) bar.style.display = 'none';
  if(!CONFLICT) return;
  if(choice === 'server'){
    if(CONFLICT.data){ state = CONFLICT.data; normalizeState(); }
    REV = CONFLICT.rev || REV; STAMP = CONFLICT.stamp || STAMP;
    DIRTY = false;
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
    renderAll();
    setSyncStatus('ok');
    toast('Version du serveur rechargee');
  }else{
    REV = CONFLICT.rev || REV;   // on repart de la revision du serveur
    CONFLICT = null;
    serverWrite();
    return;
  }
  CONFLICT = null;
}

/* ---------- Veille : detecte les modifications des autres postes ---------- */
async function watchServer(){
  if(!SERVER || document.hidden || CONFLICT) return;
  try{
    const r = await fetch(API + '?probe=1', { headers: authHeaders(), cache: 'no-store' });
    if(!r.ok) return;
    const p = await r.json();
    if(!p.stamp || p.stamp === STAMP) return;     // rien de neuf
    const j = await serverRead();
    if(!j.data) return;
    if(DIRTY){ showConflict(j); return; }          // on a des modifs locales
    state = j.data; normalizeState();
    REV = j.rev || 0; STAMP = j.stamp || '';
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
    renderAll();
    toast('Planning mis a jour depuis un autre poste');
  }catch(e){}
}

/* ---------- Chargement initial ---------- */
async function load(){
  let data = null;

  if(SERVER){
    try{
      const j = await serverRead();
      data  = j.data || null;
      REV   = j.rev || 0;
      STAMP = j.stamp || '';
      setSyncStatus('ok');
    }catch(e){
      SERVER = false;
      setSyncStatus('error');
    }
  }else{
    setSyncStatus('local');
  }

  if(!data){
    try{ const r = localStorage.getItem(STORAGE_KEY); if(r) data = JSON.parse(r); }catch(e){}
    // Le serveur est vide mais ce poste a des donnees : on les televerse.
    if(data && SERVER) setTimeout(()=>serverWrite(true), 500);
  }

  if(data) state = data;
  normalizeState();

  if(SERVER){
    setInterval(watchServer, 45000);
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) watchServer(); });
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
  icWrap.innerHTML=`<i data-lucide="${danger===false?'help-circle':'alert-triangle'}" class="ic"></i>`;
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
    // matière attitrée = celle de sa première affectation
    const firstSubjName = info.assigns?.[0]?.[1];
    const subjectId = firstSubjName ? subjId[firstSubjName] : '';
    let t=state.teachers.find(x=>x.name===name);
    if(!t){ t={id:uid('t'),name,subjectId,avail:info.avail||ALL()}; state.teachers.push(t); }
    else { if(info.avail) t.avail=info.avail; if(!t.subjectId) t.subjectId=subjectId; }
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
      <button class="ico-btn danger" data-del-subj="${s.id}" title="Supprimer"><i data-lucide="trash-2" class="ic"></i></button>`;
    box.appendChild(el);
  });
  refreshIcons();
}

/* ----- Enseignants ----- */
function teachersForSubject(subjectId){
  // ne renvoie que les profs dont la matière attitrée correspond
  return state.teachers.filter(t=>t.subjectId===subjectId);
}
function renderTeacherSubjOptions(){
  const sel=document.getElementById('teacherSubj'); if(!sel) return;
  sel.innerHTML = state.subjects.length
    ? state.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')
    : '<option value="">— Créez d\'abord une matière —</option>';
}
function renderTeachers(){
  renderTeacherSubjOptions();
  const box=document.getElementById('teacherList');
  if(!state.teachers.length){ box.innerHTML='<div class="empty"><i data-lucide="users"></i>Aucun enseignant. Ajoutez-en un ci-dessus.</div>'; refreshIcons(); return; }
  box.innerHTML='';
  state.teachers.forEach(t=>{
    const count=countAvail(t);
    const subj=t.subjectId?byId(state.subjects,t.subjectId):null;
    const wrap=document.createElement('div'); wrap.className='row-item';
    wrap.style.flexDirection='column'; wrap.style.alignItems='stretch';
    wrap.innerHTML=`
      <div style="display:flex;align-items:center;gap:11px;width:100%">
        ${subj?`<span class="swatch" style="background:${subj.color}"></span>`:''}
        <span class="nm">${esc(t.name)}</span>
        <span class="mt">${subj?esc(subj.name):'<i>sans matière</i>'} · ${count} h dispo</span>
        <span class="sp"></span>
        <button class="ico-btn" data-toggle-avail="${t.id}" title="Disponibilités"><i data-lucide="clock" class="ic"></i></button>
        <button class="ico-btn" data-edit-teacher="${t.id}" title="Renommer"><i data-lucide="pencil" class="ic"></i></button>
        <button class="ico-btn" data-subj-teacher="${t.id}" title="Changer la matière"><i data-lucide="book-open" class="ic"></i></button>
        <button class="ico-btn danger" data-del-teacher="${t.id}" title="Supprimer"><i data-lucide="trash-2" class="ic"></i></button>
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
    if(!c.items.length) rows='<div class="empty" style="padding:14px"><i data-lucide="plus-circle"></i>Ajoutez les matières de cette classe.</div>';
    const hClass = totalH===TOTAL_HOURS?'ok':(totalH>TOTAL_HOURS?'over':'warn');
    const hIcon = totalH===TOTAL_HOURS?'check':(totalH>TOTAL_HOURS?'alert-triangle':'minus');
    card.innerHTML=`
      <div class="cc-head">
        <h4>${esc(c.name)}</h4>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="hours-pill ${hClass}"><i data-lucide="${hIcon}" class="ic-sm"></i> ${totalH}/${TOTAL_HOURS} h</span>
          <button class="ico-btn danger" data-del-class="${c.id}" title="Supprimer la classe"><i data-lucide="trash-2" class="ic"></i></button>
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
      if(p.type!=='course'){ h+=`<td class="slot pause"></td>`; return; }
      if(!isOpen(day,pi)){ h+=`<td class="slot closed"></td>`; return; }
      const cell=grid[day]?.[pi];
      if(cell){
        const s=byId(state.subjects,cell.subjectId);
        const t=cell.teacherId?byId(state.teachers,cell.teacherId):null;
        const isConf=analysis.conflictCells.has(c.id+'|'+day+'|'+pi);
        const noTeach=cell.forced || !cell.teacherId;
        const cls=isConf?'conflict':(noTeach?'noteacher':'');
        const bg=s?s.color:'#888';
        let badge='';
        if(isConf) badge='<span class="badge c"><i data-lucide="alert-triangle" class="ic"></i>prof occupé</span>';
        else if(noTeach) badge='<span class="badge w"><i data-lucide="user-x" class="ic"></i>sans prof</span>';
        h+=`<td class="slot" data-day="${day}" data-pi="${pi}">
              <div class="placed ${cls}" draggable="true" data-cell="${day}|${pi}" style="background:${bg}">
                <button class="p-del" data-del-cell="${day}|${pi}" title="Retirer"><i data-lucide="x" class="ic"></i></button>
                <span class="p-subj">${s?esc(s.name):'?'}</span>
                <span class="p-meta">${t?esc(t.name):'—'}</span>${badge}</div></td>`;
      } else {
        // CASE VIDE cliquable -> ajouter une séance
        h+=`<td class="slot empty-slot" data-day="${day}" data-pi="${pi}" data-add="${day}|${pi}">
              <span class="add-hint"><i data-lucide="plus-circle" class="ic"></i></span></td>`;
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
      if(p.type!=='course'){ h+=`<td class="slot pause"></td>`; return; }
      if(!isOpen(day,pi)){ h+=`<td class="slot closed"></td>`; return; }
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
      let badge = clash?'<span class="badge c"><i data-lucide="alert-triangle" class="ic"></i>chevauchement</span>':'';
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
    al.innerHTML=`<div class="alert err"><i data-lucide="alert-octagon" class="ic"></i><div><b>${entName}</b> a ${clashCount} créneau(x) en chevauchement (deux classes en même temps). Corrigez en mode « Par classe ».</div></div>`;
  } else if(totalHours){
    al.innerHTML=`<div class="alert ok"><i data-lucide="check-circle-2" class="ic"></i><div>Emploi du temps cohérent — ${totalHours} h par semaine, aucun chevauchement. Prêt à imprimer ou envoyer.</div></div>`;
  } else {
    al.innerHTML=`<div class="alert tip"><i data-lucide="info" class="ic"></i><div>Aucune séance pour le moment. Générez les emplois du temps en mode « Par classe ».</div></div>`;
  }
}

function planHeadRow(){
  let h='<thead><tr><th>Jour</th>';
  PERIODS.forEach(p=>{
    if(p.type==='course'){ h+=`<th>${p.label}</th>`; }
    else { h+=`<th>${p.label}<span class="sub">${p.type==='lunch'?'Déjeuner':'Pause'}</span></th>`; }
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
    out+=`<div class="alert err"><i data-lucide="alert-octagon" class="ic"></i><div><b>Conflits d'enseignant à corriger :</b><ul>${myConf.slice(0,8).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div></div>`;
  }
  if(myIssues.length){
    out+=`<div class="alert warn"><i data-lucide="alert-triangle" class="ic"></i><div><b>À vérifier pour ${esc(c.name)} :</b><ul>${myIssues.map(x=>`<li>${esc(x.replace(c.name+' : ',''))}</li>`).join('')}</ul></div></div>`;
  }
  if(!out){
    out=`<div class="alert ok"><i data-lucide="check-circle-2" class="ic"></i><div><b>Parfait.</b> Emploi du temps complet, sans conflit. Toutes les heures sont placées.</div></div>`;
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
  warn.innerHTML = msg? `<div class="alert ${msg.startsWith('⛔')?'err':'warn'}" style="margin-top:4px"><i data-lucide="alert-triangle" class="ic"></i><div>${esc(msg)}</div></div>`:'';
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
    askConfirm({title:'Tout réinitialiser ?',text:'Matières, enseignants, classes et emplois du temps seront effacés, puis Collège + Lycée rechargés. Action irréversible.',okLabel:'Tout réinitialiser'},()=>{
      localStorage.removeItem(STORAGE_KEY);
      state={subjects:[],teachers:[],classes:[],currentClass:null,plan:{}};
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
      askConfirm({title:'Régénérer cette classe ?',text:`L'emploi du temps actuel de « ${c?c.name:''} » sera remplacé, y compris vos ajustements manuels.`,okLabel:'Régénérer'},go);
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
    const dejaRempli = state.classes.some(c=>planHasCourses(c.id));
    if(dejaRempli){
      askConfirm({title:'Régénérer toutes les classes ?',text:'Tous les emplois du temps existants seront remplacés, y compris les ajustements faits à la main.',okLabel:'Tout régénérer'},go);
    } else go();
  });
  const saveNow=document.getElementById('saveNowBtn');
  if(saveNow) saveNow.addEventListener('click',()=>{
    if(!SERVER){ toast('Mode local — aucun serveur disponible'); return; }
    clearTimeout(SAVE_TIMER); serverWrite(false);
  });
  const cs=document.getElementById('conflictServer'); if(cs) cs.addEventListener('click',()=>resolveConflict('server'));
  const cm=document.getElementById('conflictMine');   if(cm) cm.addEventListener('click',()=>resolveConflict('mine'));
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
  document.getElementById('confirmOk').addEventListener('click',()=>{ const cb=_confirmCb; closeConfirm(); if(cb) cb(); });
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
    save(); renderSubjects(); renderClasses();
  });
}

/* ----- Actions enseignants ----- */
function addTeacher(){
  const name=document.getElementById('teacherName').value.trim();
  const subjectId=document.getElementById('teacherSubj').value;
  if(!name){ toast('Indiquez un nom'); return; }
  if(!subjectId){ toast('Choisissez la matière enseignée'); return; }
  // par défaut : disponible sur tous les créneaux de cours
  const avail={}; DAYS.forEach(d=>{avail[d]={}; PERIODS.forEach((p,pi)=>{ if(isOpen(d,pi)) avail[d][pi]=true; });});
  state.teachers.push({id:uid('t'),name,subjectId,avail});
  document.getElementById('teacherName').value='';
  save(); renderTeachers(); renderClasses();
}
function editTeacher(id){ const t=byId(state.teachers,id); askRename(t.name,'Renommer l\'enseignant',(n)=>{ t.name=n; save(); renderTeachers(); renderClasses(); renderPlan(); }); }
function changeTeacherSubject(id){
  const t=byId(state.teachers,id); if(!t) return;
  if(!state.subjects.length){ toast('Créez d\'abord une matière'); return; }
  // réutilise la modale de confirmation avec un select
  _confirmCb=()=>{
    const v=document.getElementById('subjPick').value;
    const old=t.subjectId;
    t.subjectId=v;
    // retirer ce prof des affectations de classe qui ne correspondent plus
    if(old!==v){
      state.classes.forEach(c=>c.items.forEach(it=>{ if(it.teacherId===id && it.subjectId!==v) it.teacherId=''; }));
    }
    save(); renderTeachers(); renderClasses(); renderPlan();
  };
  document.getElementById('confirmTitle').textContent='Matière de '+t.name;
  document.getElementById('confirmText').innerHTML=
    `<select id="subjPick" style="margin-top:4px">${state.subjects.map(s=>`<option value="${s.id}" ${s.id===t.subjectId?'selected':''}>${esc(s.name)}</option>`).join('')}</select>`;
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
    if(!t || t.subjectId!==item.subjectId) item.teacherId='';
    save(); renderClasses(); return;
  }
  save();
  if(field==='hours') renderClasses(); // maj total
}

/* Une classe a-t-elle deja des seances placees ? */
function planHasCourses(classId){
  const g = state.plan && state.plan[classId];
  if(!g) return false;
  return DAYS.some(d => (g[d]||[]).some(cell => cell));
}

/* ---------- INIT ---------- */
async function boot(){
  await load();
  // Premier lancement (aucune donnee) -> pre-remplir avec les classes/matieres AGC
  if(!state.subjects.length && !state.classes.length && !state.teachers.length){
    seedAGC();
    save();
  }
  renderAll();
  bind();
  refreshIcons();
  window.addEventListener('beforeunload', function(e){
    if(DIRTY){ e.preventDefault(); e.returnValue = ''; }
  });
}

/* ---------- CONNEXION ---------- */
/* Identifiants de secours si le site tourne sans serveur (fichier ouvert
   directement). En ligne, ce sont les variables AGC_USER / AGC_PASSWORD
   definies sur Vercel qui font foi. */
const ACCES_IDENTIFIANT = 'agc';
const ACCES_MOTDEPASSE  = 'agc2026';

(function(){
  const gate = document.getElementById('authGate');
  const form = document.getElementById('authForm');
  const err  = document.getElementById('authErr');
  const btn  = document.getElementById('authBtn');
  let started = false;

  function enter(){
    if(started) return; started = true;
    document.body.classList.remove('locked');
    gate.style.display = 'none';
    boot();
  }

  function encode(u, p){
    try{ return btoa(unescape(encodeURIComponent(u + '::' + p))); }
    catch(e){ return ''; }
  }

  // Verifie aupres du serveur ; retombe en mode local s'il n'y a pas d'API.
  async function tryLogin(u, p){
    const token = encode(u, p);
    try{
      const r = await fetch(API + '?check=1', { headers: { 'x-agc-auth': token }, cache: 'no-store' });
      if(r.status === 401) return 'bad';
      if(r.ok){ AUTH = token; SERVER = true; return 'ok'; }
      throw new Error('http ' + r.status);
    }catch(e){
      // Pas de serveur : mode local avec les identifiants de secours.
      if(u === ACCES_IDENTIFIANT && p === ACCES_MOTDEPASSE){ SERVER = false; return 'local'; }
      return 'bad';
    }
  }

  // Reconnexion automatique dans la meme session du navigateur.
  (async function(){
    let saved = null;
    try{ saved = sessionStorage.getItem('agc_auth'); }catch(e){}
    if(!saved) return;
    try{
      const r = await fetch(API + '?check=1', { headers: { 'x-agc-auth': saved }, cache: 'no-store' });
      if(r.ok){ AUTH = saved; SERVER = true; enter(); return; }
    }catch(e){
      SERVER = false; enter(); return;      // hors ligne : on laisse entrer en local
    }
    try{ sessionStorage.removeItem('agc_auth'); }catch(e){}
  })();

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    err.style.display = 'none';
    const u = document.getElementById('authUser').value.trim();
    const p = document.getElementById('authPass').value;
    btn.disabled = true; btn.textContent = 'Verification...';
    const res = await tryLogin(u, p);
    btn.disabled = false; btn.textContent = 'Se connecter';
    if(res === 'ok' || res === 'local'){
      if(res === 'ok'){ try{ sessionStorage.setItem('agc_auth', AUTH); }catch(e){} }
      enter();
    }else{
      err.style.display = 'block';
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    }
  });

  document.getElementById('authUser').focus();
})();
