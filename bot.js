require("dotenv").config();
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  getContentType,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const NodeCache = require("node-cache");
const { db } = require("./firebase");
const { FieldValue } = require("firebase-admin/firestore");
const fs = require("fs");
require("./keep-alive");

const sessions = {};
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: "silent" });

function getGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good Morning 🌅";
  if (h >= 12 && h < 17) return "Good Afternoon ☀️";
  return "Good Evening 🌙";
}
function phoneToJid(phone) { return `${phone.replace(/\D/g, "")}@s.whatsapp.net`; }
function getPhone(jid) { return jid.replace("@s.whatsapp.net", ""); }

// ── Firebase helpers ─────────────────────────────────────────
async function getSettings() {
  try {
    const snap = await db.collection("settings").doc("global").get();
    return snap.exists ? snap.data() : { botName: "Xavi Assistant", businessName: "Xavi Tech", paymentNumber: "0743810633", portfolioLink: "https://xavitech.com" };
  } catch (e) { return {}; }
}

async function getUser(phone) {
  try {
    const snap = await db.collection("users").doc(phone).get();
    return snap.exists ? snap.data() : null;
  } catch (e) { return null; }
}

async function createUser(phone, name) {
  try {
    const snap = await db.collection("users").get();
    const customerId = `Client ${String(snap.size + 1).padStart(3, "0")}`;
    const data = { phone, name, customerId, createdAt: FieldValue.serverTimestamp(), totalOrders: 0 };
    await db.collection("users").doc(phone).set(data);
    return data;
  } catch (e) { return null; }
}

