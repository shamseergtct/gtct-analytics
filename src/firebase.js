// src/firebase.js
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: "AIzaSyBrNIsJihV5XxsCx6VSUg2_SPpgqLK4QjE",
  authDomain: "gtct-global-analytics.firebaseapp.com",
  projectId: "gtct-global-analytics",
  storageBucket: "gtct-global-analytics.firebasestorage.app",
  messagingSenderId: "311665553348",
  appId: "1:311665553348:web:ffcd2bcf8ae36bf0477e91",
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);


// ✅ Debug check (see browser console)
console.log("🔥 Firebase Project:", app.options.projectId);
