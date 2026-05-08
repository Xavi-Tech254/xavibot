require("./keep-alive");

// ============================================================
// bot.js — Xavi Assistant WhatsApp Bot
// Built with Baileys + Firebase | Xavi Tech
// ============================================================

require("dotenv").config();
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,



  getContentType,
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const pino = require("pino");
const NodeCache = require("node-cache");
const { db } = require("./firebase");
const { FieldValue } = require("firebase-admin/firestore");



// ── In-memory session store ──────────────────────────────────
// Tracks conversation state per user (e.g., awaiting username, email)
const sessions = {};

// ── Message retry cache ──────────────────────────────────────
const msgRetryCounterCache = new NodeCache();

// ── In-memory store for message history ─────────────────────

// ── Logger (silent for clean output) ────────────────────────
const logger = pino({ level: "silent" });

// ============================================================
// UTILITY: Get time-based greeting
// ============================================================
function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return { emoji: "🌅", text: "Good Morning" };
  if (hour >= 12 && hour < 17) return { emoji: "☀️", text: "Good Afternoon" };
  return { emoji: "🌙", text: "Good Evening" };
}

// ============================================================
// UTILITY: Format phone number to JID
// ============================================================
function phoneToJid(phone) {
  const clean = phone.replace(/\D/g, "");
  return `${clean}@s.whatsapp.net`;
}

// ============================================================
// UTILITY: Get sender's phone number from JID
// ============================================================
function getPhone(jid) {
  return jid.replace("@s.whatsapp.net", "");
}

// ============================================================
// FIREBASE: Get or initialize user session
// ============================================================
async function getUser(phone) {
  try {
    const snap = await db.collection("users").doc(phone).get();
    return snap.exists ? snap.data() : null;
  } catch (e) {
    console.error("getUser error:", e.message);
    return null;
  }
}

// ============================================================
// FIREBASE: Create new user with auto-incremented customer ID
// ============================================================
async function createUser(phone, username, email) {
  try {
    // Count existing users to generate Customer ID
    const snap = await db.collection("users").get();
    const count = snap.size + 1;
    const customerId = `Client ${String(count).padStart(3, "0")}`;

    const userData = {
      phone,
      username,
      email,
      customerId,
      registeredAt: FieldValue.serverTimestamp(),
      totalOrders: 0,
      status: "active",
    };

    await db.collection("users").doc(phone).set(userData);
    return userData;
  } catch (e) {
    console.error("createUser error:", e.message);
    return null;
  }
}

// ============================================================
// FIREBASE: Load global settings
// ============================================================
async function getSettings() {
  try {
    const snap = await db.collection("settings").doc("global").get();
    if (snap.exists) return snap.data();
    // Return defaults if no settings exist yet
    return {
      portfolioLink: "https://xavitech.com",
      whatsappLink: "https://wa.me/254743810633",
      telegramLink: "https://t.me/xavitech",
      emailAddress: "xavitech8@gmail.com",
      smsNumber: "+254743810633",
      callNumber: "+254743810633",
      paymentNumber: "0743 810 633",
      botName: "Xavi Assistant",
      businessName: "Xavi Tech",
    };
  } catch (e) {
    console.error("getSettings error:", e.message);
    return {};
  }
}

// ============================================================
// FIREBASE: Load products list
// ============================================================
async function getProducts(category = null) {
  try {
    let query = db.collection("products").where("active", "==", true);
    if (category) query = query.where("category", "==", category);
    const snap = await query.orderBy("name").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("getProducts error:", e.message);
    return [];
  }
}

// ============================================================
// FIREBASE: Load services list
// ============================================================
async function getServices() {
  try {
    const snap = await db
      .collection("services")
      .where("active", "==", true)
      .orderBy("order")
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // fallback without orderBy if no index
    try {
      const snap2 = await db
        .collection("services")
        .where("active", "==", true)
        .get();
      return snap2.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e2) {
      return [];
    }
  }
}

