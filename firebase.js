// ============================================================
// firebase.js — Firebase Admin SDK Initialization
// Xavi Assistant | Xavi Tech
// ============================================================

const admin = require("firebase-admin");

// Read service account from Render environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "dev-clin-bot.firebasestorage.app",
  });
}

const db = admin.firestore();
const auth = admin.auth();
const storage = admin.storage();

module.exports = { admin, db, auth, storage };
