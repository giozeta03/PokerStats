// ============================================================================
// POKERSTATS — app.js
// ============================================================================
// Indice:
//   1. Firebase init (con fallback demo)
//   2. Dati di esempio (usati solo in modalità demo)
//   3. Stato applicazione
//   4. Livello di accesso ai dati (Firestore oppure demo)
//   5. Calcolo statistiche/score  <-- isolato, da sostituire in futuro con
//                                      una Cloud Function onCreate/onDelete
//   6. Statistiche avanzate (serie, record, premi, movimenti in classifica)
//   7. Formattazione
//   8. Rendering (numeri chiave, classifica, premi, giocatori, storico)
//   9. Grafici (Chart.js)
//  10. Scheda giocatore
//  11. Navigazione e animazioni
//  12. Autenticazione
//  13. Form nuova sessione / modifica sessione
//  14. Modifica ed eliminazione sessione + modale di conferma
//  15. Inizializzazione (+ service worker per aperture più veloci)
// ============================================================================

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ----------------------------------------------------------------------------
// 1. FIREBASE INIT (con fallback demo)
// ----------------------------------------------------------------------------
const rawConfig = window.__FIREBASE_CONFIG__ || {};
const isDemoMode = !rawConfig.apiKey || rawConfig.apiKey === "YOUR_API_KEY";

let auth = null;
let db = null;

if (!isDemoMode) {
  const firebaseApp = initializeApp(rawConfig);
  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);
} else {
  document.getElementById("demo-banner").hidden = false;
}

// ----------------------------------------------------------------------------
// 2. DATI DI ESEMPIO (solo modalità demo — sostituiti dai tuoi dati reali
//    non appena colleghi Firebase in firebase-config.js)
// ----------------------------------------------------------------------------
const DEMO_NAMES = ["Marco", "Luca", "Giulia", "Pietro", "Sara", "Davide", "Nico", "Fede", "Matte", "Chiara", "Tommy", "Elia"];
const DEMO_SKILL = [0.35, 0.2, 0.25, -0.1, 0.05, -0.3, 0.1, -0.2, 0, -0.05, -0.4, 0.3];
const DEMO_PRESENZA = [0.95, 0.9, 0.7, 0.85, 0.6, 0.9, 0.75, 0.8, 0.65, 0.5, 0.7, 0.15];

const DEMO_HOT = 1;   // Luca
const DEMO_COLD = 10; // Tommy

const DEMO_PLAYERS = DEMO_NAMES.map((nome, i) => ({ id: `demo-player-${i + 1}`, nome }));

function buildDemoSessions() {
  // generatore pseudo-casuale con seme fisso: i dati demo sono sempre uguali
  let seed = 20260921;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

  const sessions = [];
  const today = new Date();
  const TOT = 18;
  for (let s = 0; s < TOT; s++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3 - (TOT - 1 - s) * 21);
    let presenti = DEMO_PLAYERS.filter((_, i) => rand() < DEMO_PRESENZA[i]);
    if (presenti.length < 5) presenti = DEMO_PLAYERS.slice(0, 6);
    // la prima sessione demo è il "recap pre-sito": quasi tutti, importi più alti
    const isRecap = s === 0;
    if (isRecap) presenti = DEMO_PLAYERS.filter((_, i) => i !== 11);
    // nelle ultime 4 sessioni Luca e Tommy ci sono sempre, per mostrare le serie
    const finale = s >= TOT - 4;
    if (finale) {
      for (const idx of [DEMO_HOT, DEMO_COLD]) {
        if (!presenti.includes(DEMO_PLAYERS[idx])) presenti.push(DEMO_PLAYERS[idx]);
      }
    }

    const righe = presenti.map((p) => {
      const idx = DEMO_PLAYERS.indexOf(p);
      const buyIn = [20, 30, 30, 40, 50][Math.floor(rand() * 5)] * (isRecap ? 6 : 1);
      // risultato "grezzo" proporzionale al buy-in: abilità + fortuna
      let delta = buyIn * (0.6 * DEMO_SKILL[idx] + 0.8 * gauss());
      if (finale && idx === DEMO_HOT) delta += buyIn * (s === TOT - 1 ? 7 : 1.2);  // vince sempre: "On fire" (e nell'ultima diventa leader)
      if (finale && idx === DEMO_COLD) delta -= buyIn * 1.2; // perde sempre: "Bidone"
      return { playerId: p.id, nome: p.nome, in: buyIn, delta };
    });
    // somma zero: si toglie a tutti la stessa quota (in proporzione al buy-in)
    const piatto = righe.reduce((a, r) => a + r.in, 0);
    const quota = righe.reduce((a, r) => a + r.delta, 0) / piatto;
    righe.forEach((r) => { r.out = Math.max(0, Math.round(r.in + r.delta - quota * r.in)); });
    // arrotondamenti e uscite azzerate: la differenza va al vincitore della serata
    const resto = piatto - righe.reduce((a, r) => a + r.out, 0);
    righe.reduce((max, r) => (r.out > max.out ? r : max)).out += resto;
    // una sessione con i conti volutamente sbagliati, per mostrare il controllo (solo admin)
    if (s === 11) righe[0].out += 5;

    sessions.push({
      id: `demo-session-${s + 1}`,
      data: date,
      giocatori: righe.map(({ delta, ...r }) => r)
    });
  }
  return sessions;
}

const DEMO_SESSIONS = buildDemoSessions();

// ----------------------------------------------------------------------------
// 3. STATO APPLICAZIONE
// ----------------------------------------------------------------------------
const state = {
  players: [],
  sessions: [],
  stats: [],
  insights: null,
  isAuthenticated: false,
  pendingDeleteSessionId: null,
  editingSessionId: null, // null = nuova sessione, altrimenti id della sessione in modifica
  // giocatori evidenziati nel grafico andamento: 4 "slot" colore fissi, così
  // chi resta selezionato non cambia colore quando se ne aggiunge/toglie uno
  trendSlots: [null, null, null, null, null, null],
  trendQueue: [],
  trendAll: false,     // modalità "Tutti": ogni giocatore con il suo colore
  trendFocus: null,    // in modalità "Tutti": giocatore messo in risalto dal chip
  trendHover: null,    // in modalità "Tutti": giocatore sotto il mouse/dito
  trendInitialized: false,
  yearFilter: "all",
  hofYear: null,     // stagione mostrata nell'albo d'oro
  dupConfirm: null,  // data già presente che l'admin ha confermato di voler salvare
  firstRender: true,
  dataLoaded: false         // true quando giocatori e sessioni sono arrivati
};

const charts = {};

// ----------------------------------------------------------------------------
// 4. LIVELLO DI ACCESSO AI DATI
// ----------------------------------------------------------------------------
async function fetchPlayers() {
  if (isDemoMode) return DEMO_PLAYERS;
  const snap = await getDocs(collection(db, "players"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchSessions() {
  if (isDemoMode) return DEMO_SESSIONS;
  const snap = await getDocs(collection(db, "sessions"));
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      // Firestore Timestamp -> Date JS
      data: data.data instanceof Timestamp ? data.data.toDate() : new Date(data.data)
    };
  });
}

async function createSession(dateValue, giocatori) {
  if (isDemoMode) {
    // in demo non scriviamo davvero, solo simuliamo in memoria
    DEMO_SESSIONS.unshift({ id: `demo-session-${Date.now()}`, data: dateValue, giocatori });
    return;
  }
  await addDoc(collection(db, "sessions"), {
    data: Timestamp.fromDate(dateValue),
    giocatori
  });
}

async function updateSession(sessionId, dateValue, giocatori) {
  if (isDemoMode) {
    const s = DEMO_SESSIONS.find((x) => x.id === sessionId);
    if (s) { s.data = dateValue; s.giocatori = giocatori; }
    return;
  }
  // updateDoc sovrascrive solo i campi indicati; richiede che le regole di
  // sicurezza di Firestore consentano "update" agli utenti autenticati
  await updateDoc(doc(db, "sessions", sessionId), {
    data: Timestamp.fromDate(dateValue),
    giocatori
  });
}

async function deleteSessionById(sessionId) {
  if (isDemoMode) {
    const idx = DEMO_SESSIONS.findIndex((s) => s.id === sessionId);
    if (idx !== -1) DEMO_SESSIONS.splice(idx, 1);
    return;
  }
  await deleteDoc(doc(db, "sessions", sessionId));
}

// ----------------------------------------------------------------------------
// 5. CALCOLO STATISTICHE E SCORE
// ----------------------------------------------------------------------------
// NOTA PER IL FUTURO: questa funzione ricalcola tutto da zero leggendo tutte
// le sessioni ogni volta (va bene per poche decine di sessioni). Quando si
// passerà alle Cloud Functions, questa stessa logica andrà spostata
// server-side, triggerata onCreate/onDelete di una sessione, scrivendo il
// risultato nella collection `stats` invece di ricalcolarlo lato client.
//
// Score = 70% valore netto (+/-) normalizzato + 30% percentuale normalizzata,
// normalizzati entrambi con min-max rispetto a tutti i giocatori del gruppo.
//
// PENALITÀ SCARSA PARTECIPAZIONE:
// chi ha un totale buy-in inferiore al 70% della media del gruppo (calcolata
// solo su chi ha giocato almeno una sessione, per non falsare la soglia con
// giocatori mai scesi in campo) subisce una penalità sul punteggio finale,
// proporzionale a quanto è sotto soglia — fino a un taglio massimo del 40%
// per chi ha partecipato pochissimo.
const PARTECIPAZIONE_SOGLIA_RATIO = 0.7; // soglia = 70% della media buy-in del gruppo
const PARTECIPAZIONE_PENALITA_MAX = 0.4; // taglio massimo al punteggio: 40%

function calculateStats(players, sessions) {
  const totals = {};
  for (const p of players) {
    totals[p.id] = { id: p.id, nome: p.nome, totaleIn: 0, totaleOut: 0, sessioniGiocate: 0 };
  }

  for (const session of sessions) {
    for (const g of session.giocatori) {
      if (!totals[g.playerId]) continue; // sicurezza: giocatore non più in lista
      totals[g.playerId].totaleIn += g.in;
      totals[g.playerId].totaleOut += g.out;
      totals[g.playerId].sessioniGiocate += 1;
    }
  }

  const stats = Object.values(totals).map((t) => {
    const netto = t.totaleOut - t.totaleIn;
    const percentuale = t.totaleIn > 0 ? (netto / t.totaleIn) * 100 : 0;
    return { ...t, netto, percentuale };
  });

  if (stats.length === 0) return stats;

  const nettoValues = stats.map((s) => s.netto);
  const pctValues = stats.map((s) => s.percentuale);
  const nettoMin = Math.min(...nettoValues);
  const nettoMax = Math.max(...nettoValues);
  const pctMin = Math.min(...pctValues);
  const pctMax = Math.max(...pctValues);

  const normalize = (value, min, max) => (max === min ? 0.5 : (value - min) / (max - min));

  // media dei buy-in totali, calcolata solo su chi ha giocato almeno una
  // sessione (altrimenti i giocatori mai scesi in campo abbasserebbero
  // artificialmente la media e la soglia diventerebbe troppo facile da superare)
  const partecipanti = stats.filter((s) => s.sessioniGiocate > 0);
  const mediaBuyIn = partecipanti.length > 0
    ? partecipanti.reduce((sum, s) => sum + s.totaleIn, 0) / partecipanti.length
    : 0;
  const sogliaBuyIn = mediaBuyIn * PARTECIPAZIONE_SOGLIA_RATIO;

  for (const s of stats) {
    const nettoNorm = normalize(s.netto, nettoMin, nettoMax);
    const pctNorm = normalize(s.percentuale, pctMin, pctMax);
    const scoreBase = 0.7 * nettoNorm + 0.3 * pctNorm;

    if (sogliaBuyIn > 0 && s.totaleIn < sogliaBuyIn) {
      // sotto soglia: penalità proporzionale a quanto si è lontani dalla soglia
      // (0 = non ha mai giocato, 1 = esattamente al limite della soglia)
      const ratio = s.totaleIn / sogliaBuyIn;
      const moltiplicatore = (1 - PARTECIPAZIONE_PENALITA_MAX) + PARTECIPAZIONE_PENALITA_MAX * ratio;
      s.score = scoreBase * moltiplicatore;
      s.penalizzato = true;
    } else {
      s.score = scoreBase;
      s.penalizzato = false;
    }
  }

  stats.sort((a, b) => b.score - a.score);
  return stats;
}

// ----------------------------------------------------------------------------
// 6. STATISTICHE AVANZATE
// ----------------------------------------------------------------------------
// Tutto ricavato dai dati già salvati (data + in/out per giocatore):
// nessuna modifica alla struttura di Firestore.
const EPS = 0.5; // tolleranza in € per considerare "in pari" una sessione
// SERIE ("On fire" / "Bidone"): almeno STREAK_MIN sessioni di fila con lo
// stesso esito, contando solo le sessioni a cui il giocatore ha partecipato
// (saltare una serata non interrompe la serie). Il segno compare solo se il
// giocatore ha giocato almeno una delle ultime STREAK_RECENTI sessioni del gruppo.
const STREAK_MIN = 2;
const STREAK_RECENTI = 3;
const HOT = { label: "On fire", color: "var(--neon-orange)", icon: "🔥", title: "sessioni vinte di fila" };
const COLD = { label: "Bidone", color: "var(--neon-magenta)", icon: "🗑️", title: "sessioni perse di fila" };