// ============================================================
// FIREBASE: Load product categories
// ============================================================
async function getProductCategories() {
  try {
    const snap = await db.collection("productCategories").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    return [];
  }
}

// ============================================================
// FIREBASE: Save order to Firestore
// ============================================================
async function createOrder(phone, productId, productName, amount) {
  try {
    const user = await getUser(phone);
    const orderRef = db.collection("orders").doc();
    const receiptNumber = `XAV-${Date.now().toString().slice(-8)}`;

    await orderRef.set({
      orderId: orderRef.id,
      phone,
      customerId: user?.customerId || "Unknown",
      username: user?.username || "Unknown",
      productId,
      productName,
      amount,
      receiptNumber,
      status: "pending_payment",
      createdAt: FieldValue.serverTimestamp(),
    });

    return { orderId: orderRef.id, receiptNumber };
  } catch (e) {
    console.error("createOrder error:", e.message);
    return null;
  }
}

// ============================================================
// FIREBASE: Save payment proof reference
// ============================================================
async function savePaymentProof(phone, orderId, note) {
  try {
    await db.collection("paymentProofs").add({
      phone,
      orderId,
      note: note || "",
      status: "pending",
      submittedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("savePaymentProof error:", e.message);
  }
}

// ============================================================
// FIREBASE: Search products and services
// ============================================================
async function searchItems(query) {
  try {
    const q = query.toLowerCase();
    const results = [];

    // Search products
    const prodSnap = await db
      .collection("products")
      .where("active", "==", true)
      .get();
    prodSnap.docs.forEach((d) => {
      const data = d.data();
      if (
        data.name?.toLowerCase().includes(q) ||
        data.description?.toLowerCase().includes(q) ||
        data.category?.toLowerCase().includes(q)
      ) {
        results.push({ type: "product", id: d.id, ...data });
      }
    });

    // Search services
    const svcSnap = await db
      .collection("services")
      .where("active", "==", true)
      .get();
    svcSnap.docs.forEach((d) => {
      const data = d.data();
      if (
        data.name?.toLowerCase().includes(q) ||
        data.description?.toLowerCase().includes(q)
      ) {
        results.push({ type: "service", id: d.id, ...data });
      }
    });

    return results.slice(0, 10); // max 10 results
  } catch (e) {
    console.error("searchItems error:", e.message);
    return [];
  }
}

// ============================================================
// FIREBASE: Get FAQ answer for a question
// ============================================================
async function getFaqAnswer(message) {
  try {
    const snap = await db.collection("faqs").get();
    const msg = message.toLowerCase();
    for (const doc of snap.docs) {
      const data = doc.data();
      const keywords = (data.keywords || []).map((k) => k.toLowerCase());
      if (
        keywords.some((k) => msg.includes(k)) ||
        msg.includes(data.question?.toLowerCase())
      ) {
        return data.answer;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// MESSAGE BUILDERS
// ============================================================

function buildMainMenu(settings, greeting, customerId) {
  return (
    `${greeting.emoji} ${greeting.text} *${customerId}*\n\n` +
    `Welcome to *${settings.businessName || "Xavi Tech"}* 🚀\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `① Talk to Xavi\n` +
    `② Services\n` +
    `③ Products\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `_Reply with a number to continue_\n\n` +
    `🌐 Portfolio: ${settings.portfolioLink || "https://xavitech.com"}`
  );
}

function buildContactMenu(settings) {
  return (
    `📞 *Contact Xavi*\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `① SMS\n` +
    `② Call\n` +
    `③ WhatsApp Chat\n` +
    `④ Telegram\n` +
    `⑤ Email\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `_Reply with a number_\n\n` +
    `🔙 Type *menu* to go back`
  );
}

function buildServicesMenu(services, settings) {
  if (!services.length) {
    return (
      `🛠️ *Our Services*\n\n` +
      `No services available yet.\nContact us for custom solutions!\n\n` +
      `🔙 Type *menu* to go back\n\n` +
      `🌐 Portfolio: ${settings.portfolioLink || ""}`
    );
  }

  let msg = `🛠️ *Our Services*\n\n━━━━━━━━━━━━━━\n`;
  services.forEach((s, i) => {
    msg += `${i + 1}. ${s.name}\n`;
  });
  msg +=
    `━━━━━━━━━━━━━━\n\n` +
    `_Reply with a number to learn more_\n\n` +
    `🔙 Type *menu* to go back\n\n` +
    `🌐 Portfolio: ${settings.portfolioLink || ""}`;
  return msg;
}

function buildServiceDetail(service, settings) {
  return (
    `🔷 *${service.name}*\n\n` +
    `📝 ${service.description || "Professional service tailored for your needs."}\n\n` +
    `💰 *Price:* ${service.price ? `KES ${service.price}` : "Contact for pricing"}\n\n` +
    (service.portfolioLink
      ? `🎨 *Demo/Portfolio:* ${service.portfolioLink}\n\n`
      : "") +
    `📩 Interested? Type *contact* to reach Xavi\n\n` +
    `🔙 Type *services* to go back\n\n` +
    `🌐 Portfolio: ${settings.portfolioLink || ""}`
  );
}

function buildProductCategoriesMenu(categories, settings) {
  if (!categories.length) {
    return (
      `📦 *Products*\n\nNo products yet.\n\n` +
      `🔙 Type *menu* to go back\n\n` +
      `🌐 Portfolio: ${settings.portfolioLink || ""}`
    );
  }
  let msg = `📦 *Products*\n\n━━━━━━━━━━━━━━\n`;
  categories.forEach((c, i) => {
    msg += `${i + 1}. ${c.name}\n`;
  });
  msg +=
    `━━━━━━━━━━━━━━\n\n` +
    `_Reply with a number_\n\n` +
    `🔙 Type *menu* to go back\n\n` +
    `🌐 Portfolio: ${settings.portfolioLink || ""}`;
  return msg;
}

function buildProductsList(products, categoryName, settings) {
  if (!products.length) {
    return (
      `📦 *${categoryName}*\n\nNo products in this category yet.\n\n` +
      `🔙 Type *products* to go back\n\n` +
      `🌐 Portfolio: ${settings.portfolioLink || ""}`
    );
  }
  let msg = `📦 *${categoryName}*\n\n━━━━━━━━━━━━━━\n`;
  products.forEach((p, i) => {
    msg += `${i + 1}. ${p.name} — *KES ${p.price || "?"}*\n`;
  });
  msg +=
    `━━━━━━━━━━━━━━\n\n` +
    `_Reply with a number to purchase_\n\n` +
    `🔙 Type *products* to go back\n\n` +
    `🌐 Portfolio: ${settings.portfolioLink || ""}`;
  return msg;
}

function buildProductDetail(product, settings) {
  return (
    `🛍️ *${product.name}*\n\n` +
    `📝 ${product.description || "Quality digital product."}\n\n` +
    `💰 *Price:* KES ${product.price || "N/A"}\n` +
    `📂 *Category:* ${product.category || "General"}\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `To purchase, reply *buy*\n\n` +
    `🔙 Type *products* to go back\n\n` +
    `🌐 Portfolio: ${settings.portfolioLink || ""}`
  );
}

function buildPaymentInstructions(product, orderId, settings) {
  return (
    `💳 *Payment Instructions*\n\n` +
    `🛍️ Product: *${product.name}*\n` +
    `💰 Amount: *KES ${product.price}*\n` +
    `🆔 Order ID: \`${orderId}\`\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `📲 *Pay via M-Pesa:*\n` +
    `Send KES *${product.price}* to:\n` +
    `📞 *${settings.paymentNumber || "0743 810 633"}*\n\n` +
    `After payment:\n` +
    `1️⃣ Take a screenshot of M-Pesa confirmation\n` +
    `2️⃣ Send the screenshot here\n` +
    `3️⃣ Wait for admin approval (~5 mins)\n` +
    `4️⃣ Receive your product automatically ✅\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `🔙 Type *menu* to cancel`
  );
}

function buildReceipt(user, product, order) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-KE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-KE");

  return (
    `╔══════════════════════╗\n` +
    `║   🏢 XAVI TECH        ║\n` +
    `║  OFFICIAL RECEIPT     ║\n` +
    `╚══════════════════════╝\n\n` +
    `🧾 Receipt No: *${order.receiptNumber}*\n` +
    `📅 Date: ${dateStr}\n` +
    `⏰ Time: ${timeStr}\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `👤 *Customer Details*\n` +
    `Name: ${user.username}\n` +
    `ID: ${user.customerId}\n` +
    `Phone: ${user.phone}\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `🛍️ *Product Details*\n` +
    `Product: ${product.name}\n` +
    `Amount: KES ${product.price}\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `✅ *PAYMENT CONFIRMED*\n\n` +
    `Thank you for purchasing\n` +
    `from *Xavi Tech* 💙\n\n` +
    `🌐 xavitech.com`
  );
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================
async function handleMessage(sock, msg) {
  try {
    // Ignore broadcast/status messages
    if (msg.key.remoteJid === "status@broadcast") return;
    if (!msg.message) return;

    const jid = msg.key.remoteJid;
    const phone = getPhone(jid);
    const isGroup = jid.endsWith("@g.us");

    // Skip group messages (bot is for private chats only)
    if (isGroup) return;

    // Extract message content
    const type = getContentType(msg.message);
    let text = "";

    if (type === "conversation") {
      text = msg.message.conversation;
    } else if (type === "extendedTextMessage") {
      text = msg.message.extendedTextMessage.text;
    } else if (type === "imageMessage") {
      // User sent an image — check if we're awaiting payment proof
      const session = sessions[phone] || {};
      if (session.state === "awaiting_payment_proof" && session.pendingOrder) {
        await savePaymentProof(
          phone,
          session.pendingOrder.orderId,
          "Screenshot sent"
        );
        // Notify admin
        const adminJid = process.env.ADMIN_JID || "254743810633@s.whatsapp.net";
        const user = await getUser(phone);
        await sock.sendMessage(adminJid, {
          text:
            `🔔 *New Payment Proof*\n\n` +
            `👤 Customer: ${user?.username || phone}\n` +
            `🆔 Customer ID: ${user?.customerId || "N/A"}\n` +
            `📦 Product: ${session.pendingOrder.productName}\n` +
            `💰 Amount: KES ${session.pendingOrder.amount}\n` +
            `🆔 Order ID: ${session.pendingOrder.orderId}\n\n` +
            `Go to admin dashboard to approve ✅`,
        });

        sessions[phone] = { state: "idle" };
        await sock.sendMessage(jid, {
          text:
            `✅ *Payment proof received!*\n\n` +
            `Your screenshot has been sent to our admin for review.\n` +
            `You will receive your product within *5-10 minutes* after approval.\n\n` +
            `📋 Order ID: \`${session.pendingOrder.orderId}\`\n\n` +
            `Type *menu* to return to main menu.`,
        });
      }
      return;
    } else {
      return; // ignore other message types
    }

    if (!text) return;
    const input = text.trim();
    const lower = input.toLowerCase();

    // Load settings & user
    const settings = await getSettings();
    let user = await getUser(phone);
    let session = sessions[phone] || { state: "idle" };

    // ── Mark as read ──────────────────────────────────────────
    await sock.readMessages([msg.key]);

    // ── SEARCH command ────────────────────────────────────────
    if (lower.startsWith("search ")) {
      const query = input.slice(7).trim();
      const results = await searchItems(query);

      if (!results.length) {
        await sock.sendMessage(jid, {
          text: `🔍 No results found for "*${query}*"\n\nTry different keywords.\n\nType *menu* to go back.`,
        });
        return;
      }

      let msg2 = `🔍 *Search Results for "${query}"*\n\n━━━━━━━━━━━━━━\n`;
      results.forEach((r, i) => {
        const tag = r.type === "product" ? "📦" : "🛠️";
        msg2 += `${i + 1}. ${tag} ${r.name}${r.price ? ` — KES ${r.price}` : ""}\n`;
      });
      msg2 += `━━━━━━━━━━━━━━\n\nType *menu* to go back.`;
      await sock.sendMessage(jid, { text: msg2 });
      return;
    }

    // ── FAQ check ─────────────────────────────────────────────
    if (lower.length > 5 && !["menu", "hi", "hello", "start", "1", "2", "3", "4", "5"].includes(lower)) {
      const faqAnswer = await getFaqAnswer(lower);
      if (faqAnswer) {
        await sock.sendMessage(jid, {
          text: `💡 *Xavi Assistant says:*\n\n${faqAnswer}\n\nType *menu* for main menu.`,
        });
        return;
      }
    }

    // ── NEW USER: Registration flow ───────────────────────────
    if (!user) {
      // Check if user just started
      if (
        ["hi", "hello", "menu", "start", "hey"].includes(lower) &&
        !session.state
      ) {
        sessions[phone] = { state: "awaiting_username" };
        await sock.sendMessage(jid, {
          text:
            `👋 Welcome to *${settings.businessName || "Xavi Tech"}*!\n\n` +
            `I'm *${settings.botName || "Xavi Assistant"}* 🤖\n\n` +
            `To get started, I need a few details.\n\n` +
            `📝 *What's your name?*`,
        });
        return;
      }

      // Awaiting username
      if (session.state === "awaiting_username") {
        sessions[phone] = { state: "awaiting_email", username: input };
        await sock.sendMessage(jid, {
          text: `Nice to meet you, *${input}*! 😊\n\n📧 *What's your email address?*`,
        });
        return;
      }

      // Awaiting email
      if (session.state === "awaiting_email") {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(input)) {
          await sock.sendMessage(jid, {
            text: `⚠️ That doesn't look like a valid email. Please try again.\n\n📧 *Enter your email address:*`,
          });
          return;
        }

        user = await createUser(phone, session.username, input);
        sessions[phone] = { state: "idle" };

        const greeting = getGreeting();
        await sock.sendMessage(jid, {
          text:
            `✅ *Registration successful!*\n\n` +
            `${greeting.emoji} ${greeting.text}, *${user.customerId}*!\n\n` +
            `🆔 Your Customer ID: *${user.customerId}*\n` +
            `👤 Name: ${user.username}\n` +
            `📧 Email: ${user.email}\n\n` +
            `Welcome to the Xavi Tech family! 💙`,
        });

        // Show main menu after registration
        await new Promise((r) => setTimeout(r, 1000));
        await sock.sendMessage(jid, {
          text: buildMainMenu(settings, greeting, user.customerId),
        });
        return;
      }

      // First time message without standard greeting
      sessions[phone] = { state: "awaiting_username" };
      await sock.sendMessage(jid, {
        text:
          `👋 Welcome to *${settings.businessName || "Xavi Tech"}*!\n\n` +
          `I'm *Xavi Assistant* 🤖\n\n` +
          `📝 *What's your name?*`,
      });
      return;
    }

    // ── REGISTERED USER: Main flow ────────────────────────────
    const greeting = getGreeting();

    // ── Handle active sessions ────────────────────────────────
    if (session.state === "awaiting_payment_proof") {
      await sock.sendMessage(jid, {
        text: `📸 Please *send the M-Pesa screenshot* as an image.\n\nOr type *cancel* to go back.`,
      });
      return;
    }

    if (session.state === "awaiting_buy_confirmation" && session.selectedProduct) {
      if (lower === "buy") {
        const product = session.selectedProduct;
        const orderData = await createOrder(phone, product.id, product.name, product.price);
        if (!orderData) {
          await sock.sendMessage(jid, { text: `❌ Error creating order. Please try again.` });
          return;
        }
        sessions[phone] = {
          state: "awaiting_payment_proof",
          pendingOrder: {
            orderId: orderData.orderId,
            productId: product.id,
            productName: product.name,
            amount: product.price,
          },
        };
        await sock.sendMessage(jid, {
          text: buildPaymentInstructions(product, orderData.orderId, settings),
        });
        return;
      }
    }

    // ── CANCEL ────────────────────────────────────────────────
    if (lower === "cancel") {
      sessions[phone] = { state: "idle" };
      await sock.sendMessage(jid, { text: `❌ Cancelled.\n\nType *menu* to go back.` });
      return;
    }

    // ── MAIN MENU trigger ─────────────────────────────────────
    if (["hi", "hello", "menu", "start", "back", "🔙"].includes(lower)) {
      sessions[phone] = { state: "main_menu" };
      await sock.sendMessage(jid, {
        text: buildMainMenu(settings, greeting, user.customerId),
      });
      return;
    }

    // ── CONTACT shortcut ──────────────────────────────────────
    if (lower === "contact") {
      sessions[phone] = { state: "contact_menu" };
      await sock.sendMessage(jid, { text: buildContactMenu(settings) });
      return;
    }

    // ── SERVICES shortcut ─────────────────────────────────────
    if (lower === "services") {
      const services = await getServices();
      sessions[phone] = { state: "services_menu", services };
      await sock.sendMessage(jid, { text: buildServicesMenu(services, settings) });
      return;
    }

    // ── PRODUCTS shortcut ─────────────────────────────────────
    if (lower === "products") {
      const categories = await getProductCategories();
      sessions[phone] = { state: "products_categories", categories };
      await sock.sendMessage(jid, { text: buildProductCategoriesMenu(categories, settings) });
      return;
    }

    // ── NUMERIC INPUT: Context-sensitive ─────────────────────
    const num = parseInt(input);

    if (!isNaN(num)) {
      // Main menu
      if (session.state === "main_menu" || lower === "1" || lower === "2" || lower === "3") {
        if (num === 1 || (session.state !== "contact_menu" && session.state !== "services_menu" && lower === "1")) {
          sessions[phone] = { state: "contact_menu" };
          await sock.sendMessage(jid, { text: buildContactMenu(settings) });
          return;
        }
        if (num === 2) {
          const services = await getServices();
          sessions[phone] = { state: "services_menu", services };
          await sock.sendMessage(jid, { text: buildServicesMenu(services, settings) });
          return;
        }
        if (num === 3) {
          const categories = await getProductCategories();
          sessions[phone] = { state: "products_categories", categories };
          await sock.sendMessage(jid, { text: buildProductCategoriesMenu(categories, settings) });
          return;
        }
      }

      // Contact menu
      if (session.state === "contact_menu") {
        const contactMessages = {
          1: `📱 *SMS Xavi*\n\nsms:${settings.smsNumber || "+254743810633"}\n\nTap the number to send an SMS.`,
          2: `📞 *Call Xavi*\n\ntel:${settings.callNumber || "+254743810633"}\n\nTap the number to call.`,
          3: `💬 *WhatsApp Chat*\n\n${settings.whatsappLink || "https://wa.me/254743810633"}\n\nTap the link to open WhatsApp chat.`,
          4: `✈️ *Telegram*\n\n${settings.telegramLink || "https://t.me/xavitech"}\n\nTap the link to open Telegram.`,
          5: `📧 *Email Xavi*\n\nmailto:${settings.emailAddress || "xavitech8@gmail.com"}\n\nOr email: ${settings.emailAddress || "xavitech8@gmail.com"}`,
        };
        if (contactMessages[num]) {
          await sock.sendMessage(jid, {
            text: contactMessages[num] + `\n\n🔙 Type *menu* to go back`,
          });
          return;
        }
      }

      // Services menu
      if (session.state === "services_menu" && session.services) {
        const service = session.services[num - 1];
        if (service) {
          sessions[phone] = { ...session, state: "service_detail", selectedService: service };
          await sock.sendMessage(jid, { text: buildServiceDetail(service, settings) });
          return;
        }
      }

      // Product categories menu
      if (session.state === "products_categories" && session.categories) {
        const category = session.categories[num - 1];
        if (category) {
          const products = await getProducts(category.name);
          sessions[phone] = { state: "products_list", category, products };
          await sock.sendMessage(jid, {
            text: buildProductsList(products, category.name, settings),
          });
          return;
        }
      }

      // Products list
      if (session.state === "products_list" && session.products) {
        const product = session.products[num - 1];
        if (product) {
          sessions[phone] = { ...session, state: "product_detail", selectedProduct: product };
          await sock.sendMessage(jid, { text: buildProductDetail(product, settings) });
          return;
        }
      }
    }

    // ── BUY command ───────────────────────────────────────────
    if (lower === "buy" && session.selectedProduct) {
      const product = session.selectedProduct;
      const orderData = await createOrder(phone, product.id, product.name, product.price);
      if (!orderData) {
        await sock.sendMessage(jid, { text: `❌ Error creating order. Please try again.` });
        return;
      }
      sessions[phone] = {
        state: "awaiting_payment_proof",
        selectedProduct: product,
        pendingOrder: {
          orderId: orderData.orderId,
          productId: product.id,
          productName: product.name,
          amount: product.price,
        },
      };
      await sock.sendMessage(jid, {
        text: buildPaymentInstructions(product, orderData.orderId, settings),
      });
      return;
    }

    // ── ADMIN: Deliver product command ────────────────────────
    // Format: DELIVER orderId
    if (lower.startsWith("deliver ") && msg.key.fromMe) {
      const orderId = input.slice(8).trim();
      await deliverProduct(sock, orderId, settings);
      return;
    }

    // ── Default fallback ──────────────────────────────────────
    await sock.sendMessage(jid, {
      text:
        `🤖 I didn't quite get that.\n\n` +
        `Type *menu* to see the main menu.\n` +
        `Type *search [keyword]* to search products/services.\n\n` +
        `💬 Need help? Type *contact* to reach us.`,
    });
  } catch (err) {
    console.error("handleMessage error:", err);
  }
}