async function getMenus() {
  try {
    const snap = await db.collection("menus").where("active", "==", true).orderBy("order").get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    try {
      const snap2 = await db.collection("menus").where("active", "==", true).get();
      return snap2.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }
}

async function getSubmenus(menuId) {
  try {
    const snap = await db.collection("menus").doc(menuId).collection("submenus").where("active", "==", true).orderBy("order").get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    try {
      const snap2 = await db.collection("menus").doc(menuId).collection("submenus").where("active", "==", true).get();
      return snap2.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }
}

async function getSubmenuItems(menuId, submenuId) {
  try {
    const snap = await db.collection("menus").doc(menuId).collection("submenus").doc(submenuId).collection("items").where("active", "==", true).orderBy("order").get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    try {
      const snap2 = await db.collection("menus").doc(menuId).collection("submenus").doc(submenuId).collection("items").where("active", "==", true).get();
      return snap2.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }
}

async function getPaymentModes() {
  try {
    const snap = await db.collection("paymentModes").where("active", "==", true).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function createOrder(phone, item, paymentMode) {
  try {
    const user = await getUser(phone);
    const ref = db.collection("orders").doc();
    const receipt = `XAV-${Date.now().toString().slice(-8)}`;
    await ref.set({ orderId: ref.id, receipt, phone, customerId: user?.customerId || "Unknown", username: user?.name || "Unknown", itemName: item.name, itemId: item.id, amount: item.price || 0, paymentMode, status: "pending_payment", createdAt: FieldValue.serverTimestamp() });
    return { orderId: ref.id, receipt };
  } catch (e) { return null; }
}

async function savePaymentProof(phone, orderId, note) {
  try { await db.collection("paymentProofs").add({ phone, orderId, note: note || "", status: "pending", submittedAt: FieldValue.serverTimestamp() }); } catch (e) {}
}

async function getCustomMenuReply(text) {
  try {
    const snap = await db.collection("customMenus").where("active", "==", true).get();
    const lower = text.toLowerCase();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.trigger && lower.includes(data.trigger.toLowerCase())) return data.reply;
    }
    return null;
  } catch { return null; }
}

// ── Message handler ──────────────────────────────────────────
async function handleMessage(sock, msg) {
  try {
    if (msg.key.remoteJid === "status@broadcast") return;
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    if (jid.endsWith("@g.us")) return;
    const phone = getPhone(jid);
    const type = getContentType(msg.message);

    if (type === "imageMessage") {
      const session = sessions[phone] || {};
      if (session.state === "awaiting_proof" && session.order) {
        await savePaymentProof(phone, session.order.orderId, "Screenshot sent");
        const adminJid = process.env.ADMIN_JID || phoneToJid("254743810633");
        const user = await getUser(phone);
        await sock.sendMessage(adminJid, { text: `🔔 *New Payment Proof*\n\n👤 ${user?.name || phone}\n🆔 ${user?.customerId}\n📦 ${session.order.itemName}\n💰 KES ${session.order.amount}\n🆔 Order: ${session.order.orderId}\n\nApprove in admin dashboard ✅` });
        sessions[phone] = { state: "idle" };
        await sock.sendMessage(jid, { text: `✅ Payment proof received!\nAdmin will review in 5-10 mins.\nOrder: \`${session.order.orderId}\`\n\nType *menu* to go back.` });
      }
      return;
    }

    let text = "";
    if (type === "conversation") text = msg.message.conversation;
    else if (type === "extendedTextMessage") text = msg.message.extendedTextMessage.text;
    else return;
    if (!text) return;

    const input = text.trim();
    const lower = input.toLowerCase();
    await sock.readMessages([msg.key]);

    const settings = await getSettings();
    let user = await getUser(phone);
    let session = sessions[phone] || { state: "idle" };

    // Registration
    if (!user) {
      if (session.state === "awaiting_name") {
        user = await createUser(phone, input);
        sessions[phone] = { state: "idle" };
        await sock.sendMessage(jid, { text: `✅ Welcome, *${input}*! 🎉\nYour ID: *${user.customerId}*\n\nType *menu* to get started.` });
        return;
      }
      sessions[phone] = { state: "awaiting_name" };
      await sock.sendMessage(jid, { text: `👋 Welcome to *${settings.businessName || "Xavi Tech"}*!\n\nI'm *${settings.botName || "Xavi Assistant"}* 🤖\n\nWhat's your name?` });
      return;
    }

    // Custom keyword replies
    const skipWords = ["menu","hi","hello","start","back","buy","cancel","1","2","3","4","5","6","7","8","9"];
    if (!skipWords.includes(lower) && lower.length > 2) {
      const customReply = await getCustomMenuReply(lower);
      if (customReply) { await sock.sendMessage(jid, { text: `${customReply}\n\nType *menu* to go back.` }); return; }
    }

    if (lower === "cancel") { sessions[phone] = { state: "idle" }; await sock.sendMessage(jid, { text: `❌ Cancelled.\n\nType *menu* to go back.` }); return; }

    // Main menu
    if (["hi","hello","menu","start","back","hey"].includes(lower)) {
      const menus = await getMenus();
      sessions[phone] = { state: "main_menu", menus };
      const greeting = getGreeting();
      let msg2 = `${greeting}\n\nWelcome to *${settings.businessName || "Xavi Tech"}* 🚀\n`;
      if (settings.greeting) msg2 += `${settings.greeting}\n`;
      msg2 += `\nHello *${user.name}*! 👋\n\n━━━━━━━━━━━━━━\n`;
      if (menus.length) menus.forEach((m, i) => { msg2 += `${i + 1}. ${m.name}\n`; });
      else msg2 += `No menus available yet.\n`;
      msg2 += `━━━━━━━━━━━━━━\n\n_Reply with a number_`;
      if (settings.portfolioLink) msg2 += `\n\n🌐 ${settings.portfolioLink}`;
      await sock.sendMessage(jid, { text: msg2 });
      return;
    }

    if (session.state === "awaiting_proof") { await sock.sendMessage(jid, { text: `📸 Please send payment *screenshot* as an image.\n\nOr type *cancel*.` }); return; }

    // Payment mode selection
    if (session.state === "awaiting_payment" && session.selectedItem) {
      const num = parseInt(input);
      const modes = session.paymentModes || [];
      if (!isNaN(num) && modes[num - 1]) {
        const mode = modes[num - 1];
        const order = await createOrder(phone, session.selectedItem, mode.name);
        if (!order) { await sock.sendMessage(jid, { text: `❌ Error creating order. Try again.` }); return; }
        sessions[phone] = { state: "awaiting_proof", order: { ...order, itemName: session.selectedItem.name, amount: session.selectedItem.price } };
        let payMsg = `💳 *Payment Instructions*\n\n📦 *${session.selectedItem.name}*\n💰 *KES ${session.selectedItem.price}*\n🆔 Order: \`${order.orderId}\`\n\n━━━━━━━━━━━━━━\n📲 Pay via *${mode.name}*\n`;
        if (mode.number) payMsg += `Send to: *${mode.number}*\n`;
        if (mode.instructions) payMsg += `\n${mode.instructions}\n`;
        payMsg += `\nSend screenshot after payment ✅\n\nType *cancel* to go back`;
        await sock.sendMessage(jid, { text: payMsg });
        return;
      }
    }

    // Buy
    if (lower === "buy" && session.selectedItem) {
      const modes = await getPaymentModes();
      if (!modes.length) { await sock.sendMessage(jid, { text: `❌ No payment modes configured. Contact admin.` }); return; }
      let msg2 = `💳 *Select Payment Mode*\n\n━━━━━━━━━━━━━━\n`;
      modes.forEach((m, i) => { msg2 += `${i + 1}. ${m.name}\n`; });
      msg2 += `━━━━━━━━━━━━━━\n\nReply with a number`;
      sessions[phone] = { ...session, state: "awaiting_payment", paymentModes: modes };
      await sock.sendMessage(jid, { text: msg2 });
      return;
    }

    // Numeric navigation
    const num = parseInt(input);
    if (!isNaN(num)) {
      if (session.state === "main_menu" && session.menus) {
        const menu = session.menus[num - 1];
        if (menu) {
          const submenus = await getSubmenus(menu.id);
          if (!submenus.length) { await sock.sendMessage(jid, { text: `📌 *${menu.name}*\n\n${menu.description || ""}\n\n🔙 Type *menu* to go back` }); return; }
          sessions[phone] = { state: "submenu", menu, submenus };
          let msg2 = `📌 *${menu.name}*\n\n━━━━━━━━━━━━━━\n`;
          submenus.forEach((s, i) => { msg2 += `${i + 1}. ${s.name}\n`; });
          msg2 += `━━━━━━━━━━━━━━\n\nReply with a number\n\n🔙 Type *menu* to go back`;
          await sock.sendMessage(jid, { text: msg2 });
          return;
        }
      }
      if (session.state === "submenu" && session.submenus) {
        const submenu = session.submenus[num - 1];
        if (submenu) {
          const items = await getSubmenuItems(session.menu.id, submenu.id);
          if (!items.length) { await sock.sendMessage(jid, { text: `📌 *${submenu.name}*\n\n${submenu.description || ""}\n\n🔙 Type *menu* to go back` }); return; }
          sessions[phone] = { ...session, state: "items", submenu, items };
          let msg2 = `📌 *${submenu.name}*\n\n━━━━━━━━━━━━━━\n`;
          items.forEach((item, i) => { msg2 += `${i + 1}. ${item.name}${item.price ? ` — KES ${item.price}` : ""}\n`; });
          msg2 += `━━━━━━━━━━━━━━\n\nReply with a number\n\n🔙 Type *menu* to go back`;
          await sock.sendMessage(jid, { text: msg2 });
          return;
        }
      }
      if (session.state === "items" && session.items) {
        const item = session.items[num - 1];
        if (item) {
          sessions[phone] = { ...session, state: "item_detail", selectedItem: item };
          let detail = `🛍️ *${item.name}*\n\n`;
          if (item.description) detail += `📝 ${item.description}\n\n`;
          if (item.price) detail += `💰 Price: *KES ${item.price}*\n\n`;
          detail += `━━━━━━━━━━━━━━\n`;
          if (item.price) detail += `Type *buy* to purchase\n\n`;
          detail += `🔙 Type *menu* to go back`;
          await sock.sendMessage(jid, { text: detail });
          return;
        }
      }
    }

    await sock.sendMessage(jid, { text: `🤖 I didn't understand that.\n\nType *menu* to see options.` });
  } catch (err) { console.error("handleMessage error:", err); }
}

async function deliverProduct(sock, orderId) {
  try {
    const snap = await db.collection("orders").doc(orderId).get();
    if (!snap.exists) return;
    const order = snap.data();
    const settings = await getSettings();
    await sock.sendMessage(phoneToJid(order.phone), { text: `✅ *Payment Confirmed!*\n\n🧾 Receipt: *${order.receipt}*\n📦 ${order.itemName}\n💰 KES ${order.amount}\n\nThank you! 💙\n\n🌐 ${settings.portfolioLink || ""}` });
    await db.collection("orders").doc(orderId).update({ status: "delivered", deliveredAt: FieldValue.serverTimestamp() });
    await db.collection("users").doc(order.phone).update({ totalOrders: FieldValue.increment(1) });
  } catch (e) { console.error("deliverProduct error:", e.message); }
}

function listenForDeliveries(sock) {
  db.collection("orders").where("status", "==", "approved").onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if ((change.type === "modified" || change.type === "added") && change.doc.data().status === "approved" && !change.doc.data().deliveredAt) {
        await deliverProduct(sock, change.doc.id);
      }
    }
  });
  db.collection("broadcasts").where("status", "==", "pending").onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "added") {
        const b = change.doc.data();
        const users = await db.collection("users").get();
        for (const u of users.docs) {
          try { await sock.sendMessage(phoneToJid(u.data().phone), { text: b.message }); await new Promise(r => setTimeout(r, 1500)); } catch (e) {}
        }
        await db.collection("broadcasts").doc(change.doc.id).update({ status: "sent", sentAt: FieldValue.serverTimestamp() });
      }
    }
  });
  console.log("🎯 Firebase listeners active");
}