// RECAP PRE-SITO: la sessione con la data più vecchia è il riepilogo di tutte
// le serate giocate prima del sito. I suoi soldi contano nei totali (netto,
// entrate, uscite, rendimento, score, classifica) ma NON nelle statistiche
// "per sessione" (sessioni giocate, medie, % in attivo, migliore/peggiore,
// serie, record, premi). Nei grafici è il punto di partenza ("Pre-sito").
// quante serate vere sono riassunte nel recap pre-sito (solo per i testi:
// nei calcoli il recap resta una sessione unica)
const RECAP_SERATE = 42;

function findRecapId(sessions) {
  if (!sessions.length) return null;
  return sessions.reduce((first, s) => (s.data < first.data ? s : first)).id;
}

// opts.noRecap = true: nessuna sessione viene trattata come recap (serve
// per l'albo d'oro, dove si passano solo le sessioni vere di un anno)
const PIANGINA_MIN = 1;

// emoji di ogni premio (card dei premi e albo d'oro)
const AWARD_EMOJI = {
  squalo: "🦈",
  cecchino: "🎯",
  record: "🏆",
  stakanovista: "📅",
  swing: "🎢",
  bancomat: "💸",
  titanic: "🚢",
  // "Carta bassa": una mini carta da gioco 2♠ invece di un'emoji
  manofredda: '<span class="mini-card">2<span class="mini-card-suit">♠</span></span>',
  piangina: "😭"
};

// serie negativa in corso di ogni giocatore, guardando solo le prime `k`
// sessioni (serve per trovare "l'ultimo Piangina" quando oggi non c'è)
// ordine per scegliere il Piangina (a parità si passa al criterio successivo):
// 1. più sconfitte di fila   2. più soldi persi nella serie
// 3. più soldi persi rispetto al buy-in della serie (in %)
// 4. posizione peggiore nella classifica generale   5. ordine alfabetico
function peggioreDi(a, b, rankOf) {
  if (a.count !== b.count) return a.count > b.count;
  if (Math.abs(a.perso - b.perso) >= 0.005) return a.perso < b.perso;
  if (Math.abs(a.pct - b.pct) >= 0.0001) return a.pct < b.pct;
  const ra = rankOf.get(a.id) ?? 0;
  const rb = rankOf.get(b.id) ?? 0;
  if (ra !== rb) return ra > rb;
  return String(a.nome).localeCompare(String(b.nome), "it") < 0;
}

function pianginaAt(sorted, byPlayer, k, rankOf, nomeOf) {
  const pos = new Map(sorted.map((s, i) => [s.id, i]));
  const recentIds = new Set(sorted.slice(Math.max(0, k - STREAK_RECENTI), k).map((s) => s.id));
  let best = null;
  for (const [id, allRes] of byPlayer) {
    const res = allRes.filter((r) => pos.has(r.sessionId) && pos.get(r.sessionId) < k);
    if (!res.length || !recentIds.has(res[res.length - 1].sessionId)) continue;
    let count = 0;
    let perso = 0;
    let buyIn = 0;
    for (let i = res.length - 1; i >= 0 && res[i].net < -EPS; i--) {
      count++;
      perso += res[i].net;
      buyIn += res[i].in;
    }
    if (count < PIANGINA_MIN) continue;
    const cand = { id, nome: nomeOf.get(id), count, perso, pct: buyIn > 0 ? perso / buyIn : 0, fino: res[res.length - 1].data };
    if (!best || peggioreDi(cand, best, rankOf)) best = cand;
  }
  return best;
}

function findPiangina(sorted, byPlayer, stats) {
  const rankOf = new Map(stats.map((s, i) => [s.id, i + 1]));
  const nomeOf = new Map(stats.map((s) => [s.id, s.nome]));
  for (let k = sorted.length; k >= 1; k--) {
    const found = pianginaAt(sorted, byPlayer, k, rankOf, nomeOf);
    if (found) return { ...found, attuale: k === sorted.length };
  }
  return null;
}

function calculateInsights(players, sessions, stats, opts = {}) {
  const all = [...sessions].sort((a, b) => a.data - b.data);
  const recap = opts.noRecap ? null : all[0] || null;
  // da qui in poi "sorted" contiene solo le sessioni vere, registrate col sito
  const sorted = recap ? all.slice(1) : all;

  // riepilogo di ogni sessione: piatto e vincitore
  const sessionInfo = new Map();
  for (const s of all) {
    const totIn = s.giocatori.reduce((a, g) => a + g.in, 0);
    const totOut = s.giocatori.reduce((a, g) => a + g.out, 0);
    const winner = s.giocatori.reduce((best, g) => (!best || g.out - g.in > best.out - best.in ? g : best), null);
    sessionInfo.set(s.id, {
      totIn,
      totOut,
      winner,
      winnerNet: winner ? winner.out - winner.in : 0,
      count: s.giocatori.length,
      diff: totOut - totIn, // controllo dei conti: dovrebbe essere 0
      isRecap: !!recap && s.id === recap.id
    });
  }

  // risultati di ogni giocatore, sessione per sessione
  const byPlayer = new Map(stats.map((st) => [st.id, []]));
  for (const s of sorted) {
    for (const g of s.giocatori) {
      if (!byPlayer.has(g.playerId)) continue;
      byPlayer.get(g.playerId).push({ sessionId: s.id, data: s.data, in: g.in, out: g.out, net: g.out - g.in });
    }
  }

  // saldo del recap pre-sito per ogni giocatore (0 se non c'era)
  const recapNet = new Map(stats.map((st) => [st.id, 0]));
  if (recap) {
    for (const g of recap.giocatori) {
      if (recapNet.has(g.playerId)) recapNet.set(g.playerId, recapNet.get(g.playerId) + (g.out - g.in));
    }
  }

  // saldo accumulato allineato a tutte le sessioni (per il grafico andamento):
  // il primo punto è il saldo del recap pre-sito
  const running = new Map(recapNet);
  const cumulative = new Map(stats.map((st) => [st.id, [recapNet.get(st.id)]]));
  for (const s of sorted) {
    for (const g of s.giocatori) {
      if (running.has(g.playerId)) running.set(g.playerId, running.get(g.playerId) + (g.out - g.in));
    }
    for (const [id, arr] of cumulative) arr.push(running.get(id));
  }

  const recentIds = new Set(sorted.slice(-STREAK_RECENTI).map((s) => s.id));
  for (const st of stats) {
    const res = byPlayer.get(st.id) || [];
    st.results = res;
    st.cumulative = cumulative.get(st.id);
    st.recapNet = recapNet.get(st.id);
    st.inRecap = !!recap && recap.giocatori.some((g) => g.playerId === st.id);
    // presenze totali (recap compreso) per sapere chi ha mai giocato;
    // sessioniGiocate da qui in poi conta solo le sessioni vere
    st.presenzeTotali = st.sessioniGiocate;
    st.sessioniGiocate = res.length;
    st.sessioniVinte = res.filter((r) => r.net > EPS).length;
    st.winRate = res.length ? (st.sessioniVinte / res.length) * 100 : 0;
    st.mediaNetto = res.length ? res.reduce((a, r) => a + r.net, 0) / res.length : 0;
    st.mediaBuyIn = res.length ? res.reduce((a, r) => a + r.in, 0) / res.length : 0;
    // rendimento sulle sole sessioni del sito (per il profilo radar)
    const inReali = res.reduce((a, r) => a + r.in, 0);
    st.roiReale = inReali > 0 ? (res.reduce((a, r) => a + r.net, 0) / inReali) * 100 : 0;
    st.best = res.reduce((b, r) => (!b || r.net > b.net ? r : b), null);
    st.worst = res.reduce((w, r) => (!w || r.net < w.net ? r : w), null);
    const mean = st.mediaNetto;
    st.swing = res.length > 1
      ? Math.sqrt(res.reduce((a, r) => a + (r.net - mean) ** 2, 0) / (res.length - 1))
      : 0;

    // serie in corso: sessioni consecutive (dalla più recente) con lo stesso esito
    let streak = { type: null, count: 0 };
    for (let i = res.length - 1; i >= 0; i--) {
      const t = res[i].net > EPS ? "W" : res[i].net < -EPS ? "L" : "P";
      if (t === "P") break;
      if (!streak.type) streak = { type: t, count: 1 };
      else if (streak.type === t) streak.count++;
      else break;
    }
    st.streak = streak;

    // TITANIC: quanto del miglior saldo mai raggiunto è stato poi restituito
    // (es. era a +€180, ora è a +€20 -> 160)
    let run = st.recapNet;
    let peak = { value: Math.max(0, run), data: recap && run > 0 ? recap.data : null };
    for (const r of res) {
      run += r.net;
      if (run > peak.value) peak = { value: run, data: r.data };
    }
    st.peak = peak;
    // conta solo la parte di "altezza" persa: chi non è mai salito non affonda
    st.drawdown = Math.min(peak.value, peak.value - st.netto);

    // la serie conta solo se il giocatore ha partecipato ad almeno una delle
    // ultime STREAK_RECENTI sessioni del gruppo (niente "On fire" di mesi fa)
    const lastPlayed = res.length ? res[res.length - 1].sessionId : null;
    const recente = lastPlayed !== null && recentIds.has(lastPlayed);
    st.recente = recente;
    st.hot = recente && streak.type === "W" && streak.count >= STREAK_MIN;
    st.cold = recente && streak.type === "L" && streak.count >= STREAK_MIN;
  }

  // posizione in classifica e movimento rispetto a prima dell'ultima sessione
  stats.forEach((st, i) => { st.rank = i + 1; st.move = null; st.prevRank = null; });
  if (sorted.length >= 1) {
    const last = sorted[sorted.length - 1];
    const prevStats = calculateStats(players, all.filter((s) => s.id !== last.id));
    const prevRank = new Map(prevStats.map((p, i) => [p.id, i + 1]));
    for (const st of stats) {
      if (prevRank.has(st.id)) {
        st.prevRank = prevRank.get(st.id);
        st.move = st.prevRank - st.rank;
      }
    }
  }

  // premi: servono abbastanza sessioni perché medie e percentuali abbiano senso
  const active = stats.filter((s) => s.presenzeTotali > 0);
  const maxSess = Math.max(0, ...active.map((s) => s.sessioniGiocate));
  const minSess = Math.max(2, Math.round(maxSess * 0.3));
  const eligible = active.filter((s) => s.sessioniGiocate >= minSess);
  const pick = (list, key, dir = 1) =>
    list.reduce((best, s) => (!best || dir * s[key] > dir * best[key] ? s : best), null);

  const awards = [];
  const squalo = pick(eligible, "mediaNetto");
  if (squalo && squalo.mediaNetto > 0) {
    awards.push({ key: "squalo", title: "Squalo", color: "var(--neon-cyan)", player: squalo, value: `${fmtNet(squalo.mediaNetto)} a sessione`, desc: "Miglior guadagno medio" });
  }
  const cecchino = pick(eligible, "winRate");
  if (cecchino && cecchino.sessioniVinte > 0) {
    awards.push({ key: "cecchino", title: "Cecchino", color: "var(--neon-green)", player: cecchino, value: `${Math.round(cecchino.winRate)}% in attivo`, desc: "Più sessioni chiuse in positivo" });
  }
  const recordRow = active
    .filter((s) => s.best)
    .reduce((b, s) => (!b || s.best.net > b.best.net ? s : b), null);
  if (recordRow && recordRow.best.net > 0) {
    awards.push({ key: "record", title: "Serata record", color: "var(--neon-gold)", player: recordRow, value: `${fmtNet(recordRow.best.net)} · ${fmtDateShort(recordRow.best.data)}`, desc: "Vincita più alta in una sessione" });
  }
  const stakanovista = pick(active, "sessioniGiocate");
  if (stakanovista && stakanovista.sessioniGiocate > 0) {
    awards.push({ key: "stakanovista", title: "Stakanovista", color: "var(--neon-violet)", player: stakanovista, value: `${stakanovista.sessioniGiocate} presenze su ${sorted.length}`, desc: "Non ne salta una" });
  }
  const montagne = pick(eligible, "swing");
  if (montagne && montagne.swing > 0) {
    awards.push({ key: "swing", title: "Montagne russe", color: "var(--neon-orange)", player: montagne, value: `swing ±€${Math.round(montagne.swing)}`, desc: "Risultati più altalenanti" });
  }
  const bancomat = pick(active, "netto", -1);
  if (bancomat && bancomat.netto < -EPS) {
    awards.push({ key: "bancomat", title: "Bancomat", color: "var(--neon-magenta)", player: bancomat, value: `${fmtNet(bancomat.netto)} in totale`, desc: "Finanzia il tavolo" });
  }
  const titanic = pick(active, "drawdown");
  if (titanic && titanic.drawdown > EPS) {
    awards.push({ key: "titanic", title: "Titanic", color: "var(--neon-blue)", player: titanic, value: `da ${fmtNet(titanic.peak.value)} a ${fmtNet(titanic.netto)}`, desc: "Il crollo più grande dal suo massimo" });
  }
  // CARTA BASSA (prima "Mano fredda"): la % più bassa di serate in attivo
  const manoFredda = pick(eligible, "winRate", -1);
  if (manoFredda && manoFredda.winRate < 50 && manoFredda !== cecchino) {
    awards.push({ key: "manofredda", title: "Carta bassa", color: "var(--neon-ice)", player: manoFredda, value: `solo ${Math.round(manoFredda.winRate)}% in attivo`, desc: "Meno sessioni chiuse in positivo" });
  }
  // PIANGINA: la serie di sconfitte consecutive IN CORSO più lunga (almeno
  // PIANGINA_MIN), contando solo le serate giocate da ciascuno e solo chi ha
  // giocato una delle ultime STREAK_RECENTI serate. Spareggi: vedi peggioreDi().
  // Se oggi nessuno ha una serie così, il titolo resta all'ultimo che l'ha
  // avuto. Il Piangina non riceve anche il badge "Bidone".
  const pg = findPiangina(sorted, byPlayer, stats);
  const piangina = pg ? stats.find((s) => s.id === pg.id) : null;
  if (piangina) {
    piangina.cold = false; // niente doppione con "Bidone"
    piangina.piangina = pg;
    awards.push({
      key: "piangina",
      title: "Piangina",
      color: "var(--neon-pink)",
      player: piangina,
      value: `${pg.count === 1 ? "1 sconfitta" : `${pg.count} sconfitte di fila`}${pg.attuale ? "" : ` fino al ${fmtDateShort(pg.fino)}`}`,
      extra: `${fmtNet(pg.perso)} nella serie`,
      desc: pg.attuale ? "La serie negativa in corso più lunga" : "Titolo in carica: nessuna nuova serie negativa"
    });
  }

  for (const st of stats) {
    st.badges = awards.filter((a) => a.player.id === st.id).map((a) => ({ key: a.key, label: a.title, color: a.color, icon: a.key === "piangina" ? "😭" : "" }));
    if (st.hot) st.badges.unshift({ ...HOT, title: `${st.streak.count} ${HOT.title}` });
    if (st.cold) st.badges.unshift({ ...COLD, title: `${st.streak.count} ${COLD.title}` });
  }

  // PROFILO A RADAR (scheda giocatore): 5 assi da 0 a 100, confrontati con
  // gli altri giocatori che hanno almeno una sessione registrata col sito
  const RADAR_AXES = ["Rendimento", "% in attivo", "Presenze", "Costanza", "Colpo grosso"];
  const conSessioni = active.filter((s) => s.sessioniGiocate > 0);
  const range = (vals) => ({ min: Math.min(...vals), max: Math.max(...vals) });
  const norm = (v, r) => (r.max === r.min ? 50 : ((v - r.min) / (r.max - r.min)) * 100);
  const rPct = range(conSessioni.map((s) => s.roiReale));
  const rBest = range(conSessioni.map((s) => (s.best ? s.best.net : 0)));
  const conSwing = conSessioni.filter((s) => s.sessioniGiocate > 1);
  const rSwing = range(conSwing.map((s) => s.swing));
  for (const st of stats) {
    if (!st.sessioniGiocate) { st.radar = null; continue; }
    const costanza = st.sessioniGiocate > 1 ? 100 - norm(st.swing, rSwing) : 50;
    st.radar = {
      values: [
        norm(st.roiReale, rPct),
        st.winRate,
        sorted.length ? (st.sessioniGiocate / sorted.length) * 100 : 0,
        costanza,
        norm(st.best ? st.best.net : 0, rBest)
      ].map((v) => Math.round(Math.max(0, Math.min(100, v)))),
      raw: [
        `${fmtPct(st.roiReale)} nelle serate del sito`,
        `${st.sessioniVinte} serate vinte su ${st.sessioniGiocate}`,
        `${st.sessioniGiocate} serate su ${sorted.length}`,
        st.sessioniGiocate > 1 ? `swing ±€${Math.round(st.swing)}` : "servono 2 sessioni",
        st.best ? `${fmtNet(st.best.net)} il ${fmtDateShort(st.best.data)}` : "—"
      ]
    };
  }
  const withRadar = stats.filter((s) => s.radar);
  const radarAvg = withRadar.length
    ? RADAR_AXES.map((_, i) => Math.round(withRadar.reduce((a, s) => a + s.radar.values[i], 0) / withRadar.length))
    : null;

  // numeri chiave
  const lastSession = sorted[sorted.length - 1] || null;
  // soldi in gioco: totale di sempre (recap compreso); la media è sulle sessioni vere
  const totalPot = all.reduce((a, s) => a + sessionInfo.get(s.id).totIn, 0);
  const realPot = sorted.reduce((a, s) => a + sessionInfo.get(s.id).totIn, 0);

  return {
    sorted,
    sessionInfo,
    awards,
    pianginaId: piangina ? piangina.id : null,
    radarAxes: RADAR_AXES,
    radarAvg,
    lastSession,
    firstSession: sorted[0] || null,
    totalPot,
    avgPot: sorted.length ? realPot / sorted.length : 0,
    recap,
    active
  };
}

