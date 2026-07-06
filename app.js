// ============================================================================
// POKER TRACKER — app.js
// ============================================================================
// Indice:
//   1. Firebase init (con fallback demo)
//   2. Dati di esempio (usati solo in modalità demo)
//   3. Stato applicazione
//   4. Livello di accesso ai dati (Firestore oppure demo)
//   5. Calcolo statistiche/score  <-- isolato, da sostituire in futuro con
//                                      una Cloud Function onCreate/onDelete
//   6. Rendering (classifica, recap, storico, form)
//   7. Autenticazione
//   8. Form nuova sessione
//   9. Eliminazione sessione + modale di conferma
//  10. Inizializzazione
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
const DEMO_PLAYERS = Array.from({ length: 12 }, (_, i) => ({
  id: `demo-player-${i + 1}`,
  nome: `Giocatore ${String(i + 1).padStart(2, "0")}`
}));

function buildDemoSessions() {
  // genera ~8 sessioni fittizie con numeri plausibili, solo per anteprima design
  const sessions = [];
  const today = new Date();
  for (let s = 0; s < 8; s++) {
    const date = new Date(today);
    date.setDate(date.getDate() - s * 14);
    const numPartecipanti = 6 + (s % 5);
    const giocatori = DEMO_PLAYERS
      .slice(0, numPartecipanti)
      .map((p) => {
        const buyIn = 20 + (s * 3 + p.id.length) % 30;
        const cashOut = Math.max(0, buyIn + (((s * 7 + p.nome.length * 3) % 60) - 30));
        return { playerId: p.id, nome: p.nome, in: buyIn, out: cashOut };
      });
    sessions.push({
      id: `demo-session-${s + 1}`,
      data: date,
      giocatori
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
  isAuthenticated: false,
  pendingDeleteSessionId: null
};

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
function calculateStats(players, sessions) {
  const totals = {};
  for (const p of players) {
    totals[p.id] = { id: p.id, nome: p.nome, totaleIn: 0, totaleOut: 0 };
  }

  for (const session of sessions) {
    for (const g of session.giocatori) {
      if (!totals[g.playerId]) continue; // sicurezza: giocatore non più in lista
      totals[g.playerId].totaleIn += g.in;
      totals[g.playerId].totaleOut += g.out;
    }
  }

  const stats = Object.values(totals).map((t) => {
    const netto = t.totaleOut - t.totaleIn;
    const percentuale = t.totaleIn > 0 ? (netto / t.totaleIn) * 100 : 0;
    return { ...t, netto, percentuale };
  });

  const nettoValues = stats.map((s) => s.netto);
  const pctValues = stats.map((s) => s.percentuale);
  const nettoMin = Math.min(...nettoValues);
  const nettoMax = Math.max(...nettoValues);
  const pctMin = Math.min(...pctValues);
  const pctMax = Math.max(...pctValues);

  const normalize = (value, min, max) => (max === min ? 0.5 : (value - min) / (max - min));

  for (const s of stats) {
    const nettoNorm = normalize(s.netto, nettoMin, nettoMax);
    const pctNorm = normalize(s.percentuale, pctMin, pctMax);
    s.score = 0.7 * nettoNorm + 0.3 * pctNorm;
  }

  stats.sort((a, b) => b.score - a.score);
  return stats;
}

// ----------------------------------------------------------------------------
// 6. RENDERING
// ----------------------------------------------------------------------------
const fmtMoney = (n) => `${n >= 0 ? "" : "-"}€${Math.abs(Math.round(n))}`;
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const fmtNet = (n) => `${n >= 0 ? "+" : ""}€${Math.round(n)}`;
const valueClass = (n) => (n > 0 ? "value-positive" : n < 0 ? "value-negative" : "value-neutral");
const fmtDate = (d) => d.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });

// converte un testo inserito dall'utente (con virgola o punto come separatore
// decimale) in un numero. Restituisce NaN se il testo non è un numero valido.
function parseAmount(rawText) {
  const normalized = rawText.trim().replace(",", ".");
  if (normalized === "") return NaN;
  return Number(normalized);
}

function renderLeaderboard(stats) {
  const podiumEl = document.getElementById("podium");
  const listEl = document.getElementById("rank-list");
  const podiumTpl = document.getElementById("podium-item-template");
  const rankTpl = document.getElementById("rank-item-template");

  podiumEl.innerHTML = "";
  stats.slice(0, 3).forEach((s, i) => {
    const place = i + 1;
    const node = podiumTpl.content.cloneNode(true);
    const item = node.querySelector(".podium-item");
    item.dataset.place = String(place);
    // corona luminosa solo sul primo classificato
    item.querySelector(".podium-crown").textContent = place === 1 ? "♛" : "";
    // avatar con l'iniziale del nome
    item.querySelector(".podium-avatar").textContent = s.nome.trim().charAt(0).toUpperCase();
    item.querySelector(".podium-name").textContent = s.nome;
    item.querySelector(".podium-score").textContent = `score ${s.score.toFixed(2)}`;
    item.querySelector(".podium-rank").textContent = `#${place}`;
    podiumEl.appendChild(node);
  });

  listEl.innerHTML = "";
  stats.slice(3).forEach((s, i) => {
    const node = rankTpl.content.cloneNode(true);
    node.querySelector(".rank-number").textContent = `${i + 4}`;
    node.querySelector(".rank-name").textContent = s.nome;
    node.querySelector(".rank-score").textContent = `score ${s.score.toFixed(2)}`;
    listEl.appendChild(node);
  });
}

function renderRecap(stats) {
  const gridEl = document.getElementById("recap-grid");
  const tpl = document.getElementById("recap-card-template");
  // recap ordinato come la classifica (già ordinata per score)
  gridEl.innerHTML = "";
  stats.forEach((s) => {
    const node = tpl.content.cloneNode(true);
    node.querySelector(".recap-name").textContent = s.nome;
    node.querySelector(".recap-in").textContent = fmtMoney(s.totaleIn);
    node.querySelector(".recap-out").textContent = fmtMoney(s.totaleOut);
    const netEl = node.querySelector(".recap-net");
    netEl.textContent = fmtNet(s.netto);
    netEl.classList.add(valueClass(s.netto));
    const pctEl = node.querySelector(".recap-pct");
    pctEl.textContent = fmtPct(s.percentuale);
    pctEl.classList.add(valueClass(s.percentuale));
    gridEl.appendChild(node);
  });
}

function renderHistory(sessions) {
  const listEl = document.getElementById("session-list");
  const cardTpl = document.getElementById("session-card-template");
  const rowTpl = document.getElementById("session-row-template");

  const sorted = [...sessions].sort((a, b) => b.data - a.data);

  listEl.innerHTML = "";
  sorted.forEach((session) => {
    const node = cardTpl.content.cloneNode(true);
    node.querySelector(".session-date").textContent = fmtDate(session.data);

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
        row.querySelector(".session-row-name").textContent = g.nome;
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

    listEl.appendChild(node);
  });
}

function renderAll() {
  state.stats = calculateStats(state.players, state.sessions);
  renderLeaderboard(state.stats);
  renderRecap(state.stats);
  renderHistory(state.sessions);
  setupScrollReveal();
}

// applica un'animazione di comparsa (fade + slide up) alle card man mano
// che entrano nel viewport durante lo scroll
let revealObserver = null;
function setupScrollReveal() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
  const targets = document.querySelectorAll(".recap-card, .session-card, .rank-item");
  targets.forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = `${Math.min(i * 30, 300)}ms`;
    revealObserver.observe(el);
  });
}