// ── Start bot ────────────────────────────────────────────────
async function startBot() {
  console.log("🚀 Starting Xavi Assistant Bot...");

  const authFolder = "auth_info_baileys";
  if (fs.existsSync(authFolder)) { fs.rmSync(authFolder, { recursive: true, force: true }); console.log("🗑️ Cleared old auth"); }
  fs.mkdirSync(authFolder, { recursive: true });

  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 Baileys version: ${version.join(".")}`);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const sock = makeWASocket({ version, logger, printQRInTerminal: false, auth: state, msgRetryCounterCache, generateHighQualityLinkPreview: true, browser: ["Ubuntu", "Chrome", "20.0.04"] });

  const phoneNumber = (process.env.OWNER_NUMBER || "254743810633").replace(/[^0-9]/g, "");
  await new Promise(r => setTimeout(r, 5000));

  try {
    const code = await sock.requestPairingCode(phoneNumber);
    const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
    let count = 0;
    const interval = setInterval(() => {
      count++;
      console.log("\n🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑");
      console.log(`YOUR PAIRING CODE: ${formatted}`);
      console.log(`📞 Number: +${phoneNumber}`);
      console.log("WhatsApp → 3 dots → Linked Devices → Link a Device → Link with phone number");
      console.log("🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑\n");
      if (count >= 12) clearInterval(interval);
    }, 5000);
  } catch (e) { console.error("Pairing code error:", e.message); setTimeout(startBot, 5000); return; }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const should = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      setTimeout(startBot, 3000);
    }
    if (connection === "open") { console.log("✅ Xavi Assistant is ONLINE! 🚀"); listenForDeliveries(sock); }
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) { if (!msg.key.fromMe) await handleMessage(sock, msg); }
  });

  return sock;
}

startBot().catch(err => { console.error("❌ Fatal error:", err); process.exit(1); });
