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
   - **Télécharger fichiers** — télécharge les fichiers bruts ; zippés automatiquement si plusieurs sont sélectionnés
6. Cliquer le bouton d'action

## Options supplémentaires

Les options sont accessibles via le panneau **Options** (sous le sélecteur de mode).

- **Un fichier `.md` par document** *(mode Compiler uniquement)* — génère un `.md` séparé par fichier au lieu d'un seul document compilé ; les fichiers sont zippés automatiquement si plusieurs sont sélectionnés
- **Filtrer par type** — chips cliquables pour inclure ou exclure des fichiers selon leur extension (PDF, DOCX, etc.)
- **Bouton ↻** *(en haut à droite)* — relance la détection des fichiers sans fermer la popup, utile si le contenu de la page a changé

## Formats supportés

PDF, images, fichiers texte, code source (`.py`, `.js`, `.sql`…), archives, tableurs, etc.

> Les PDFs scannés (sans texte sélectionnable) sont traités par OCR automatiquement via Tesseract.js.