// ============================================================
// DELIVER PRODUCT: Called when admin approves payment
// ============================================================
async function deliverProduct(sock, orderId, settings) {
  try {
    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) {
      console.log("Order not found:", orderId);
      return;
    }

    const order = orderSnap.data();
    const user = await getUser(order.phone);
    const productSnap = await db.collection("products").doc(order.productId).get();

    if (!productSnap.exists) {
      console.log("Product not found:", order.productId);
      return;
    }

    const product = productSnap.data();
    const jid = phoneToJid(order.phone);

    // Send receipt
    const receipt = buildReceipt(user, product, order);
    await sock.sendMessage(jid, { text: receipt });

    await new Promise((r) => setTimeout(r, 1500));

    // Send product link(s)
    let deliveryMsg = `🎉 *Your product is ready!*\n\n📦 *${product.name}*\n\n`;

    if (product.googleDriveLink) {
      deliveryMsg += `📥 *Google Drive Download:*\n${product.googleDriveLink}\n\n`;
    }
    if (product.megaLink) {
      deliveryMsg += `📥 *MEGA Download:*\n${product.megaLink}\n\n`;
    }
    if (product.directLink) {
      deliveryMsg += `📥 *Direct Download:*\n${product.directLink}\n\n`;
    }

    deliveryMsg +=
      `━━━━━━━━━━━━━━\n` +
      `✅ Thank you for your purchase!\n` +
      `💙 *Xavi Tech* — Always here to help\n\n` +
      `🌐 ${settings.portfolioLink || "https://xavitech.com"}`;

    await sock.sendMessage(jid, { text: deliveryMsg });

    // Update order status
    await db.collection("orders").doc(orderId).update({
      status: "delivered",
      deliveredAt: FieldValue.serverTimestamp(),
    });

    // Update user order count
    await db.collection("users").doc(order.phone).update({
      totalOrders: FieldValue.increment(1),
    });

    console.log(`✅ Product delivered for order ${orderId}`);
  } catch (e) {
    console.error("deliverProduct error:", e.message);
  }
}