// ----------------------------------------------------------------------------
// 7. FORMATTAZIONE
// ----------------------------------------------------------------------------
const nf = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 });
const fmtMoney = (n) => `${n < 0 ? "-" : ""}€${nf.format(Math.abs(Math.round(n)))}`;
const fmtNet = (n) => `${Math.round(n) > 0 ? "+" : Math.round(n) < 0 ? "-" : ""}€${nf.format(Math.abs(Math.round(n)))}`;
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1).replace(".", ",")}%`;
const fmtPctInt = (n) => `${Math.round(n) > 0 ? "+" : ""}${nf.format(Math.round(n))}%`;
const fmtDiff = (n) => {
  const abs = Math.abs(n);
  const txt = Number.isInteger(Math.round(abs * 100) / 100) ? nf.format(abs) : abs.toFixed(2).replace(".", ",");
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}€${txt}`;
};
const valueClass = (n) => (n > EPS ? "value-positive" : n < -EPS ? "value-negative" : "value-neutral");
const fmtDate = (d) => d.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
const fmtDateShort = (d) => d.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "2-digit" });
const fmtDateAxis = (d) => d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
const initial = (name) => name.trim().charAt(0).toUpperCase();
// accetta la serie ({type, count}) oppure il giocatore intero (aggiunge 🔥 / 🗑️)
const fmtStreak = (x) => {
  const st = x.streak || x;
  const txt = st.type ? `${st.count} ${st.type === "W" ? "V" : "P"}` : "—";
  if (x.piangina && x.piangina.attuale && st.type === "L") return `${txt} 😭`;
  return x.hot ? `${txt} ${HOT.icon}` : x.cold ? `${txt} ${COLD.icon}` : txt;
};
const streakClass = (st) => (st.type === "W" ? "value-positive" : st.type === "L" ? "value-negative" : "value-neutral");

function moveMarkup(move) {
  if (move === null || move === undefined) return "";
  if (move > 0) return `<span class="move move-up" title="Salito di ${move}">▲${move}</span>`;
  if (move < 0) return `<span class="move move-down" title="Sceso di ${-move}">▼${-move}</span>`;
  return `<span class="move move-same" title="Posizione invariata">=</span>`;
}

function badgeEl(label, color, extraClass = "", icon = "", title = "") {
  const b = document.createElement("span");
  b.className = `badge ${icon ? "badge-icon" : ""} ${extraClass}`.replace(/\s+/g, " ").trim();
  if (color) b.style.setProperty("--bc", color);
  if (icon) {
    const i = document.createElement("span");
    i.className = "badge-emoji";
    i.setAttribute("aria-hidden", "true");
    i.textContent = icon;
    b.appendChild(i);
  }
  b.appendChild(document.createTextNode(label));
  if (title) b.title = title;
  return b;
}

// badge "serie" da mostrare in classifica (solo On fire / Bidone)
function streakBadge(s) {
  const def = s.hot ? HOT : s.cold ? COLD : null;
  if (!def) return null;
  return badgeEl(`${def.label} ×${s.streak.count}`, def.color, "", def.icon, `${s.streak.count} ${def.title}`);
}

// converte un testo inserito dall'utente (con virgola o punto come separatore
// decimale) in un numero. Restituisce NaN se il testo non è un numero valido.
function parseAmount(rawText) {
  const normalized = rawText.trim().replace(",", ".");
  if (normalized === "") return NaN;
  return Number(normalized);
}

// ----------------------------------------------------------------------------
// 8. RENDERING
// ----------------------------------------------------------------------------
function renderHero(stats, ins) {
  const grid = document.getElementById("kpi-grid");
  const sub = document.getElementById("hero-sub");
  grid.innerHTML = "";

  if (!ins.lastSession) {
    sub.textContent = ins.recap ? "Solo il recap pre-sito: nessuna sessione registrata col sito." : "Nessuna sessione registrata.";
    return;
  }
  sub.textContent = `Aggiornato alla sessione del ${fmtDate(ins.lastSession.data)}`;

  const record = ins.awards.find((a) => a.key === "record");
  const lastInfo = ins.sessionInfo.get(ins.lastSession.id);

  // rendimento di una riga (in %): netto / buy-in della serata
  const roi = (g) => (g.in > 0 ? ((g.out - g.in) / g.in) * 100 : -Infinity);
  // serata record in %: miglior rendimento in una singola serata (recap escluso)
  let bestPct = null;
  for (const sess of ins.sorted) {
    for (const g of sess.giocatori) {
      if (roi(g) > 0 && (!bestPct || roi(g) > bestPct.pct)) bestPct = { g, pct: roi(g), data: sess.data };
    }
  }
  // MVP ultima sessione in %: miglior rendimento della serata
  const lastPct = ins.lastSession.giocatori.reduce((b, g) => (roi(g) > 0 && (!b || roi(g) > roi(b)) ? g : b), null);

  // serate totali = serate registrate col sito + quelle riassunte nel recap
  const serateSito = ins.sorted.length;
  const serate = serateSito + (ins.recap ? RECAP_SERATE : 0);
  const who = (id, nome, data) => `<strong>${nameHtml(id, nome)}</strong> · ${fmtDateShort(data)}`;

  const cards = [
    {
      label: "Dall'inizio",
      cls: "kpi-main",
      halves: [
        {
          sub: "Sessioni giocate", value: String(serate), count: serate, format: "int", cls: "accent",
          foot: ins.recap
            ? `${RECAP_SERATE} prima del sito + ${serateSito} sul sito<br>${ins.active.length} giocatori`
            : `dal ${fmtDateShort(ins.firstSession.data)} · ${ins.active.length} giocatori`
        },
        {
          sub: "Soldi in gioco", value: fmtMoney(ins.totalPot), count: ins.totalPot, format: "money",
          foot: `media ${fmtMoney(ins.totalPot / serate)} a serata`
        }
      ]
    },
    {
      label: "Serata record",
      halves: [
        {
          sub: "In euro", value: record ? fmtNet(record.player.best.net) : "—",
          count: record ? record.player.best.net : null, format: "net", cls: "value-positive",
          foot: record ? who(record.player.id, record.player.nome, record.player.best.data) : "nessuna vincita"
        },
        {
          sub: "In percentuale", value: bestPct ? fmtPctInt(bestPct.pct) : "—",
          count: bestPct ? bestPct.pct : null, format: "pct", cls: "value-positive",
          foot: bestPct ? who(bestPct.g.playerId, bestPct.g.nome, bestPct.data) : "nessuna vincita"
        }
      ]
    },
    {
      label: "MVP ultima sessione",
      halves: [
        {
          sub: "In euro", value: lastInfo.winner && lastInfo.winnerNet > 0 ? fmtNet(lastInfo.winnerNet) : "—",
          count: lastInfo.winner && lastInfo.winnerNet > 0 ? lastInfo.winnerNet : null, format: "net", cls: "value-positive",
          foot: lastInfo.winner && lastInfo.winnerNet > 0 ? who(lastInfo.winner.playerId, lastInfo.winner.nome, ins.lastSession.data) : "nessun vincitore"
        },
        {
          sub: "In percentuale", value: lastPct ? fmtPctInt(roi(lastPct)) : "—",
          count: lastPct ? roi(lastPct) : null, format: "pct", cls: "value-positive",
          foot: lastPct ? who(lastPct.playerId, lastPct.nome, ins.lastSession.data) : "nessun vincitore"
        }
      ]
    }
  ];

  for (const c of cards) {
    const el = document.createElement("div");
    el.className = `kpi kpi-split neon-edge ${c.cls || ""}`;
    el.innerHTML = `<span class="kpi-label">${c.label}</span>
      <div class="kpi-halves">${c.halves.map((h) => `
        <div class="kpi-half">
          <span class="kpi-sub">${h.sub}</span>
          <span class="kpi-value ${h.cls || ""}">${h.value}</span>
          <span class="kpi-foot">${h.foot}</span>
        </div>`).join("")}
      </div>`;
    if (state.firstRender) {
      el.querySelectorAll(".kpi-value").forEach((v, i) => {
        const h = c.halves[i];
        if (h.count !== null) countUp(v, h.count, h.format);
      });
    }
    grid.appendChild(el);
  }
}

// AVATAR: immagine del giocatore (cartella avatars/, elenco in
// avatars/avatars.json) con il bordo del suo colore. Se l'immagine non c'è o
// non si carica, resta l'iniziale colorata.
let avatarMap = { perNome: {}, perId: {}, versione: 1 };
const normName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

async function loadAvatars() {
  try {
    // nell'anteprima le immagini sono già incluse nella pagina
    const data = window.__AVATARS__ || await (await fetch("avatars/avatars.json", { cache: "no-cache" })).json();
    const perNome = {};
    for (const [nome, file] of Object.entries(data.perNome || {})) perNome[normName(nome)] = file;
    const grandiPerNome = {};
    for (const [nome, file] of Object.entries(data.grandiPerNome || {})) grandiPerNome[normName(nome)] = file;
    avatarMap = { perNome, perId: data.perId || {}, versione: data.versione || 1, inline: !!data.inline, grandiPerNome };
  } catch (err) {
    // nessun elenco avatar: si usano le iniziali
  }
}

