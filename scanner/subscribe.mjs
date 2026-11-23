// Ajoute l'abonnement Web Push collé dans une issue GitHub (ouverte par le propriétaire du dépôt).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBS_FILE = path.join(ROOT, "data", "subscriptions.json");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

const body = process.env.ISSUE_BODY || "";
const m = body.match(/\{[\s\S]*"endpoint"[\s\S]*\}/);
if (!m) { console.error("Aucun abonnement trouvé dans l'issue."); process.exit(1); }
let sub;
try { sub = JSON.parse(m[0]); } catch { console.error("JSON d'abonnement illisible."); process.exit(1); }
if (!/^https:\/\//.test(sub.endpoint || "") || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
  console.error("Abonnement incomplet."); process.exit(1);
}
let subs = [];
try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")); } catch {}
subs = subs.filter((s) => s.endpoint !== sub.endpoint);
subs.push({ endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2) + "\n");
console.log(`Abonnement enregistré (${subs.length} appareil(s)).`);

const priv = process.env.VAPID_PRIVATE_KEY;
if (priv) {
  webpush.setVapidDetails(CONFIG.vapidSubject, CONFIG.vapidPublicKey, priv);
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title: "Mac Radar est connecté ✅", body: "Tu recevras une notif dès qu'un MacBook Pro rentre dans ton budget.", url: CONFIG.appUrl, tag: "welcome" }), { TTL: 600 });
    console.log("Notification de bienvenue envoyée.");
  } catch (e) { console.log(`Notification de bienvenue échouée : ${e.statusCode || ""} ${e.body || e.message}`); }
}
