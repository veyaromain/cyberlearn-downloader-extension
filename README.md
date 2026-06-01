# Cyberlearn Downloader

Extension Chrome pour télécharger ou compiler en Markdown les fichiers déposés par les profs sur Cyberlearn (Moodle HES-SO).

## Installation

1. Télécharger ou cloner ce repo
2. Ouvrir Chrome → `chrome://extensions`
3. Activer le **mode développeur** (coin supérieur droit)
4. Cliquer **Charger l'extension non empaquetée** → sélectionner le dossier du repo

## Utilisation

1. Se connecter sur [cyberlearn.hes-so.ch](https://cyberlearn.hes-so.ch) et ouvrir un cours
2. Cliquer sur l'icône de l'extension
3. Les fichiers du cours sont détectés automatiquement
4. Décocher les fichiers à exclure si besoin
5. Choisir un mode :
   - **Compiler pour LLM** — extrait le contenu de tous les fichiers sélectionnés dans un seul `.md` (idéal pour copier-coller dans ChatGPT, Claude, etc.)
   - **Télécharger fichiers** — télécharge les fichiers bruts un par un

## Formats supportés

PDF, images, fichiers texte, code source (`.py`, `.js`, `.sql`…), archives, tableurs, etc.