function avatarUrl(id, nome) {
  const file = avatarMap.perId[id] || avatarMap.perNome[normName(nome)];
  if (!file) return null;
  if (avatarMap.inline || /^(data:|https?:)/.test(file)) return file;
  return `avatars/${encodeURIComponent(file)}?v=${avatarMap.versione}`;
}

// versione grande (immagine intera, cartella avatars/grandi/ con lo stesso nome
// file); se manca si usa quella normale
function avatarBigUrl(id, nome) {
  if (avatarMap.inline) return avatarMap.grandiPerNome[normName(nome)] || avatarUrl(id, nome);
  const file = avatarMap.perId[id] || avatarMap.perNome[normName(nome)];
  if (!file || /^(data:|https?:)/.test(file)) return avatarUrl(id, nome);
  return `avatars/grandi/${encodeURIComponent(file)}?v=${avatarMap.versione}`;
}

function paintAvatar(el, id, nome) {
  el.style.setProperty("--av", allColor(id));
  el.classList.remove("has-img");
  el.textContent = "";
  const letter = document.createElement("span");
  letter.className = "avatar-initial";
  letter.textContent = initial(nome);
  el.appendChild(letter);
  const url = avatarUrl(id, nome);
  if (!url) return;
  const img = document.createElement("img");
  img.className = "avatar-img";
  img.alt = "";
  img.decoding = "async";
  img.addEventListener("error", () => { img.remove(); el.classList.remove("has-img"); });
  img.src = url;
  el.classList.add("has-img");
  el.appendChild(img);
}

// IL PIANGINA: accanto al nome del vincitore del premio compare "il Piangina"
// ovunque nel sito, tranne che nei grafici e nel form (dove il nome viene salvato).
// Il nome originale non viene mai modificato: l'etichetta è solo visiva.
const PIANGINA_TAG = "il Piangina";
const isPiangina = (id) => !!state.insights && state.insights.pianginaId === id;

function nameHtml(id, nome) {
  const safe = escapeHtml(nome);
  return isPiangina(id) ? `${safe} <span class="piangina-tag">${PIANGINA_TAG}</span>` : safe;
}

function setName(el, id, nome) {
  el.innerHTML = nameHtml(id, nome);
  el.classList.toggle("has-piangina", isPiangina(id));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function countUp(el, target, format) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const fmt = format === "money" ? fmtMoney : format === "net" ? fmtNet : format === "pct" ? fmtPctInt : (n) => String(Math.round(n));
  const start = performance.now();
  const dur = 900;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(target * eased);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmt(target);
  };
  requestAnimationFrame(step);
}

function renderLeaderboard(stats) {
  const podiumEl = document.getElementById("podium");
  const listEl = document.getElementById("rank-list");
  const podiumTpl = document.getElementById("podium-item-template");
  const rankTpl = document.getElementById("rank-item-template");
  const maxScore = Math.max(0.0001, ...stats.map((s) => s.score));

  podiumEl.innerHTML = "";
  stats.slice(0, 3).forEach((s, i) => {
    const place = i + 1;
    const node = podiumTpl.content.cloneNode(true);
    const item = node.querySelector(".podium-item");
    item.dataset.place = String(place);
    item.setAttribute("aria-label", `${place}° posto: ${s.nome}, apri scheda`);
    // corona luminosa solo sul primo classificato
    item.querySelector(".podium-crown").textContent = place === 1 ? "♛" : "";
    paintAvatar(item.querySelector(".podium-avatar"), s.id, s.nome);
    // animazioni di classifica (solo al primo caricamento)
    if (state.firstRender && s.move) item.classList.add(s.move > 0 ? "moved-up" : "moved-down");
    if (state.firstRender && place === 1 && s.prevRank && s.prevRank !== 1) {
      item.classList.add("new-leader");
      item.querySelector(".podium-meta").insertAdjacentHTML("beforeend", `<span class="leader-tag">Nuovo leader!</span>`);
    }
    setName(item.querySelector(".podium-name"), s.id, s.nome);
    const net = item.querySelector(".podium-net");
    net.textContent = fmtNet(s.netto);
    net.classList.add(valueClass(s.netto));
    item.querySelector(".podium-meta").innerHTML =
      `<span>score ${s.score.toFixed(2)}</span>${moveMarkup(s.move)}`;
    const psb = streakBadge(s);
    if (psb) item.querySelector(".podium-meta").appendChild(psb);
    item.querySelector(".podium-rank").textContent = `#${place}`;
    item.addEventListener("click", () => openPlayerDrawer(s.id));
    podiumEl.appendChild(node);
  });

  listEl.innerHTML = "";
  stats.slice(3).forEach((s, i) => {
    const node = rankTpl.content.cloneNode(true);
    const btn = node.querySelector(".rank-item");
    btn.setAttribute("aria-label", `${i + 4}° posto: ${s.nome}, apri scheda`);
    node.querySelector(".rank-number").textContent = `${i + 4}`;
    node.querySelector(".rank-move").innerHTML = moveMarkup(s.move);
    setName(node.querySelector(".rank-name"), s.id, s.nome);
    paintAvatar(node.querySelector(".rank-avatar"), s.id, s.nome);
    if (state.firstRender && s.move) btn.classList.add(s.move > 0 ? "moved-up" : "moved-down");
    const tags = node.querySelector(".rank-tags");
    if (s.penalizzato) {
      const b = badgeEl("Poche presenze", null, "badge-absent");
      b.title = "Buy-in totale sotto il 70% della media: score ridotto";
      tags.appendChild(b);
    }
    const sb = streakBadge(s);
    if (sb) tags.appendChild(sb);
    const net = node.querySelector(".rank-net");
    net.textContent = fmtNet(s.netto);
    net.classList.add(valueClass(s.netto));
    node.querySelector(".score-fill").style.width = `${Math.max(2, (s.score / maxScore) * 100)}%`;
    node.querySelector(".score-value").textContent = s.score.toFixed(2);
    btn.addEventListener("click", () => openPlayerDrawer(s.id));
    listEl.appendChild(node);
  });
}

function renderAwards(ins) {
  const grid = document.getElementById("awards-grid");
  grid.innerHTML = "";
  // il premio Piangina è "esaltato": card a tutta larghezza, sempre per prima
  const featured = ins.awards.filter((a) => a.key === "piangina");
  const others = ins.awards.filter((a) => a.key !== "piangina");
  // colonne scelte in base al numero degli altri premi, per evitare righe con una card sola
  grid.style.setProperty("--award-cols", others.length % 4 === 0 ? 4 : 3);
  grid.classList.toggle("has-featured", featured.length > 0);
  for (const a of [...featured, ...others]) {
    const el = document.createElement("button");
    el.type = "button";
    el.style.setProperty("--ac", a.color);
    if (a.key === "piangina") {
      el.className = "award award-piangina";
      el.innerHTML = `
        <span class="piangina-main">
          <span class="award-title"><span class="piangina-emoji" aria-hidden="true">${AWARD_EMOJI.piangina}</span>${a.title}</span>
          <span class="award-name">${escapeHtml(a.player.nome)}</span>
        </span>
        <span class="piangina-side">
          <span class="award-value">${a.value}</span>
          <span class="award-value piangina-crollo">${a.extra || ""}</span>
          <span class="award-desc">${a.desc}</span>
        </span>`;
    } else {
      el.className = "award";
      el.innerHTML = `
        <span class="award-title"><span class="award-emoji" aria-hidden="true">${AWARD_EMOJI[a.key] || ""}</span>${a.title}</span>
        <span class="award-name">${nameHtml(a.player.id, a.player.nome)}</span>
        <span class="award-value">${a.value}</span>
        <span class="award-desc">${a.desc}</span>`;
    }
    el.addEventListener("click", () => openPlayerDrawer(a.player.id));
    grid.appendChild(el);
  }
  grid.hidden = ins.awards.length === 0;
}

function renderRecap(stats) {
  const gridEl = document.getElementById("recap-grid");
  const tpl = document.getElementById("recap-card-template");
  // schede ordinate come la classifica (già ordinata per score)
  gridEl.innerHTML = "";
  stats.forEach((s) => {
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector(".recap-card");
    card.dataset.playerId = s.id;
    card.setAttribute("aria-label", `${s.nome}: apri scheda`);
    paintAvatar(node.querySelector(".recap-avatar"), s.id, s.nome);
    setName(node.querySelector(".recap-name"), s.id, s.nome);
    node.querySelector(".recap-sub").textContent =
      `#${s.rank} · ${s.sessioniGiocate} ${s.sessioniGiocate === 1 ? "sessione" : "sessioni"}`;
    const netEl = node.querySelector(".recap-net");
    netEl.textContent = fmtNet(s.netto);
    netEl.classList.add(valueClass(s.netto));
    node.querySelector(".recap-in").textContent = fmtMoney(s.totaleIn);
    node.querySelector(".recap-out").textContent = fmtMoney(s.totaleOut);
    const pctEl = node.querySelector(".recap-pct");
    pctEl.textContent = fmtPct(s.percentuale);
    pctEl.classList.add(valueClass(s.percentuale));
    node.querySelector(".recap-win").textContent = s.sessioniGiocate ? `${Math.round(s.winRate)}%` : "—";
    const avgEl = node.querySelector(".recap-avg");
    avgEl.textContent = s.sessioniGiocate ? fmtNet(s.mediaNetto) : "—";
    avgEl.classList.add(valueClass(s.mediaNetto));
    const stEl = node.querySelector(".recap-streak");
    stEl.textContent = fmtStreak(s);
    stEl.classList.add(streakClass(s.streak));
    const badges = node.querySelector(".recap-badges");
    s.badges.forEach((b) => badges.appendChild(badgeEl(b.label, b.color, "", b.icon, b.title)));
    if (s.penalizzato) badges.appendChild(badgeEl("Poche presenze", null, "badge-absent"));
    card.addEventListener("click", () => openPlayerDrawer(s.id));
    gridEl.appendChild(node);
  });
  drawAllSparklines();
}

