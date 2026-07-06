// ============================================================================
// CONFIGURAZIONE FIREBASE
// ============================================================================
// Sostituisci i valori sotto con quelli del tuo progetto Firebase.
// Li trovi in: Console Firebase > Impostazioni progetto > Le tue app > SDK setup.
//
// Finché firebaseConfig.apiKey resta "YOUR_API_KEY", il sito parte
// automaticamente in MODALITÀ DEMO con dati di esempio (vedi app.js),
// così puoi vedere il design funzionante prima ancora di collegare il database.
// ============================================================================

const firebaseConfig = {
  apiKey: "AIzaSyDfq8fFwOAagXNkammcestHomVPqq4pyEM",
  authDomain: "pokerstats-992d4.firebaseapp.com",
  projectId: "pokerstats-992d4",
  storageBucket: "pokerstats-992d4.firebasestorage.app",
  messagingSenderId: "833201471358",
  appId: "1:833201471358:web:58d93563b7f07881e2fd2f"
};

// esposto globalmente così app.js (modulo) può leggerlo
window.__FIREBASE_CONFIG__ = firebaseConfig;
