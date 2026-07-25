// Firebase configuration - BRTFC Academy
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, push, update, remove, onValue, child }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAvjoLg50J-V2PvUAEfSYFRQLhc9Ld_O9I",
  authDomain: "brtfc-academy.firebaseapp.com",
  databaseURL: "https://brtfc-academy-default-rtdb.firebaseio.com",
  projectId: "brtfc-academy",
  storageBucket: "brtfc-academy.firebasestorage.app",
  messagingSenderId: "593239069533",
  appId: "1:593239069533:web:08e4ba7b1ac25a9a264eb4",
  measurementId: "G-TX97R668W8"
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

export { db, auth, ref, set, get, push, update, remove, onValue, child,
         signInWithEmailAndPassword, signOut, sendPasswordResetEmail, onAuthStateChanged };