// mini-grafico disegnato a mano su canvas: leggero anche con molte schede
function drawSparkline(canvas, values) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 44;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = 5;
  const vals = values.length > 1 ? values : [0, values[0] || 0];
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const span = max - min || 1;
  const x = (i) => pad + (i / (vals.length - 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - (v - min) / span) * (h - pad * 2);
  const last = vals[vals.length - 1];
  const color = last > EPS ? "#38ffa0" : last < -EPS ? "#ff2e7e" : "#8a94a8";

  // linea dello zero
  ctx.strokeStyle = "rgba(233, 237, 246, 0.14)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(pad, y(0));
  ctx.lineTo(w - pad, y(0));
  ctx.stroke();
  ctx.setLineDash([]);

  // area
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + "40");
  grad.addColorStop(1, color + "00");
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.lineTo(x(vals.length - 1), y(0));
  ctx.lineTo(x(0), y(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // linea
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // punto finale
  ctx.beginPath();
  ctx.arc(x(vals.length - 1), y(last), 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawAllSparklines() {
  document.querySelectorAll(".recap-card").forEach((card) => {
    const st = state.stats.find((s) => s.id === card.dataset.playerId);
    if (!st) return;
    const vals = [st.recapNet || 0];
    st.results.forEach((r) => vals.push(vals[vals.length - 1] + r.net));
    drawSparkline(card.querySelector(".recap-spark"), vals);
  });
}

function renderYearFilter(sessions) {
  const el = document.getElementById("year-filter");
  // gli anni vengono solo dalle sessioni vere: il recap pre-sito non crea un tasto
  const recapId = findRecapId(sessions);
  const years = [...new Set(sessions.filter((s) => s.id !== recapId).map((s) => s.data.getFullYear()))].sort((a, b) => b - a);
  el.innerHTML = "";
  if (years.length < 2) {
    state.yearFilter = "all";
    return;
  }
  if (state.yearFilter !== "all" && !years.includes(Number(state.yearFilter))) state.yearFilter = "all";
  const options = [["all", "Tutte"], ...years.map((y) => [String(y), String(y)])];
  for (const [val, label] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.setAttribute("aria-pressed", String(state.yearFilter === val));
    b.addEventListener("click", () => {
      state.yearFilter = val;
      renderYearFilter(state.sessions);
      renderHistory(state.sessions, state.insights);
    });
    el.appendChild(b);
  }
}

function renderHistory(sessions, ins) {
  const listEl = document.getElementById("session-list");
  const cardTpl = document.getElementById("session-card-template");
  const rowTpl = document.getElementById("session-row-template");

  const recapId = ins.recap ? ins.recap.id : null;
  const sorted = [...sessions]
    .filter((s) => state.yearFilter === "all" || s.data.getFullYear() === Number(state.yearFilter))
    .sort((a, b) => b.data - a.data);
  // il recap pre-sito va sempre in fondo
  sorted.sort((a, b) => Number(a.id === recapId) - Number(b.id === recapId));

  listEl.innerHTML = "";
  if (sorted.length === 0) {
    listEl.innerHTML = `<div class="empty-note">Nessuna sessione registrata.</div>`;
    return;
  }

  sorted.forEach((session, idx) => {
    const info = ins.sessionInfo.get(session.id);
    const node = cardTpl.content.cloneNode(true);
    const card = node.querySelector(".session-card");
    if (idx === 0 && !info.isRecap) card.open = true; // la più recente è già aperta

    if (info.isRecap) {
      card.classList.add("session-card-recap");
      node.querySelector(".session-date").textContent = "Recap pre-sito";
      node.querySelector(".session-meta").textContent =
        `${info.count} giocatori · ${fmtMoney(info.totIn)} in gioco · tutte le ${RECAP_SERATE} serate prima del sito`;
      node.querySelector(".session-winner").innerHTML = `<span class="recap-pill">punto di partenza</span>`;
    } else {
      node.querySelector(".session-date").textContent = fmtDate(session.data);
      node.querySelector(".session-meta").textContent = `${info.count} giocatori · ${fmtMoney(info.totIn)} in gioco`;
    }
    if (info.winner && !info.isRecap) {
      node.querySelector(".session-winner").innerHTML =
        `<span class="crown" aria-hidden="true">♛</span><span>${nameHtml(info.winner.playerId, info.winner.nome)}</span><span class="mono">${fmtNet(info.winnerNet)}</span>`;
    }
    // CONTROLLO DEI CONTI (solo admin: lo mostra il CSS con body.is-admin)
    // se il totale uscito non coincide con il totale entrato compare un avviso
    if (Math.abs(info.diff) >= EPS) {
      const b = badgeEl(`Conti ${fmtDiff(info.diff)}`, null, "badge-conti", "⚠");
      b.title = info.diff > 0
        ? `Sono usciti ${fmtDiff(info.diff).slice(1)} in più di quelli entrati: controlla i valori`
        : `Sono usciti ${fmtDiff(info.diff).slice(1)} in meno di quelli entrati: controlla i valori`;
      node.querySelector(".session-check").appendChild(b);
    }

    const editBtn = node.querySelector(".session-edit-btn");
    editBtn.hidden = !state.isAuthenticated;
    editBtn.addEventListener("click", () => openAdminPanel(session));

    const deleteBtn = node.querySelector(".session-delete-btn");
    deleteBtn.hidden = !state.isAuthenticated;
    deleteBtn.addEventListener("click", () => openConfirmModal(session.id, session.data));

    const body = node.querySelector(".session-table-body");
    session.giocatori
      .slice()
      .sort((a, b) => (b.out - b.in) - (a.out - a.in))
      .forEach((g) => {
        const netto = g.out - g.in;
        const pct = g.in > 0 ? (netto / g.in) * 100 : 0;
        const row = rowTpl.content.cloneNode(true);
        setName(row.querySelector(".session-row-name"), g.playerId, g.nome);
        row.querySelector(".session-row-in").textContent = fmtMoney(g.in);
        row.querySelector(".session-row-out").textContent = fmtMoney(g.out);
        const netCell = row.querySelector(".session-row-net");
        netCell.textContent = fmtNet(netto);
        netCell.classList.add(valueClass(netto));
        const pctCell = row.querySelector(".session-row-pct");
        pctCell.textContent = fmtPct(pct);
        pctCell.classList.add(valueClass(pct));
        body.appendChild(row);
      });

    // la riga "Totale" è visibile solo all'admin loggato: la mostra il CSS
    // quando <body> ha la classe "is-admin" (vedi updateAuthUI)
    node.querySelector(".session-total-in").textContent = fmtMoney(info.totIn);
    node.querySelector(".session-total-out").textContent = fmtMoney(info.totOut);
    const diffCell = node.querySelector(".session-total-diff");
    diffCell.innerHTML = Math.abs(info.diff) >= EPS
      ? `<span class="conti-warn">Differenza ${fmtDiff(info.diff)}</span>`
      : `<span class="conti-ok">Conti in pari ✓</span>`;
    listEl.appendChild(node);
  });
}

function renderAll() {
  state.stats = calculateStats(state.players, state.sessions);
  state.insights = calculateInsights(state.players, state.sessions, state.stats);
  renderHero(state.stats, state.insights);
  renderLeaderboard(state.stats);
  renderCharts(state.stats, state.insights);
  renderAwards(state.insights);
  renderRecap(state.stats);
  renderHallOfFame(state.sessions);
  renderYearFilter(state.sessions);
  renderHistory(state.sessions, state.insights);
  setupScrollReveal();
  state.firstRender = false;
}

// ----------------------------------------------------------------------------
// ALBO D'ORO
// ----------------------------------------------------------------------------
// Per ogni anno CONCLUSO (precedente a quello in corso) ricalcola classifica e
// premi usando solo le sessioni di quell'anno (recap pre-sito escluso).
// Non salva niente su Firebase: finché le sessioni di quell'anno non vengono
// modificate, il risultato resta sempre lo stesso.
function seasonSummary(year, sessions) {
  const recapId = findRecapId(sessions);
  const list = sessions.filter((s) => s.id !== recapId && s.data.getFullYear() === year);
  if (!list.length) return null;
  const stats = calculateStats(state.players, list);
  const ins = calculateInsights(state.players, list, stats, { noRecap: true });
  const champion = stats.find((s) => s.presenzeTotali > 0) || null;
  return { year, count: list.length, champion, awards: ins.awards };
}

function renderHallOfFame(sessions) {
  const section = document.getElementById("halloffame");
  const navLink = document.getElementById("nav-hof");
  const thisYear = new Date().getFullYear();
  const recapId = findRecapId(sessions);
  const years = [...new Set(sessions.filter((s) => s.id !== recapId).map((s) => s.data.getFullYear()))]
    .filter((y) => y < thisYear)
    .sort((a, b) => b - a);

  section.hidden = years.length === 0;
  navLink.hidden = years.length === 0;
  if (!years.length) return;
  if (!years.includes(state.hofYear)) state.hofYear = years[0];

  const chips = document.getElementById("hof-years");
  chips.innerHTML = "";
  if (years.length > 1) {
    for (const y of years) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = String(y);
      b.setAttribute("aria-pressed", String(y === state.hofYear));
      b.addEventListener("click", () => { state.hofYear = y; renderHallOfFame(state.sessions); });
      chips.appendChild(b);
    }
  }

  const body = document.getElementById("hof-body");
  const season = seasonSummary(state.hofYear, sessions);
  body.innerHTML = "";
  if (!season) return;

  const panel = document.createElement("div");
  panel.className = "hof-panel";

  const ch = season.champion;
  const champ = document.createElement("button");
  champ.type = "button";
  champ.className = "hof-champion";
  champ.innerHTML = ch
    ? `
      <span class="hof-crown" aria-hidden="true">♛</span>
      <span class="section-eyebrow">Campione ${season.year}</span>
      <span class="avatar avatar-lg hof-avatar"></span>
      <span class="hof-champion-name">${nameHtml(ch.id, ch.nome)}</span>
      <span class="hof-champion-net ${valueClass(ch.netto)}">${fmtNet(ch.netto)}</span>
      <span class="hof-champion-meta">${ch.sessioniGiocate} sessioni su ${season.count} · score ${ch.score.toFixed(2)}</span>`
    : `<span class="section-eyebrow">Stagione ${season.year}</span>`;
  if (ch) {
    paintAvatar(champ.querySelector(".hof-avatar"), ch.id, ch.nome);
    champ.addEventListener("click", () => openPlayerDrawer(ch.id));
  }
  panel.appendChild(champ);

  const list = document.createElement("div");
  list.className = "hof-awards";
  for (const a of season.awards) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `hof-award${a.key === "piangina" ? " hof-award-piangina" : ""}`;
    row.style.setProperty("--ac", a.color);
    row.innerHTML = `
      <span class="hof-award-title"><span class="award-emoji" aria-hidden="true">${AWARD_EMOJI[a.key] || ""}</span>${a.title}</span>
      <span class="hof-award-name">${nameHtml(a.player.id, a.player.nome)}</span>
      <span class="hof-award-value">${a.value}${a.extra ? ` · ${a.extra}` : ""}</span>`;
    row.addEventListener("click", () => openPlayerDrawer(a.player.id));
    list.appendChild(row);
  }
  panel.appendChild(list);
  body.appendChild(panel);
}

// ----------------------------------------------------------------------------
// BACKUP CSV (solo admin)
// ----------------------------------------------------------------------------
// Una riga per ogni giocatore di ogni sessione. Separatore ";" e virgola per i
// decimali, così Excel in italiano lo apre già diviso in colonne.
function downloadBackup() {
  const recapId = findRecapId(state.sessions);
  const cell = (v) => {
    const s = typeof v === "number" ? String(v).replace(".", ",") : String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const pad = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const rows = [["Data", "Recap pre-sito", "Giocatore", "In", "Out", "Netto", "ID giocatore", "ID sessione"]];
  [...state.sessions]
    .sort((a, b) => a.data - b.data)
    .forEach((s) => {
      s.giocatori.forEach((g) => {
        rows.push([isoDate(s.data), s.id === recapId ? "sì" : "no", g.nome, g.in, g.out, g.out - g.in, g.playerId, s.id]);
      });
    });
  const csv = "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pokerstats-backup-${isoDate(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById("backup-btn")?.addEventListener("click", downloadBackup);

// ----------------------------------------------------------------------------
// CELEBRAZIONE MVP: pioggia di fiches
// ----------------------------------------------------------------------------
// La prima volta che qualcuno apre il sito dopo una nuova sessione compare
// l'MVP della serata con una pioggia di fiches. Il telefono si ricorda quale
// sessione ha già festeggiato, così l'animazione non si ripete.
const MVP_KEY = "pokerstats-mvp-visto";
const mvpOverlay = document.getElementById("mvp-overlay");
let mvpTimer = null;
let mvpAnim = null;

function maybeCelebrateMvp() {
  const ins = state.insights;
  if (!ins || !ins.lastSession) return;
  const info = ins.sessionInfo.get(ins.lastSession.id);
  if (!info || !info.winner || info.winnerNet <= EPS) return;
  let seen = null;
  try { seen = localStorage.getItem(MVP_KEY); } catch (err) { /* memoria non disponibile */ }
  if (seen === ins.lastSession.id) return;
  try { localStorage.setItem(MVP_KEY, ins.lastSession.id); } catch (err) { /* pazienza */ }
  showMvpCelebration();
}

function showMvpCelebration() {
  const ins = state.insights;
  if (!ins || !ins.lastSession) return;
  const info = ins.sessionInfo.get(ins.lastSession.id);
  if (!info || !info.winner) return;
  const w = info.winner;
  paintAvatar(document.getElementById("mvp-avatar"), w.playerId, w.nome);
  document.getElementById("mvp-name").innerHTML = nameHtml(w.playerId, w.nome);
  document.getElementById("mvp-net").textContent = fmtNet(info.winnerNet);
  document.getElementById("mvp-date").textContent = fmtDate(ins.lastSession.data);
  mvpOverlay.style.setProperty("--mvp", allColor(w.playerId));
  mvpOverlay.hidden = false;
  mvpOverlay.classList.remove("closing");

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce) runChipRain(document.getElementById("mvp-canvas"), 4200);
  clearTimeout(mvpTimer);
  mvpTimer = setTimeout(closeMvpCelebration, reduce ? 4000 : 5200);
}

function closeMvpCelebration() {
  clearTimeout(mvpTimer);
  if (mvpOverlay.hidden) return;
  mvpOverlay.classList.add("closing");
  setTimeout(() => {
    mvpOverlay.hidden = true;
    mvpOverlay.classList.remove("closing");
    if (mvpAnim) cancelAnimationFrame(mvpAnim);
    mvpAnim = null;
  }, 350);
}

mvpOverlay?.addEventListener("click", closeMvpCelebration);
// nell'anteprima c'è un tasto per rivedere l'animazione (sul sito vero non esiste)
const replayMvpBtn = document.getElementById("replay-mvp");
if (replayMvpBtn) replayMvpBtn.addEventListener("click", showMvpCelebration);

function runChipRain(canvas, durationMs) {
  if (mvpAnim) cancelAnimationFrame(mvpAnim);
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ["#ffd24a", "#22e6ff", "#b06bff", "#ff2e7e", "#38ffa0", "#ff8a3d"];
  const count = Math.round(Math.min(70, Math.max(30, W / 18)));
  const chips = Array.from({ length: count }, () => ({
    x: Math.random() * W,
    y: -Math.random() * H * 0.9 - 30,
    r: 10 + Math.random() * 10,
    vy: 160 + Math.random() * 220,          // pixel al secondo
    vx: (Math.random() - 0.5) * 60,
    spin: Math.random() * Math.PI * 2,
    vs: 3 + Math.random() * 5,              // velocità di rotazione
    color: colors[Math.floor(Math.random() * colors.length)]
  }));

  const drawChip = (c) => {
    const flip = Math.max(0.18, Math.abs(Math.cos(c.spin)));
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(flip, 1);
    ctx.shadowColor = c.color;
    ctx.shadowBlur = 14;
    // corpo della fiche
    ctx.beginPath();
    ctx.arc(0, 0, c.r, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.shadowBlur = 0;
    // bordo a tacche bianche
    ctx.setLineDash([c.r * 0.42, c.r * 0.36]);
    ctx.lineWidth = c.r * 0.2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, c.r * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // centro
    ctx.beginPath();
    ctx.arc(0, 0, c.r * 0.48, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(7, 10, 16, 0.35)";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.stroke();
    ctx.restore();
  };

  const start = performance.now();
  let last = start;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = t > durationMs - 700 ? Math.max(0, (durationMs - t) / 700) : 1;
    for (const c of chips) {
      c.y += c.vy * dt;
      c.x += c.vx * dt;
      c.spin += c.vs * dt;
      if (c.y - c.r > H && t < durationMs - 1200) {
        c.y = -c.r - Math.random() * 60;
        c.x = Math.random() * W;
      }
      drawChip(c);
    }
    ctx.globalAlpha = 1;
    if (t < durationMs) mvpAnim = requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, W, H); mvpAnim = null; }
  };
  mvpAnim = requestAnimationFrame(frame);
}

// ----------------------------------------------------------------------------
// AVATAR A TUTTO SCHERMO: tocco sull'immagine nella scheda giocatore
// ----------------------------------------------------------------------------
const lightbox = document.getElementById("avatar-lightbox");
const lightboxImg = document.getElementById("lightbox-img");

function openAvatarLightbox(id, nome) {
  if (!lightbox || !avatarUrl(id, nome)) return;
  const small = avatarUrl(id, nome);
  lightboxImg.onerror = () => { lightboxImg.onerror = null; lightboxImg.src = small; };
  lightboxImg.src = avatarBigUrl(id, nome);
  lightboxImg.alt = `Avatar di ${nome}`;
  lightbox.style.setProperty("--av", allColor(id));
  document.getElementById("lightbox-name").innerHTML = nameHtml(id, nome);

  // sotto il nome: tutti i badge del giocatore (premi con la loro emoji,
  // On fire / Bidone / Piangina). "Poche presenze" non si mostra.
  const row = document.getElementById("lightbox-badges");
  row.innerHTML = "";
  const st = state.stats.find((s) => s.id === id);
  for (const b of (st && st.badges) || []) {
    const el = badgeEl(b.label, b.color, "badge-lg");
    const iconHtml = b.key ? AWARD_EMOJI[b.key] : b.icon;
    if (iconHtml) {
      el.classList.add("badge-icon");
      const ic = document.createElement("span");
      ic.className = "badge-emoji";
      ic.setAttribute("aria-hidden", "true");
      ic.innerHTML = iconHtml; // testo dell'emoji o la mini carta 2♠ (contenuto fisso del sito)
      el.prepend(ic);
    }
    if (b.title) el.title = b.title;
    row.appendChild(el);
  }
  row.hidden = row.childElementCount === 0;
  lightbox.hidden = false;
  lightbox.classList.remove("closing");
  document.getElementById("lightbox-close").focus({ preventScroll: true });
}

function closeAvatarLightbox() {
  if (!lightbox || lightbox.hidden) return;
  lightbox.classList.add("closing");
  setTimeout(() => {
    lightbox.hidden = true;
    lightbox.classList.remove("closing");
    document.getElementById("drawer-avatar")?.focus({ preventScroll: true });
  }, 200);
}

lightbox?.addEventListener("click", closeAvatarLightbox);
document.getElementById("drawer-avatar")?.addEventListener("click", (e) => {
  const el = e.currentTarget;
  if (el.dataset.playerId && el.classList.contains("has-img")) openAvatarLightbox(el.dataset.playerId, el.dataset.playerName);
});

// ----------------------------------------------------------------------------
// 9. GRAFICI (Chart.js, caricato da CDN in index.html)
// ----------------------------------------------------------------------------
const hasChart = typeof window.Chart !== "undefined";
// colori dei giocatori: ognuno ha sempre lo stesso, in base all'ordine della
// lista giocatori (grafici, avatar, chip)
const SERIES_COLORS = ["#ffd24a", "#22e6ff", "#b06bff", "#ff8a3d", "#9dff4f", "#ff6bd6"];
const MAX_HIGHLIGHT = SERIES_COLORS.length;
// 6 colori principali + altri 10 neon
const ALL_COLORS = [...SERIES_COLORS, "#5b8cff", "#2effc7", "#eaff5c", "#d0b3ff", "#ffb38a", "#ff6b6b", "#7fd4ff", "#b8ffd9", "#e0ff9e", "#ff9ef0"];
function allColor(id) {
  let i = state.players.findIndex((p) => p.id === id);
  if (i === -1) i = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  return ALL_COLORS[i % ALL_COLORS.length];
}
const C = {
  text: "#e9edf6",
  muted: "#8a94a8",
  faint: "#56607a",
  grid: "rgba(255, 255, 255, 0.05)",
  zero: "rgba(233, 237, 246, 0.28)",
  green: "#38ffa0",
  magenta: "#ff2e7e",
  cyan: "#22e6ff",
  surface: "rgba(14, 19, 29, 0.96)",
  line: "#2b3550"
};

if (hasChart) {
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, Menlo, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = C.muted;
  Chart.defaults.animation.duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700;
} else {
  document.getElementById("charts-fallback").hidden = false;
}

const tooltipStyle = {
  backgroundColor: C.surface,
  borderColor: C.line,
  borderWidth: 1,
  titleColor: C.text,
  bodyColor: C.text,
  footerColor: C.muted,
  titleFont: { weight: "600" },
  footerFont: { weight: "400" },
  padding: 10,
  cornerRadius: 10,
  boxPadding: 4,
  usePointStyle: true
};

// bagliore neon sulle serie che lo richiedono (dataset._glow)
const glowPlugin = {
  id: "neonGlow",
  beforeDatasetDraw(chart, args) {
    const ds = chart.data.datasets[args.index];
    if (!ds._glow) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = typeof ds._glow === "string" ? ds._glow : ds.borderColor;
    ctx.shadowBlur = 12;
  },
  afterDatasetDraw(chart, args) {
    if (chart.data.datasets[args.index]._glow) chart.ctx.restore();
  }
};

// etichetta col nome alla fine delle linee evidenziate (dataset._hl)
const endLabelPlugin = {
  id: "endLabels",
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const items = [];
    chart.data.datasets.forEach((ds, i) => {
      if (!ds._hl) return;
      const meta = chart.getDatasetMeta(i);
      const pt = meta.data[meta.data.length - 1];
      if (pt) items.push({ x: pt.x, y: pt.y, label: ds.label, color: ds.borderColor, dim: ds._dim });
    });
    items.sort((a, b) => a.y - b.y);
    const GAP = 15;
    for (let i = 1; i < items.length; i++) {
      if (items[i].y - items[i - 1].y < GAP) items[i].y = items[i - 1].y + GAP;
    }
    // se le etichette sforano in basso, le fa risalire tutte insieme
    const area = chart.chartArea;
    if (items.length && area) {
      const over = items[items.length - 1].y - (area.bottom + 6);
      if (over > 0) items.forEach((it) => { it.y = Math.max(area.top - 4, it.y - over); });
    }
    ctx.save();
    ctx.font = "600 11px 'Inter', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const it of items) {
      ctx.globalAlpha = it.dim ? 0.3 : 1;
      ctx.fillStyle = it.color;
      ctx.beginPath();
      ctx.arc(it.x + 9, it.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.fillText(it.label, it.x + 16, it.y);
    }
    ctx.restore();
  }
};

