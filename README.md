# Mac Radar

Radar à bons plans MacBook Pro : puce M3/M4/M5 **Pro ou Max**, **24 Go** de RAM minimum, **2 600 €** maximum, neuf ou reconditionné Apple uniquement.

- **Appli** : https://brraaa.github.io/mac-radar/ (à ajouter à l'écran d'accueil de l'iPhone pour recevoir les notifications)
- **Scan** : GitHub Actions toutes les 20 minutes (`.github/workflows/scan.yml`)
- **Sources** : Apple Reconditionné, Dealabs, presse tech via Google/Bing Actualités, LDLC, Materiel.net, Boulanger, Fnac, Darty, Amazon
- **Critères** : `config.json`

## Notifications

1. Ouvre l'appli depuis l'icône de l'écran d'accueil et touche « Activer les notifications ».
2. Touche « Envoyer mon abonnement » : ça ouvre une issue pré-remplie, valide-la.
3. Le workflow `subscribe.yml` enregistre le téléphone et envoie une notification de test.

La clé privée des notifications est dans le secret `VAPID_PRIVATE_KEY` du dépôt.
