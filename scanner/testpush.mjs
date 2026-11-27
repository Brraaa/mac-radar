// Envoie une notification de test à chaque appareil abonné et affiche la réponse exacte du serveur push.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const subs = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "subscriptions.json"), "utf8"));
const priv = (process.env.VAPID_PRIVATE_KEY || "").trim();
console.log(`Appareils abonnés : ${subs.length}`);
console.log(`Clé privée présente : ${priv ? "oui (" + priv.length + " caractères)" : "NON"}`);
try {
  const pub = webpush.generateVAPIDKeys; // simple présence du module
  webpush.setVapidDetails(CONFIG.vapidSubject, CONFIG.vapidPublicKey, priv);
  console.log("Clés VAPID acceptées par web-push.");
} catch (e) { console.log("Clés VAPID refusées : " + e.message); process.exit(1); }
for (const s of subs) {
  try {
    const r = await webpush.sendNotification(s, JSON.stringify({ title: "Test Mac Radar 🔔", body: "Si tu lis ça, les notifications marchent.", url: CONFIG.appUrl, tag: "test-" + Date.now() }), { TTL: 3600, urgency: "high" });
    console.log(`OK ${r.statusCode} → ${s.endpoint.slice(0, 45)}…`);
  } catch (e) {
    console.log(`ÉCHEC ${e.statusCode || ""} → ${s.endpoint.slice(0, 45)}… : ${e.body || e.message}`);
  }
}