const moneyTick = (v) => fmtNet(v);

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

function renderCharts(stats, ins) {
  document.querySelectorAll("#charts .chart-box").forEach((b) => b.classList.add("ready"));
  if (!hasChart) return;
  renderTrendChips(ins);
  renderTrendChart(ins);
  renderNetChart(ins);
}

function ensureTrendDefaults(ins) {
  const activeIds = new Set(ins.active.map((s) => s.id));
  // toglie dagli slot chi non esiste più
  state.trendSlots = state.trendSlots.map((id) => (id && activeIds.has(id) ? id : null));
  state.trendQueue = state.trendQueue.filter((id) => activeIds.has(id));
  if (state.trendFocus && !activeIds.has(state.trendFocus)) state.trendFocus = null;
  if (!state.trendInitialized && ins.active.length) {
    ins.active.slice(0, 3).forEach((s) => toggleTrend(s.id, false));
    state.trendInitialized = true;
  }
}

function toggleTrend(id, rerender = true) {
  const at = state.trendSlots.indexOf(id);
  if (at !== -1) {
    state.trendSlots[at] = null;
    state.trendQueue = state.trendQueue.filter((x) => x !== id);
  } else {
    let slot = state.trendSlots.indexOf(null);
    if (slot === -1) {
      // tutti pieni: libera lo slot del giocatore selezionato da più tempo
      const oldest = state.trendQueue.shift();
      slot = state.trendSlots.indexOf(oldest);
    }
    state.trendSlots[slot] = id;
    state.trendQueue.push(id);
  }
  if (rerender) {
    renderTrendChips(state.insights);
    renderTrendChart(state.insights);
  }
}

function toggleTrendAll() {
  // la selezione dei 6 resta memorizzata: togliendo "Tutti" si torna a quella
  state.trendAll = !state.trendAll;
  state.trendFocus = null;
  state.trendHover = null;
  renderTrendChips(state.insights);
  renderTrendChart(state.insights);
}

function onTrendChipClick(id) {
  if (!state.trendAll) {
    toggleTrend(id);
    return;
  }
  // in modalità "Tutti" il chip mette in risalto (o toglie il risalto a) un giocatore
  state.trendFocus = state.trendFocus === id ? null : id;
  renderTrendChips(state.insights);
  applyTrendFocus();
}

function renderTrendChips(ins) {
  ensureTrendDefaults(ins);
  const row = document.getElementById("trend-chips");
  const sub = document.getElementById("trend-sub");
  sub.textContent = state.trendAll
    ? "Netto accumulato sessione dopo sessione · tocca un nome o una linea per metterla in risalto"
    : `Netto accumulato sessione dopo sessione · evidenzia fino a ${MAX_HIGHLIGHT} giocatori, oppure tutti`;
  row.innerHTML = "";

  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip chip-all";
  all.setAttribute("aria-pressed", String(state.trendAll));
  all.innerHTML = `<span class="chip-dot"></span>Tutti`;
  all.addEventListener("click", toggleTrendAll);
  row.appendChild(all);

  for (const s of ins.active) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    if (state.trendAll) {
      b.setAttribute("aria-pressed", "true");
      b.style.setProperty("--cc", allColor(s.id));
      if (state.trendFocus && state.trendFocus !== s.id) b.classList.add("chip-dim");
    } else {
      const slot = state.trendSlots.indexOf(s.id);
      b.setAttribute("aria-pressed", String(slot !== -1));
      if (slot !== -1) b.style.setProperty("--cc", allColor(s.id));
    }
    b.innerHTML = `<span class="chip-dot"></span>${escapeHtml(s.nome)}`;
    b.addEventListener("click", () => onTrendChipClick(s.id));
    row.appendChild(b);
  }
}

// modalità "Tutti": attenua tutte le linee tranne quella in risalto
function applyTrendFocus() {
  const chart = charts.trend;
  if (!chart || !state.trendAll) return;
  const focus = state.trendHover || state.trendFocus;
  chart.data.datasets.forEach((ds) => {
    const on = !focus || ds._id === focus;
    ds.borderColor = on ? ds._color : ds._color + "2e";
    ds.borderWidth = focus && on ? 3 : 1.75;
    ds.order = focus && on ? 0 : 1;
    ds._dim = !on;
    ds._glow = focus && on ? ds._color : false;
  });
  chart.update("none");
}

function renderTrendChart(ins) {
  destroyChart("trend");
  const recapLabel = !!ins.recap;
  const labels = [recapLabel ? "Pre-sito" : "Inizio", ...ins.sorted.map((s) => fmtDateAxis(s.data))];
  const fullDates = [recapLabel ? "Recap pre-sito" : "Inizio", ...ins.sorted.map((s) => fmtDate(s.data))];
  const allMode = state.trendAll;

  const datasets = ins.active.map((s) => {
    if (allMode) {
      const color = allColor(s.id);
      return {
        label: s.nome,
        data: s.cumulative,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 1.75,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: "#070a10",
        tension: 0.3,
        order: 1,
        _id: s.id,
        _color: color,
        _hl: true,
        _glow: false
      };
    }
    const slot = state.trendSlots.indexOf(s.id);
    const hl = slot !== -1;
    const color = hl ? allColor(s.id) : "rgba(138, 148, 168, 0.22)";
    return {
      label: s.nome,
      data: s.cumulative,
      borderColor: color,
      backgroundColor: color,
      borderWidth: hl ? 2.5 : 1.25,
      pointRadius: 0,
      pointHoverRadius: hl ? 5 : 0,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: "#070a10",
      tension: 0.3,
      order: hl ? 0 : 1,
      _id: s.id,
      _hl: hl,
      _glow: hl ? color : false
    };
  });
  const anyHl = datasets.some((d) => d._hl);

  // con tutte le linee colorate il tooltip mostra solo la linea più vicina
  const interaction = allMode
    ? { mode: "nearest", intersect: false, axis: "xy" }
    : { mode: "index", intersect: false };

  const canvas = document.getElementById("trend-chart");
  charts.trend = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: anyHl ? 70 : 8, top: 8 } },
      interaction,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle,
          filter: (item) => item.dataset._hl,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            title: (items) => (items.length ? fullDates[items[0].dataIndex] : ""),
            label: (item) => ` ${item.dataset.label}  ${fmtNet(item.parsed.y)}`,
            labelColor: (item) => {
              const c = item.dataset._color || item.dataset.borderColor;
              return { borderColor: c, backgroundColor: c };
            }
          }
        }
      },
      onHover: allMode
        ? (evt, active, chart) => {
            const id = active.length ? chart.data.datasets[active[0].datasetIndex]._id : null;
            if (id !== state.trendHover) {
              state.trendHover = id;
              applyTrendFocus();
            }
          }
        : undefined,
      scales: {
        x: {
          grid: { display: false },
          border: { color: C.line },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, color: C.faint }
        },
        y: {
          grid: { color: (c) => (c.tick && c.tick.value === 0 ? C.zero : C.grid) },
          border: { display: false },
          ticks: { callback: moneyTick, maxTicksLimit: 7 }
        }
      }
    },
    plugins: [glowPlugin, endLabelPlugin]
  });

  if (allMode) applyTrendFocus();
}