// ----------------------------------------------------------------------------
// 7. AUTENTICAZIONE
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
}

newSessionBtn.addEventListener("click", () => {
  openAdminPanel();
});

authToggleBtn.addEventListener("click", async () => {
  if (state.isAuthenticated) {
    if (!isDemoMode) await signOut(auth);
    state.isAuthenticated = false;
    updateAuthUI();
    adminPanel.hidden = true;
    renderAll();
    return;
  }
  loginError.textContent = "";
  loginModal.hidden = false;
});

document.getElementById("close-login-btn").addEventListener("click", () => {
  loginModal.hidden = true;
});

loginForm.addEventListener("submit", async (e) => {
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
    openAdminPanel();
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
    renderAll();
    if (user) openAdminPanel();
  });
}

function openAdminPanel() {
  adminPanel.hidden = false;
  buildPlayerRows();
  const today = new Date();
  document.getElementById("session-day").value = today.getDate();
  document.getElementById("session-month").value = today.getMonth() + 1;
  document.getElementById("session-year").value = today.getFullYear();
}

document.getElementById("close-admin-btn").addEventListener("click", () => {
  adminPanel.hidden = true;
});

// ----------------------------------------------------------------------------
// 8. FORM NUOVA SESSIONE
// ----------------------------------------------------------------------------
function buildPlayerRows() {
  const container = document.getElementById("player-rows");
  const tpl = document.getElementById("player-row-template");
  container.innerHTML = "";

  state.players.forEach((player) => {
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
    });

    container.appendChild(node);
  });
}

document.getElementById("session-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("session-form-error");
  errorEl.textContent = "";

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
    await createSession(dateValue, giocatori);
    adminPanel.hidden = true;
    state.sessions = await fetchSessions();
    renderAll();
  } catch (err) {
    errorEl.textContent = "Errore durante il salvataggio. Riprova.";
  }
});

// ----------------------------------------------------------------------------
// 9. ELIMINAZIONE SESSIONE + MODALE DI CONFERMA
// ----------------------------------------------------------------------------
const confirmModal = document.getElementById("confirm-modal");
const confirmText = document.getElementById("confirm-modal-text");

function openConfirmModal(sessionId, date) {
  state.pendingDeleteSessionId = sessionId;
  confirmText.textContent = `La sessione del ${fmtDate(date)} verrà eliminata definitivamente.`;
  confirmModal.hidden = false;
}

document.getElementById("confirm-cancel-btn").addEventListener("click", () => {
  confirmModal.hidden = true;
  state.pendingDeleteSessionId = null;
});

document.getElementById("confirm-delete-btn").addEventListener("click", async () => {
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
// 10. INIZIALIZZAZIONE
// ----------------------------------------------------------------------------
async function init() {
  state.players = await fetchPlayers();
  state.sessions = await fetchSessions();
  renderAll();
}

init();