// ============================================================
// BROADCAST: Send message to all users
// ============================================================
async function broadcastMessage(sock, message) {
  try {
    const snap = await db.collection("users").where("status", "==", "active").get();
    let sent = 0;

    for (const doc of snap.docs) {
      const user = doc.data();
      try {
        await sock.sendMessage(phoneToJid(user.phone), { text: message });
        sent++;
        // Delay between messages to avoid spam detection
        await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        console.error(`Failed to broadcast to ${user.phone}:`, e.message);
      }
    }

    console.log(`📢 Broadcast sent to ${sent} users`);
    return sent;
  } catch (e) {
    console.error("broadcastMessage error:", e.message);
    return 0;
  }
}

// ============================================================
// FIREBASE: Listen for delivery triggers from admin dashboard
// ============================================================
function listenForDeliveries(sock) {
  // Listen for orders marked as "approved" by admin
  db.collection("orders")
    .where("status", "==", "approved")
    .onSnapshot(async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === "modified" || change.type === "added") {
          const order = change.doc.data();
          if (order.status === "approved" && !order.deliveredAt) {
            const settings = await getSettings();
            await deliverProduct(sock, change.doc.id, settings);
          }
        }
      }
    });

  // Listen for broadcasts
  db.collection("broadcasts")
    .where("status", "==", "pending")
    .onSnapshot(async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === "added") {
          const broadcast = change.doc.data();
          await broadcastMessage(sock, broadcast.message);
          await db.collection("broadcasts").doc(change.doc.id).update({
            status: "sent",
            sentAt: FieldValue.serverTimestamp(),
          });
        }
      }
    });

  console.log("🎯 Firebase listeners active");
}