// quando il mouse esce dal grafico si torna al risalto scelto col chip
document.getElementById("trend-chart")?.addEventListener("mouseleave", () => {
  if (state.trendAll && state.trendHover) {
    state.trendHover = null;
    applyTrendFocus();
  }
});

function renderNetChart(ins) {
  destroyChart("net");
  const rows = [...ins.active].sort((a, b) => b.netto - a.netto);
  const box = document.getElementById("net-box");
  box.style.height = `${Math.max(240, rows.length * 26 + 40)}px`;
  const colors = rows.map((s) => (s.netto >= 0 ? C.green : C.magenta));

  charts.net = new Chart(document.getElementById("net-chart"), {
    type: "bar",
    data: {
      labels: rows.map((s) => s.nome),
      datasets: [{
        data: rows.map((s) => Math.round(s.netto)),
        backgroundColor: colors.map((c) => c + "b3"),
        hoverBackgroundColor: colors,
        borderRadius: 4,
        borderSkipped: "start",
        barPercentage: 0.72,
        categoryPercentage: 0.9
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false, axis: "y" },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle,
          displayColors: false,
          callbacks: {
            label: (item) => `Netto ${fmtNet(rows[item.dataIndex].netto)}`,
            afterLabel: (item) => `Rendimento ${fmtPct(rows[item.dataIndex].percentuale)} · ${rows[item.dataIndex].sessioniGiocate} sessioni`
          }
        }
      },
      scales: {
        x: {
          grid: { color: (c) => (c.tick && c.tick.value === 0 ? C.zero : C.grid) },
          border: { display: false },
          ticks: { callback: moneyTick, maxTicksLimit: 6 }
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: C.text, font: { family: "'Inter', system-ui, sans-serif", size: 12 } }
        }
      },
      onClick: (evt, _els, chart) => {
        const hit = chart.getElementsAtEventForMode(evt, "index", { intersect: false, axis: "y" }, true);
        if (hit.length) openPlayerDrawer(rows[hit[0].index].id);
      },
      onHover: (evt, els, chart) => { chart.canvas.style.cursor = "pointer"; }
    }
  });
}

// ----------------------------------------------------------------------------
// 10. SCHEDA GIOCATORE
// ----------------------------------------------------------------------------
const drawer = document.getElementById("player-drawer");

function openPlayerDrawer(playerId) {
  const s = state.stats.find((x) => x.id === playerId);
  if (!s) return;
  const drawerAvatar = document.getElementById("drawer-avatar");
  paintAvatar(drawerAvatar, s.id, s.nome);
  drawerAvatar.dataset.playerId = s.id;
  drawerAvatar.dataset.playerName = s.nome;
  drawerAvatar.disabled = !avatarUrl(s.id, s.nome); // senza immagine non c'è niente da ingrandire
  setName(document.getElementById("drawer-name"), s.id, s.nome);
  document.getElementById("drawer-rank").innerHTML =
    `#${s.rank} in classifica · score ${s.score.toFixed(2)} ${moveMarkup(s.move)}`;

  const badges = document.getElementById("drawer-badges");
  badges.innerHTML = "";
  s.badges.forEach((b) => badges.appendChild(badgeEl(b.label, b.color, "", b.icon, b.title)));
  if (s.penalizzato) badges.appendChild(badgeEl("Poche presenze", null, "badge-absent"));

  const has = s.sessioniGiocate > 0;
  const recapFoot = s.inRecap ? `recap pre-sito ${fmtNet(s.recapNet)}` : `uscite ${fmtMoney(s.totaleOut)}`;
  const kpis = [
    { label: "Netto", value: fmtNet(s.netto), cls: valueClass(s.netto), foot: recapFoot },
    { label: "ROI", value: fmtPct(s.percentuale), cls: valueClass(s.percentuale), foot: `su ${fmtMoney(s.totaleIn)} giocati` },
    { label: "Sessioni", value: String(s.sessioniGiocate), cls: "", foot: has ? `${s.sessioniVinte} in attivo (${Math.round(s.winRate)}%)` : "nessuna" },
    { label: "Serie", value: fmtStreak(s), cls: streakClass(s.streak), foot: s.streak.type === "W" ? "vittorie di fila" : s.streak.type === "L" ? "sconfitte di fila" : "in corso" },
    { label: "Migliore", value: s.best ? fmtNet(s.best.net) : "—", cls: s.best ? valueClass(s.best.net) : "", foot: s.best ? fmtDateShort(s.best.data) : "" },
    { label: "Peggiore", value: s.worst ? fmtNet(s.worst.net) : "—", cls: s.worst ? valueClass(s.worst.net) : "", foot: s.worst ? fmtDateShort(s.worst.data) : "" },
    { label: "Media", value: has ? fmtNet(s.mediaNetto) : "—", cls: valueClass(s.mediaNetto), foot: has ? `buy-in medio ${fmtMoney(s.mediaBuyIn)}` : "" },
    { label: "Swing", value: s.swing ? `±€${Math.round(s.swing)}` : "—", cls: "", foot: "oscillazione tipica" }
  ];
  const kpiEl = document.getElementById("drawer-kpis");
  kpiEl.innerHTML = kpis.map((k) => `
    <div class="drawer-kpi">
      <span class="recap-label">${k.label}</span>
      <span class="recap-value ${k.cls}">${k.value}</span>
      <span class="drawer-kpi-foot">${k.foot}</span>
    </div>`).join("");

  const list = document.getElementById("drawer-sessions");
  list.innerHTML = "";
  if (!has) list.innerHTML = `<li><span class="ds-date">Nessuna sessione giocata</span></li>`;
  const recente = [...s.results].reverse().slice(0, 8);
  if (s.inRecap && state.insights.recap) {
    const g = state.insights.recap.giocatori.find((x) => x.playerId === s.id);
    recente.push({ recap: true, data: state.insights.recap.data, in: g.in, out: g.out, net: g.out - g.in });
  }
  if (!has && recente.length) list.innerHTML = "";
  recente.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="ds-date">${r.recap ? "Recap pre-sito" : fmtDate(r.data)}</span>
      <span class="ds-inout">${fmtMoney(r.in)} → ${fmtMoney(r.out)}</span>
      <span class="ds-net ${valueClass(r.net)}">${fmtNet(r.net)}</span>`;
    list.appendChild(li);
  });

  drawer.hidden = false;
  document.body.style.overflow = "hidden";
  renderDrawerCharts(s);
  document.getElementById("close-drawer-btn").focus();
}

function closePlayerDrawer() {
  drawer.hidden = true;
  document.body.style.overflow = "";
  destroyChart("drawerTrend");
  destroyChart("drawerBars");
  destroyChart("drawerRadar");
}

function renderDrawerRadar(s) {
  destroyChart("drawerRadar");
  setRadarFlipped(false, false); // ogni scheda si apre dal lato del grafico
  const block = document.getElementById("drawer-radar-block");
  block.hidden = !s.radar || !hasChart;
  if (block.hidden) return;
  const ins = state.insights;
  const color = allColor(s.id);
  const datasets = [{
    label: s.nome,
    data: s.radar.values,
    borderColor: color,
    backgroundColor: color + "33",
    borderWidth: 2,
    pointBackgroundColor: color,
    pointBorderColor: "#070a10",
    pointRadius: 3.5,
    pointHoverRadius: 5
  }];
  if (ins.radarAvg) {
    datasets.push({
      label: "Media del gruppo",
      data: ins.radarAvg,
      borderColor: "rgba(138, 148, 168, 0.8)",
      backgroundColor: "rgba(138, 148, 168, 0.06)",
      borderWidth: 1.5,
      borderDash: [4, 4],
      pointRadius: 0,
      pointHoverRadius: 3
    });
  }
  charts.drawerRadar = new Chart(document.getElementById("drawer-radar"), {
    type: "radar",
    data: { labels: ins.radarAxes, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { color: C.muted, boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { family: "'Inter', system-ui, sans-serif", size: 11 } }
        },
        tooltip: {
          ...tooltipStyle,
          callbacks: {
            label: (item) => item.datasetIndex === 0
              ? ` ${item.parsed.r}/100 · ${s.radar.raw[item.dataIndex]}`
              : ` media ${item.parsed.r}/100`,
            labelColor: (item) => ({ borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor })
          }
        }
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { display: false, stepSize: 25 },
          grid: { color: "rgba(255, 255, 255, 0.07)" },
          angleLines: { color: "rgba(255, 255, 255, 0.07)" },
          pointLabels: { color: C.text, font: { family: "'Inter', system-ui, sans-serif", size: 11, weight: "600" } }
        }
      }
    }
  });
}

function renderDrawerCharts(s) {
  destroyChart("drawerTrend");
  destroyChart("drawerBars");
  renderDrawerRadar(s);
  if (!hasChart) return;

  const labels = [s.inRecap ? "Pre-sito" : "Inizio", ...s.results.map((r) => fmtDateAxis(r.data))];
  const cum = [s.recapNet || 0];
  s.results.forEach((r) => cum.push(cum[cum.length - 1] + r.net));
  const color = s.netto >= 0 ? C.green : C.magenta;
  const baseScales = {
    x: { grid: { display: false }, border: { color: C.line }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 5, color: C.faint } },
    y: { grid: { color: (c) => (c.tick && c.tick.value === 0 ? C.zero : C.grid) }, border: { display: false }, ticks: { callback: moneyTick, maxTicksLimit: 5 } }
  };

  charts.drawerTrend = new Chart(document.getElementById("drawer-trend"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: s.nome,
        data: cum,
        borderColor: color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: "#070a10",
        fill: "origin",
        backgroundColor: (c) => {
          const { ctx, chartArea } = c.chart;
          if (!chartArea) return color + "22";
          const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, color + "40");
          g.addColorStop(1, color + "00");
          return g;
        },
        _glow: color
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle, displayColors: false, callbacks: { label: (i) => `Saldo ${fmtNet(i.parsed.y)}` } }
      },
      scales: baseScales
    },
    plugins: [glowPlugin]
  });

  charts.drawerBars = new Chart(document.getElementById("drawer-bars"), {
    type: "bar",
    data: {
      labels: s.results.map((r) => fmtDateAxis(r.data)),
      datasets: [{
        data: s.results.map((r) => r.net),
        backgroundColor: s.results.map((r) => (r.net >= 0 ? C.green : C.magenta) + "b3"),
        hoverBackgroundColor: s.results.map((r) => (r.net >= 0 ? C.green : C.magenta)),
        borderRadius: 4,
        borderSkipped: "start",
        barPercentage: 0.8,
        categoryPercentage: 0.9
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle,
          displayColors: false,
          callbacks: {
            title: (items) => (items.length ? fmtDate(s.results[items[0].dataIndex].data) : ""),
            label: (i) => `${fmtNet(s.results[i.dataIndex].net)}  (${fmtMoney(s.results[i.dataIndex].in)} → ${fmtMoney(s.results[i.dataIndex].out)})`
          }
        }
      },
      scales: baseScales
    }
  });
}

document.getElementById("close-drawer-btn")?.addEventListener("click", closePlayerDrawer);

// PROFILO RADAR: la "i" gira la card e mostra la spiegazione delle voci
const radarFlip = document.getElementById("radar-flip");
const radarInfoBtn = document.getElementById("radar-info-btn");
const radarCloseBtn = document.getElementById("radar-info-close");
function setRadarFlipped(on, moveFocus = true) {
  if (!radarFlip || !radarInfoBtn || !radarCloseBtn) return;
  // il retro è più lungo del grafico: la card si allunga quanto serve
  const inner = radarFlip.querySelector(".flip-inner");
  const back = document.getElementById("radar-back");
  inner.style.height = on ? `${Math.max(310, back.scrollHeight + 2)}px` : "";
  radarFlip.classList.toggle("flipped", on);
  radarInfoBtn.setAttribute("aria-expanded", String(on));
  document.getElementById("radar-back").setAttribute("aria-hidden", String(!on));
  radarInfoBtn.tabIndex = on ? -1 : 0;
  radarCloseBtn.tabIndex = on ? 0 : -1;
  if (moveFocus) (on ? radarCloseBtn : radarInfoBtn).focus({ preventScroll: true });
}
radarInfoBtn?.addEventListener("click", () => setRadarFlipped(true));
radarCloseBtn?.addEventListener("click", () => setRadarFlipped(false));
drawer?.addEventListener("click", (e) => { if (e.target === drawer) closePlayerDrawer(); });

// ----------------------------------------------------------------------------
// 11. NAVIGAZIONE E ANIMAZIONI
// ----------------------------------------------------------------------------
function setupNav() {
  const links = [...document.querySelectorAll(".nav-link")];
  const byId = new Map(links.map((l) => [l.getAttribute("href").slice(1), l]));
  const obs = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((l) => l.classList.remove("active"));
      const link = byId.get(entry.target.id);
      if (link) link.classList.add("active");
    }
  }, { rootMargin: "-40% 0px -55% 0px" });
  document.querySelectorAll("main .section[id]").forEach((sec) => obs.observe(sec));
}

// applica un'animazione di comparsa (fade + slide up) alle card man mano
// che entrano nel viewport durante lo scroll
let revealObserver = null;
function setupScrollReveal() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (window.matchMedia("(max-width: 640px)").matches) return; // disattivata su mobile: risultava laggy
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12 });
  }
  const targets = document.querySelectorAll(".recap-card, .rank-item, .award, .chart-panel");
  targets.forEach((el, i) => {
    if (el.classList.contains("in-view")) return;
    el.classList.add("reveal");
    el.style.transitionDelay = `${Math.min(i * 30, 300)}ms`;
    revealObserver.observe(el);
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawAllSparklines, 150);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (mvpOverlay && !mvpOverlay.hidden) { closeMvpCelebration(); return; }
  if (lightbox && !lightbox.hidden) { closeAvatarLightbox(); return; }
  if (!confirmModal.hidden) { confirmModal.hidden = true; state.pendingDeleteSessionId = null; return; }
  if (!loginModal.hidden) { loginModal.hidden = true; return; }
  if (!drawer.hidden) { closePlayerDrawer(); return; }
  if (!adminPanel.hidden) closeAdminPanel();
});

// ----------------------------------------------------------------------------
// 12. AUTENTICAZIONE
// ----------------------------------------------------------------------------
const authToggleBtn = document.getElementById("auth-toggle-btn");
const newSessionBtn = document.getElementById("new-session-btn");
const loginModal = document.getElementById("login-modal");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const adminPanel = document.getElementById("admin-panel");

function updateAuthUI() {
  authToggleBtn.textContent = state.isAuthenticated ? "Esci" : "Accedi";
  newSessionBtn.hidden = !state.isAuthenticated;
  // tutto ciò che è "solo admin" nel CSS dipende da questa classe, così si
  // aggiorna subito anche se la pagina non viene ridisegnata
  document.body.classList.toggle("is-admin", state.isAuthenticated);
  document.querySelectorAll(".session-edit-btn, .session-delete-btn").forEach((b) => { b.hidden = !state.isAuthenticated; });
}

newSessionBtn?.addEventListener("click", () => {
  openAdminPanel();
});

authToggleBtn?.addEventListener("click", async () => {
  if (state.isAuthenticated) {
    if (!isDemoMode) await signOut(auth);
    state.isAuthenticated = false;
    updateAuthUI();
    closeAdminPanel();
    renderAll();
    return;
  }
  loginError.textContent = "";
  loginModal.hidden = false;
});

document.getElementById("close-login-btn")?.addEventListener("click", () => {
  loginModal.hidden = true;
});

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  if (isDemoMode) {
    // in demo qualunque credenziale "finta" ma non vuota fa accedere,
    // giusto per poter mostrare come si comporta l'interfaccia da autenticati
    if (!email || !password) {
      loginError.textContent = "Inserisci email e password.";
      return;
    }
    state.isAuthenticated = true;
    loginModal.hidden = true;
    updateAuthUI();
    renderAll();
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, password);
    loginModal.hidden = true;
  } catch (err) {
    loginError.textContent = "Credenziali non valide.";
  }
});

if (!isDemoMode) {
  onAuthStateChanged(auth, (user) => {
    state.isAuthenticated = !!user;
    updateAuthUI();
    // i dati non sono ancora arrivati: ridisegna init() appena pronti
    if (!state.dataLoaded) return;
    try {
      renderAll();
    } catch (err) {
      console.error("[PokerStats] errore durante il disegno della pagina:", err);
    }
  });
}

// session = null -> nuova sessione; altrimenti il form si apre già compilato
// con i dati della sessione da modificare
function openAdminPanel(session = null) {
  state.editingSessionId = session ? session.id : null;
  document.getElementById("admin-eyebrow").textContent = session ? "♠ Correggi risultati" : "♠ Registra risultati";
  const isRecap = !!session && session.id === findRecapId(state.sessions);
  document.getElementById("admin-title").textContent = session
    ? (isRecap ? "Modifica recap pre-sito" : `Modifica ${fmtDate(session.data)}`)
    : "Nuova sessione";
  document.getElementById("session-submit-btn").textContent = session ? "Salva modifiche" : "Salva sessione";
  document.getElementById("session-form-error").textContent = "";
  document.getElementById("session-form-error").classList.remove("form-warn");
  state.dupConfirm = null;

  adminPanel.hidden = false;
  buildPlayerRows(session);
  updateFormBalance();
  const d = session ? session.data : new Date();
  document.getElementById("session-day").value = d.getDate();
  document.getElementById("session-month").value = d.getMonth() + 1;
  document.getElementById("session-year").value = d.getFullYear();
  document.querySelector(".session-form-body").scrollTop = 0;
}

function closeAdminPanel() {
  adminPanel.hidden = true;
  state.editingSessionId = null;
}

document.getElementById("close-admin-btn")?.addEventListener("click", closeAdminPanel);

// ----------------------------------------------------------------------------
// 13. FORM NUOVA SESSIONE / MODIFICA SESSIONE
// ----------------------------------------------------------------------------
function buildPlayerRows(session = null) {
  const container = document.getElementById("player-rows");
  const tpl = document.getElementById("player-row-template");
  container.innerHTML = "";

  const inSession = new Map((session ? session.giocatori : []).map((g) => [g.playerId, g]));
  // in modifica, chi ha giocato ma non è più nella lista giocatori resta comunque
  // nel form, così salvando non viene cancellato dalla sessione
  const extra = [...inSession.values()]
    .filter((g) => !state.players.some((p) => p.id === g.playerId))
    .map((g) => ({ id: g.playerId, nome: g.nome }));
  // i partecipanti in cima, così si vedono subito
  const list = [...state.players, ...extra].sort((a, b) => Number(inSession.has(b.id)) - Number(inSession.has(a.id)));

  list.forEach((player) => {
    const node = tpl.content.cloneNode(true);
    const row = node.querySelector(".player-row");
    row.dataset.playerId = player.id;
    row.dataset.playerName = player.nome;
    node.querySelector(".player-toggle-name").textContent = player.nome;

    const checkbox = node.querySelector(".player-participates");
    const amounts = node.querySelector(".player-amounts");
    checkbox.addEventListener("change", () => {
      amounts.hidden = !checkbox.checked;
      row.classList.toggle("active", checkbox.checked);
      updateFormBalance();
    });

    const played = inSession.get(player.id);
    if (played) {
      checkbox.checked = true;
      amounts.hidden = false;
      row.classList.add("active");
      node.querySelector(".player-in").value = String(played.in).replace(".", ",");
      node.querySelector(".player-out").value = String(played.out).replace(".", ",");
    }

    container.appendChild(node);
  });
}

// controllo dei conti in tempo reale: somma entrate e uscite dei partecipanti
function updateFormBalance() {
  const el = document.getElementById("form-balance");
  let totIn = 0;
  let totOut = 0;
  let n = 0;
  document.querySelectorAll("#player-rows .player-row").forEach((row) => {
    if (!row.querySelector(".player-participates").checked) return;
    n++;
    const i = parseAmount(row.querySelector(".player-in").value);
    const o = parseAmount(row.querySelector(".player-out").value);
    if (!Number.isNaN(i)) totIn += i;
    if (!Number.isNaN(o)) totOut += o;
  });
  if (n === 0) {
    el.innerHTML = "";
    return;
  }
  const diff = totOut - totIn;
  const status = Math.abs(diff) < 0.005
    ? `<span class="conti-ok">Conti in pari ✓</span>`
    : `<span class="conti-warn">Differenza ${fmtDiff(diff)}</span>`;
  el.innerHTML = `<span>${n} giocatori · In ${fmtDiff(totIn).replace("+", "")} · Out ${fmtDiff(totOut).replace("+", "")}</span>${status}`;
}

document.getElementById("player-rows")?.addEventListener("input", updateFormBalance);

document.getElementById("session-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("session-form-error");
  errorEl.textContent = "";
  errorEl.classList.remove("form-warn");

  const day = Number(document.getElementById("session-day").value);
  const month = Number(document.getElementById("session-month").value);
  const year = Number(document.getElementById("session-year").value);

  if (!day || !month || !year || day < 1 || day > 31 || month < 1 || month > 12 || year < 2000 || year > 2100) {
    errorEl.textContent = "Inserisci una data valida (giorno, mese, anno).";
    return;
  }

  const dateValue = new Date(year, month - 1, day);
  // controllo che la data sia effettivamente esistita (es. 31/04 non è valido)
  if (dateValue.getDate() !== day || dateValue.getMonth() !== month - 1 || dateValue.getFullYear() !== year) {
    errorEl.textContent = "La data inserita non esiste.";
    return;
  }

  // AVVISO DATA DOPPIA: se esiste già un'altra sessione nello stesso giorno,
  // il primo "Salva" avvisa e il secondo conferma
  const sameDay = state.sessions.find((s) =>
    s.id !== state.editingSessionId &&
    s.data.getFullYear() === year && s.data.getMonth() === month - 1 && s.data.getDate() === day);
  const dayKey = `${year}-${month}-${day}`;
  if (sameDay && state.dupConfirm !== dayKey) {
    state.dupConfirm = dayKey;
    errorEl.classList.add("form-warn");
    errorEl.textContent = `Esiste già una sessione del ${fmtDate(sameDay.data)}. Se è davvero un'altra serata, premi di nuovo «${document.getElementById("session-submit-btn").textContent}» per confermare.`;
    return;
  }

  const rows = document.querySelectorAll("#player-rows .player-row");
  const giocatori = [];
  for (const row of rows) {
    const checked = row.querySelector(".player-participates").checked;
    if (!checked) continue;
    const inVal = parseAmount(row.querySelector(".player-in").value);
    const outVal = parseAmount(row.querySelector(".player-out").value);
    if (Number.isNaN(inVal) || Number.isNaN(outVal) || inVal < 0 || outVal < 0) {
      errorEl.textContent = `Controlla i valori inseriti per ${row.dataset.playerName}.`;
      return;
    }
    giocatori.push({ playerId: row.dataset.playerId, nome: row.dataset.playerName, in: inVal, out: outVal });
  }

  if (giocatori.length === 0) {
    errorEl.textContent = "Seleziona almeno un giocatore partecipante.";
    return;
  }

  try {
    if (state.editingSessionId) {
      await updateSession(state.editingSessionId, dateValue, giocatori);
    } else {
      await createSession(dateValue, giocatori);
    }
    closeAdminPanel();
    state.sessions = await fetchSessions();
    renderAll();
  } catch (err) {
    errorEl.textContent = err && err.code === "permission-denied"
      ? "Permesso negato da Firebase: controlla le regole di sicurezza di Firestore."
      : "Errore durante il salvataggio. Riprova.";
  }
});

