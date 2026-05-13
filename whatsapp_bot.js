/**
 * whatsapp_bot.js — Dev Clin WhatsApp Bot
 * Uses Baileys (unofficial WhatsApp Web API)
 * Shares the same SQLite database as the Telegram bot
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const pino = require("pino");

// ── Config ────────────────────────────────────────────────────────────
const DB_PATH     = process.env.DB_PATH || "./devclin.db";
const AUTH_FOLDER = "./wa_auth";
const COMPANY     = "Skyline Technologies";
const BOT_NAME    = "Dev Clin";
const ADMIN_WA    = process.env.ADMIN_WA || "254743810633"; // admin WhatsApp number (no +)
const WHATSAPP    = process.env.WHATSAPP_LINK || "https://wa.me/254743810633";

// ── DB helpers ────────────────────────────────────────────────────────
function getDb() {
    return new Database(DB_PATH);
}

function getSettings() {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM settings").all();
    db.close();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function getProducts(category = null) {
    const db = getDb();
    const rows = category
        ? db.prepare("SELECT * FROM products WHERE active=1 AND category=?").all(category)
        : db.prepare("SELECT * FROM products WHERE active=1").all();
    db.close();
    return rows;
}

function getProduct(id) {
    const db = getDb();
    const row = db.prepare("SELECT * FROM products WHERE id=?").get(id);
    db.close();
    return row;
}

function getCategories() {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM categories WHERE active=1").all();
    db.close();
    return rows;
}

function getOrCreateUser(jid, name) {
    const db = getDb();
    const userId = jid.replace("@s.whatsapp.net", "");
    const existing = db.prepare("SELECT * FROM users WHERE user_id=?").get(userId);
    if (!existing) {
        db.prepare(
            "INSERT OR IGNORE INTO users (user_id, username, full_name, join_date, referral_code, referred_by, points) VALUES (?,?,?,?,?,?,?)"
        ).run(userId, "", name || "WhatsApp User", new Date().toISOString(), `WA${userId.slice(-6)}`, null, 0);
    }
    db.close();
    return userId;
}

function getUserState(userId) {
    const db = getDb();
    const row = db.prepare("SELECT state, extra FROM user_states_db WHERE user_id=?").get(userId);
    db.close();
    return row || { state: 0, extra: null };
}

function setUserState(userId, state, extra = null) {
    const db = getDb();
    db.prepare(
        "INSERT OR REPLACE INTO user_states_db (user_id, state, extra, updated_at) VALUES (?,?,?,?)"
    ).run(userId, state, extra, new Date().toISOString());
    db.close();
}

function clearUserState(userId) {
    setUserState(userId, 0, null);
}

// States
const STATE = {
    IDLE: 0,
    AWAIT_PAYMENT: 5,
    AWAIT_MPESA: 6,
    AWAIT_REVIEW: 30,
    AWAIT_BOT_REVIEW: 31,
};

// ── Message builders ──────────────────────────────────────────────────
function mainMenu() {
    return (
        `🚀 *${BOT_NAME} — ${COMPANY}*\n\n` +
        `Welcome! What would you like to do?\n\n` +
        `1️⃣ 🛍 Shop — Browse products\n` +
        `2️⃣ 📞 Contact — Reach us\n` +
        `3️⃣ ℹ About — About us\n` +
        `4️⃣ ⭐ Rate Us — Leave a review\n\n` +
        `_Reply with a number or keyword_\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `_${BOT_NAME} | ${COMPANY}_`
    );
}

function shopMenu(categories) {
    let text = `🛍 *Shop — ${COMPANY}*\n\nChoose a category:\n\n`;
    categories.forEach((cat, i) => {
        text += `${i + 1}️⃣ ${cat.icon || "📦"} ${cat.name}\n`;
    });
    text += `\n0️⃣ 🏠 Back to Menu\n\n_Reply with a number_`;
    return text;
}

function productListMenu(products, catName) {
    let text = `📦 *${catName}*\n\nAvailable products:\n\n`;
    products.forEach((p, i) => {
        const sale = p.sale_price && p.sale_price < p.price_value;
        const priceStr = sale
            ? `~~KSh ${p.price_value.toLocaleString()}~~ *KSh ${p.sale_price.toLocaleString()}* 🔥`
            : p.price;
        text += `${i + 1}️⃣ ${p.icon || "📦"} *${p.name}* — ${priceStr}\n`;
    });
    text += `\n0️⃣ 🔙 Back to Categories\n\n_Reply with a number_`;
    return text;
}

function productDetail(p) {
    const settings = getSettings();
    const receiverName   = settings.mpesa_name   || "Clinton Oduor";
    const receiverNumber = settings.mpesa_number || "0743810633";
    const sale = p.sale_price && p.sale_price < p.price_value;
    const priceDisplay = sale
        ? `~~KSh ${p.price_value.toLocaleString()}~~ ➡ *KSh ${p.sale_price.toLocaleString()}* 🔥 (${Math.round(((p.price_value - p.sale_price) / p.price_value) * 100)}% OFF)`
        : `*${p.price}*`;
    const mpesaAmount = sale ? `KSh ${p.sale_price.toLocaleString()}` : p.price;

    return (
        `${p.icon || "📦"} *${p.name}*\n\n` +
        `💰 *Price:* ${priceDisplay}\n` +
        `📁 *Type:* ${p.type}\n\n` +
        `${p.desc}\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `*Payment via M-Pesa Send Money:*\n` +
        `📱 Send to: *${receiverNumber}*\n` +
        `👤 Name: *${receiverName}*\n` +
        `💰 Amount: *${mpesaAmount}*\n\n` +
        `After payment, reply *PAID* and paste your M-Pesa confirmation message.\n\n` +
        `0️⃣ 🔙 Back`
    );
}

function contactMenu() {
    const settings = getSettings();
    return (
        `📞 *Contact Us — ${COMPANY}*\n\n` +
        `We're always available to help!\n\n` +
        `💬 WhatsApp: ${WHATSAPP}\n` +
        `📸 Instagram: ${settings.instagram || "@devclin"}\n\n` +
        `_Response time: Usually within minutes_ ⚡\n\n` +
        `0️⃣ 🏠 Back to Menu`
    );
}

function aboutMenu() {
    return (
        `ℹ *About ${BOT_NAME}*\n\n` +
        `${BOT_NAME} is your go-to digital marketplace by *${COMPANY}*.\n\n` +
        `🛍 Digital products & services\n` +
        `⚡ Instant delivery\n` +
        `🔒 Secure M-Pesa payments\n` +
        `📞 24/7 support\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `_${BOT_NAME} | ${COMPANY}_\n\n` +
        `0️⃣ 🏠 Back to Menu`
    );
}

function ratingMenu() {
    return (
        `⭐ *Rate ${BOT_NAME}*\n\n` +
        `How would you rate your experience?\n\n` +
        `Reply with a number:\n` +
        `1️⃣ ⭐ Poor\n` +
        `2️⃣ ⭐⭐ Fair\n` +
        `3️⃣ ⭐⭐⭐ Good\n` +
        `4️⃣ ⭐⭐⭐⭐ Very Good\n` +
        `5️⃣ ⭐⭐⭐⭐⭐ Excellent\n\n` +
        `0️⃣ 🏠 Back to Menu`
    );
}

// ── Session store (in-memory) ─────────────────────────────────────────
const sessions = {}; // userId -> { menu, data }

function getSession(userId) {
    if (!sessions[userId]) sessions[userId] = { menu: "main", data: {} };
    return sessions[userId];
}

// ── Send notification to admin ────────────────────────────────────────
async function notifyAdmin(sock, message) {
    try {
        await sock.sendMessage(`${ADMIN_WA}@s.whatsapp.net`, { text: message });
    } catch (e) {
        console.error("Admin notify failed:", e.message);
    }
}

// ── Save review to DB ─────────────────────────────────────────────────
function saveReview(userId, name, type, productId, productName, rating, review) {
    const db = getDb();
    db.prepare(
        "INSERT INTO reviews (user_id,username,full_name,product_id,product_name,rating,review,type,created_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(userId, "", name, productId || "bot", productName || BOT_NAME, rating, review, type, new Date().toISOString());
    db.close();
}

// ── Main message handler ──────────────────────────────────────────────
async function handleMessage(sock, msg) {
    const jid  = msg.key.remoteJid;
    const from = jid;

    // Ignore group messages and status
    if (jid.endsWith("@g.us") || jid === "status@broadcast") return;

    const body = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ""
    ).trim();

    if (!body) return;

    const userId  = jid.replace("@s.whatsapp.net", "");
    const name    = msg.pushName || "User";
    const session = getSession(userId);
    const dbState = getUserState(userId);
    const text    = body.toLowerCase();

    // Register user
    getOrCreateUser(jid, name);

    // ── Always allow "menu" / "hi" / "hello" / "0" to go home ────────
    if (["0", "menu", "hi", "hello", "start", "home"].includes(text)) {
        session.menu = "main";
        session.data = {};
        clearUserState(userId);
        await sock.sendMessage(from, { text: mainMenu() });
        return;
    }

    // ── Handle PAID state ─────────────────────────────────────────────
    if (dbState.state === STATE.AWAIT_MPESA) {
        const productId = session.data.pendingProductId;
        const prod      = productId ? getProduct(productId) : null;
        const mpesaMsg  = body;

        if (mpesaMsg.toLowerCase().startsWith("paid") || mpesaMsg.length > 20) {
            // Forward to admin
            await notifyAdmin(sock,
                `💰 *New WhatsApp Payment*\n\n` +
                `👤 *${name}* (WA: ${userId})\n` +
                `📦 *${prod ? prod.name : "Unknown"}*\n\n` +
                `📋 M-Pesa message:\n${mpesaMsg}\n\n` +
                `_${COMPANY}_`
            );

            await sock.sendMessage(from, {
                text:
                    `✅ *Payment Received!*\n\n` +
                    `Thank you *${name}*! 🎉\n\n` +
                    `📦 *${prod ? prod.name : "Your product"}*\n\n` +
                    `The admin has been notified and will deliver your item shortly. ⏳\n\n` +
                    `If you don't hear back in 10 minutes, contact us:\n${WHATSAPP}\n\n` +
                    `━━━━━━━━━━━━━━━━\n_${COMPANY}_`
            });

            clearUserState(userId);
            session.menu = "main";

            // Ask for rating
            setTimeout(async () => {
                session.menu    = "rating";
                session.data    = { ratingFor: "product", productId, productName: prod ? prod.name : "product" };
                setUserState(userId, STATE.AWAIT_REVIEW);
                await sock.sendMessage(from, {
                    text: `⭐ *How was ${prod ? prod.name : "your purchase"}?*\n\nReply 1-5 to rate:\n1️⃣ ⭐ 2️⃣ ⭐⭐ 3️⃣ ⭐⭐⭐ 4️⃣ ⭐⭐⭐⭐ 5️⃣ ⭐⭐⭐⭐⭐\n\nOr reply *skip* to skip.`
                });
            }, 3000);
        } else {
            await sock.sendMessage(from, {
                text: `Please paste your full M-Pesa confirmation message, or reply *0* to cancel.`
            });
        }
        return;
    }

    // ── Handle review state ───────────────────────────────────────────
    if (dbState.state === STATE.AWAIT_REVIEW) {
        if (text === "skip") {
            clearUserState(userId);
            session.menu = "main";
            await sock.sendMessage(from, { text: `👍 No problem! Reply *menu* anytime.\n\n_${COMPANY}_` });
            return;
        }
        const rating = parseInt(text);
        if (rating >= 1 && rating <= 5) {
            session.data.rating = rating;
            setUserState(userId, STATE.AWAIT_BOT_REVIEW);
            const stars = "⭐".repeat(rating);
            await sock.sendMessage(from, {
                text: `${stars} Thank you!\n\nWant to leave a short review? Type it below, or reply *skip*.`
            });
        } else {
            await sock.sendMessage(from, { text: `Please reply with a number 1-5, or *skip*.` });
        }
        return;
    }

    if (dbState.state === STATE.AWAIT_BOT_REVIEW) {
        const reviewText = text === "skip" ? "(no review)" : body;
        const rating     = session.data.rating || 0;
        const type       = session.data.ratingFor || "bot";
        const productId  = session.data.productId || "bot";
        const prodName   = session.data.productName || BOT_NAME;

        saveReview(userId, name, type, productId, prodName, rating, reviewText);

        const stars = "⭐".repeat(rating);
        await sock.sendMessage(from, {
            text: `✅ *Review submitted! ${stars}*\n\nThank you for your feedback!\n\n_${COMPANY}_`
        });

        // Notify admin
        await notifyAdmin(sock,
            `🌟 *New WhatsApp Review*\n\n` +
            `👤 *${name}* (${userId})\n` +
            `${stars} ${rating}/5\n\n` +
            `💬 _${reviewText}_\n\n` +
            `_${COMPANY}_`
        );

        clearUserState(userId);
        session.menu = "main";
        return;
    }

    // ── Main menu navigation ──────────────────────────────────────────
    if (session.menu === "main") {
        if (text === "1" || text.includes("shop")) {
            const cats = getCategories();
            session.menu      = "categories";
            session.data.cats = cats;
            await sock.sendMessage(from, { text: shopMenu(cats) });
        } else if (text === "2" || text.includes("contact")) {
            session.menu = "contact";
            await sock.sendMessage(from, { text: contactMenu() });
        } else if (text === "3" || text.includes("about")) {
            session.menu = "about";
            await sock.sendMessage(from, { text: aboutMenu() });
        } else if (text === "4" || text.includes("rate")) {
            session.menu = "rating";
            session.data = { ratingFor: "bot" };
            await sock.sendMessage(from, { text: ratingMenu() });
        } else {
            await sock.sendMessage(from, { text: mainMenu() });
        }
        return;
    }

    // ── Categories menu ───────────────────────────────────────────────
    if (session.menu === "categories") {
        const cats = session.data.cats || getCategories();
        const idx  = parseInt(text) - 1;
        if (idx >= 0 && idx < cats.length) {
            const cat      = cats[idx];
            const products = getProducts(cat.id);
            if (products.length === 0) {
                await sock.sendMessage(from, { text: `📭 No products in *${cat.name}* yet.\n\nReply *0* to go back.` });
                return;
            }
            session.menu          = "products";
            session.data.products = products;
            session.data.catName  = cat.name;
            await sock.sendMessage(from, { text: productListMenu(products, cat.name) });
        } else {
            await sock.sendMessage(from, { text: shopMenu(cats) });
        }
        return;
    }

    // ── Products list ─────────────────────────────────────────────────
    if (session.menu === "products") {
        const products = session.data.products || [];
        const idx      = parseInt(text) - 1;
        if (idx >= 0 && idx < products.length) {
            const prod = products[idx];
            session.menu                = "product_detail";
            session.data.currentProduct = prod;
            await sock.sendMessage(from, { text: productDetail(prod) });
            if (prod.image_url) {
                try {
                    await sock.sendMessage(from, { image: { url: prod.image_url }, caption: prod.name });
                } catch (e) { /* ignore image errors */ }
            }
        } else {
            const cats = getCategories();
            session.menu      = "categories";
            session.data.cats = cats;
            await sock.sendMessage(from, { text: shopMenu(cats) });
        }
        return;
    }

    // ── Product detail — waiting for PAID ─────────────────────────────
    if (session.menu === "product_detail") {
        const prod = session.data.currentProduct;
        if (text === "paid" || text.startsWith("paid")) {
            session.data.pendingProductId = prod.id;
            setUserState(userId, STATE.AWAIT_MPESA);
            await sock.sendMessage(from, {
                text:
                    `✅ Great! Please paste your *M-Pesa confirmation message* below.\n\n` +
                    `Example:\n_BH12345XYZ confirmed. KSh 500 sent to Clinton Oduor..._\n\n` +
                    `Or reply *0* to cancel.`
            });
        } else {
            await sock.sendMessage(from, { text: productDetail(prod) });
        }
        return;
    }

    // ── Rating menu ───────────────────────────────────────────────────
    if (session.menu === "rating") {
        const rating = parseInt(text);
        if (rating >= 1 && rating <= 5) {
            session.data.rating = rating;
            setUserState(userId, STATE.AWAIT_BOT_REVIEW);
            const stars = "⭐".repeat(rating);
            await sock.sendMessage(from, {
                text: `${stars} Thank you for rating us ${rating}/5!\n\nLeave a short review below, or reply *skip*.`
            });
        } else {
            await sock.sendMessage(from, { text: ratingMenu() });
        }
        return;
    }

    // ── Default ───────────────────────────────────────────────────────
    session.menu = "main";
    await sock.sendMessage(from, { text: mainMenu() });
}

