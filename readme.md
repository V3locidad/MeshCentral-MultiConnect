# MeshCentral-MultiConnect

Plugin MeshCentral pour se connecter simultanément sur plusieurs postes Windows avec un compte domaine ou local.

## Fonctionnalités

- **Profils de connexion** : Gérez des comptes domaine (`DOMAINE\utilisateur`) ou locaux (`.\utilisateur`) avec mots de passe chiffrés (AES-256)
- **Sélection multiple** : Sélectionnez plusieurs postes avec recherche et filtrage, statut en ligne/hors ligne
- **Connexion batch** : Ouvrez une session console interactive sur tous les postes sélectionnés en un clic
- **Historique** : Consultez l'historique des connexions avec statut de réussite/échec
- **Compatible Windows 10/11** : Utilise `cmdkey` + `mstsc` + `tscon` avec fallback via tâche planifiée

## Comment ça marche

1. Vous créez un **profil de connexion** avec un compte domaine ou local
2. Vous **sélectionnez les postes** cibles (seuls les postes en ligne sont connectés)
3. Le plugin envoie un script PowerShell à chaque agent qui :
   - Stocke temporairement les credentials via `cmdkey`
   - Crée une session RDP locale (`mstsc /v:127.0.0.1`)
   - Bascule cette session sur la console via `tscon`
   - Nettoie les credentials stockés
4. Vous pouvez ensuite **prendre la main** via le Bureau à distance de MeshCentral sur chaque poste

## Installation

### Prérequis

- MeshCentral avec les plugins activés dans `config.json` :
```json
{
  "settings": {
    "plugins": {
      "enabled": true
    }
  }
}
```

### Installation via l'interface

1. Allez dans **Mon serveur** > **Plugins**
2. Cliquez sur **Ajouter un plugin**
3. Entrez l'URL de configuration :
```
https://raw.githubusercontent.com/V3locidad/MeshCentral-MultiConnect/master/config.json
```

### Installation manuelle

1. Téléchargez ou clonez ce dépôt
2. Placez le dossier `MeshCentral-MultiConnect` dans :
```
meshcentral-data/plugins/
```
3. Redémarrez MeshCentral

## Structure du plugin

```
MeshCentral-MultiConnect/
├── config.json                  # Configuration du plugin
├── multiconnect.js              # Logique serveur (gestion profils, dispatch)
├── db.js                        # Couche base de données
├── changelog.md                 # Journal des modifications
├── readme.md                    # Ce fichier
├── views/
│   └── multiconnect.html        # Interface Web (onglets, formulaires)
└── modules_meshcore/
    └── multiconnect.js          # Module agent (exécution sur les postes)
```

## Sécurité

- Les mots de passe sont chiffrés en AES-256-CBC avant stockage
- La clé de chiffrement est dérivée de la clé de session du serveur MeshCentral
- Les credentials `cmdkey` sont supprimés immédiatement après utilisation
- Chaque utilisateur ne voit que ses propres profils
- Les tâches planifiées de fallback sont supprimées après exécution

## Notes importantes

- **Windows seulement** : Ce plugin ne fonctionne que sur les postes Windows 10/11
- **Agent en SYSTEM** : L'agent MeshCentral tourne en SYSTEM, ce qui lui permet de créer des sessions interactives
- **RDP local** : Sur Windows 10/11 Home, le RDP n'est pas disponible nativement. Le fallback via tâche planifiée sera utilisé
- **Bureau à distance unique** : Windows 10/11 ne supporte qu'une session console à la fois. L'utilisateur actuel sera déconnecté

## Dépannage

### La session ne s'ouvre pas
- Vérifiez que l'agent est en ligne et fonctionne en tant que service (SYSTEM)
- Vérifiez que les credentials sont corrects
- Sur Windows Home, seul le fallback via tâche planifiée fonctionne

### Erreur "Access denied"
- Vérifiez que le compte a les droits de connexion interactive sur le poste
- Pour les comptes domaine, vérifiez que le poste est bien joint au domaine

## Licence

MIT