// ============================================================
// BOT INITIALIZATION
// ============================================================
async function startBot() {
  console.log("🚀 Starting Xavi Assistant Bot...");

  // Load latest Baileys version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📱 Baileys version: ${version.join(".")}${isLatest ? " (latest)" : ""}`);

  // Load auth state from local files
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  // Create WhatsApp socket
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // We handle QR ourselves
    auth: state,
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    browser: ["Xavi Assistant", "Chrome", "1.0.0"],
  });

  // Bind store

  // ── QR Code ─────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("📱 SCAN THIS QR CODE WITH WHATSAPP:");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      qrcode.generate(qr, { small: true });
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("Steps: WhatsApp → Linked Devices → Link a Device");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log(
        "⚠️  Connection closed:",
        lastDisconnect?.error?.message,
        "| Reconnecting:",
        shouldReconnect
      );

      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log("❌ Logged out. Delete auth_info_baileys folder and restart.");
      }
    }

    if (connection === "open") {
      console.log("✅ Xavi Assistant is ONLINE! 🚀");
      listenForDeliveries(sock);
    }
  });

  // ── Save credentials ────────────────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ── Message handler ─────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        await handleMessage(sock, msg);
      }
    }
  });

  return sock;
}

// ── Start the bot ─────────────────────────────────────────────
startBot().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