// ----------------------------------------------------------------------------
// 14. ELIMINAZIONE SESSIONE + MODALE DI CONFERMA (la modifica è nel form, sez. 13)
// ----------------------------------------------------------------------------
const confirmModal = document.getElementById("confirm-modal");
const confirmText = document.getElementById("confirm-modal-text");

function openConfirmModal(sessionId, date) {
  state.pendingDeleteSessionId = sessionId;
  confirmText.textContent = sessionId === findRecapId(state.sessions)
    ? "Il recap pre-sito verrà eliminato definitivamente: la sessione più vecchia rimasta diventerà il nuovo recap."
    : `La sessione del ${fmtDate(date)} verrà eliminata definitivamente.`;
  confirmModal.hidden = false;
}

document.getElementById("confirm-cancel-btn")?.addEventListener("click", () => {
  confirmModal.hidden = true;
  state.pendingDeleteSessionId = null;
});

document.getElementById("confirm-delete-btn")?.addEventListener("click", async () => {
  if (!state.pendingDeleteSessionId) return;
  try {
    await deleteSessionById(state.pendingDeleteSessionId);
    state.sessions = await fetchSessions();
    renderAll();
  } finally {
    confirmModal.hidden = true;
    state.pendingDeleteSessionId = null;
  }
});

// ----------------------------------------------------------------------------
// 15. INIZIALIZZAZIONE
// ----------------------------------------------------------------------------
async function init() {
  setupNav();
  try {
    [state.players, state.sessions] = await Promise.all([fetchPlayers(), fetchSessions(), loadAvatars()]);
  } catch (err) {
    // niente dati (rete assente o Firebase non raggiungibile): via le sagome
    // di caricamento e messaggio chiaro
    console.error("[PokerStats] errore nel caricamento dei dati:", err);
    document.querySelectorAll(".skel-host").forEach((el) => { el.innerHTML = ""; });
    document.getElementById("hero-sub").textContent =
      `Impossibile caricare i dati (${err && err.code ? err.code : "errore di rete"}): controlla la connessione e ricarica la pagina.`;
    return;
  }
  state.dataLoaded = true;
  try {
    renderAll();
  } catch (err) {
    console.error("[PokerStats] errore durante il disegno della pagina:", err);
    document.getElementById("hero-sub").textContent =
      `Errore nel disegnare la pagina: ${err && err.message ? err.message : err}. Prova a ricaricare con Cmd+Shift+R.`;
    return;
  }
  window.__psReady = true;
  setTimeout(maybeCelebrateMvp, 700);
}

init();

// SERVICE WORKER (sw.js): salva sul telefono i file che non cambiano, così il
// sito si apre più in fretta e funziona anche senza rete (i dati no).
// Attivo solo sul sito pubblicato (https, es. GitHub Pages). In locale (server
// di VS Code) viene disattivato e le sue copie cancellate, per non vedere mai
// file vecchi mentre si lavora.
try {
  if ("serviceWorker" in navigator) {
    const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(location.hostname) || location.protocol !== "https:";
    if (isLocal) {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if (window.caches) {
        caches.keys()
          .then((keys) => keys.filter((k) => k.startsWith("pokerstats-")).forEach((k) => caches.delete(k)))
          .catch(() => {});
      }
    } else {
      window.addEventListener("load", () => {
        try {
          navigator.serviceWorker.register("./sw.js").catch(() => {});
        } catch (err) { /* non disponibile: nessun problema */ }
      });
    }
  }
} catch (err) {
  // browser o anteprima che non lo permettono: il sito funziona lo stesso
}