// ── Bot startup ───────────────────────────────────────────────────────
async function startBot() {
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const PHONE_NUMBER = process.env.WA_PHONE_NUMBER || ""; // e.g. 254712345678

    const sock = makeWASocket({
        auth:   state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["Dev Clin Bot", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    // Request pair code if not registered yet
    if (!sock.authState.creds.registered && PHONE_NUMBER) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log("\n" + "=".repeat(40));
                console.log("📱 YOUR WHATSAPP PAIRING CODE:");
                console.log("   👉  " + code);
                console.log("=".repeat(40));
                console.log("Steps:");
                console.log("1. Open WhatsApp on your phone");
                console.log("2. Tap Menu (⋮) → Linked Devices");
                console.log("3. Tap Link a Device");
                console.log("4. Tap 'Link with phone number instead'");
                console.log("5. Enter code: " + code);
                console.log("=".repeat(40) + "\n");
            } catch (e) {
                console.error("❌ Failed to get pairing code:", e.message);
                console.log("Make sure WA_PHONE_NUMBER is set in Railway Variables (e.g. 254712345678)");
            }
        }, 3000);
    }

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "close") {
            const shouldReconnect =
                new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("⚠️ Connection closed. Reconnecting:", shouldReconnect);
            if (shouldReconnect) setTimeout(startBot, 5000);
            else console.log("❌ Logged out. Delete wa_auth folder and restart.");
        } else if (connection === "open") {
            console.log(`\n✅ WhatsApp bot connected! — ${BOT_NAME} | ${COMPANY}`);
            // Notify admin
            try {
                await sock.sendMessage(`${ADMIN_WA}@s.whatsapp.net`, {
                    text: `✅ *${BOT_NAME} WhatsApp Bot Started!*\n\n_${COMPANY}_`
                });
            } catch (e) { /* ignore */ }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            try {
                await handleMessage(sock, msg);
            } catch (e) {
                console.error("Message handler error:", e.message);
            }
        }
    });
}

startBot().catch(console.error);
