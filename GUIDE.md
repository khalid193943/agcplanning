# Planning AGC — Gestion d'emploi du temps

Application pour créer et générer automatiquement les emplois du temps de l'Académie Georges Claude.

---

## 🚀 Comment l'ouvrir

1. Gardez **les deux fichiers ensemble** dans le même dossier :
   - `index.html`
   - `app.js`
2. Double-cliquez sur **`index.html`** : l'application s'ouvre dans votre navigateur (Chrome, Edge, Firefox…).

> Une connexion Internet est conseillée au premier chargement (pour les icônes et le logo). Ensuite tout fonctionne normalement.

---

## 🆕 Nouveautés

- **Trois affichages** dans Emploi du temps : **Par classe**, **Par enseignant**, **Par matière**. La vue par enseignant montre tout son emploi du temps (classe · matière) — pratique pour le lui imprimer / envoyer.
- **Cliquer une case vide** dans le tableau ouvre une fenêtre pour **ajouter une séance** (matière + enseignant), avec avertissement si l'enseignant est occupé ou indisponible.
- **Confirmation** avant chaque suppression ou modification (plus d'action accidentelle).
- **Impression soignée** : logo de l'école + en-tête + tableau complet (les boutons et menus sont masqués). Fonctionne aussi pour « Enregistrer en PDF ».
- **Icônes** modernes à la place des émojis.

---

## 📝 Comment l'utiliser

### ✅ Tout est déjà pré-rempli !

Au premier lancement, l'application crée automatiquement :
- **Toutes les matières** du Collège et du Lycée,
- **Les 12 enseignants nommés** (M. Ahmed, M. Driss, Mme. Fatima, M. Karim, M. Youssef, Mme. Sara, M. Hassan, M. Omar, Mme. Khadija, Mme. Leila, M. Rachid, M. Nabil), la plupart partagés entre Collège et Lycée, avec des disponibilités réalistes (certains ont des jours d'indisponibilité ou ne font que les matins/après-midis),
- **Les 6 classes** : 1AC, 2AC, 3AC (Collège) et Tronc Commun, 1Bac, 2Bac (Lycée) — chacune avec ses matières, son enseignant et ses heures (32h/semaine).

Vous pouvez modifier librement chaque enseignant (nom, disponibilités) et ses affectations. Pour partager un prof entre plusieurs classes, choisissez le même nom dans la liste ; pour les séparer, choisissez des noms différents.

➡️ Vous pouvez aller directement à l'menu **Emploi du temps** (barre de gauche) et cliquer **« Générer toutes les classes »**.

Boutons utiles (menu Configuration, barre de gauche) :
- **« ↻ Charger les classes AGC »** : ajoute les classes manquantes sans toucher au reste.
- **« 🗑️ Tout réinitialiser »** : efface tout et recharge proprement Collège + Lycée.

### Étape 1 — Onglet « Configuration » (ajuster si besoin)

**Les matières**
- Saisissez une matière + une couleur, puis « Ajouter ».
- Ou utilisez **« Charger un cycle »** pour ajouter d'un coup toutes les matières d'un niveau (Maternelle, Primaire, Collège, Lycée).

**Les enseignants**
- Ajoutez le nom de l'enseignant.
- Cliquez l'icône 🕒 pour ouvrir sa grille de **disponibilités**.
- Cliquez les créneaux où il est disponible (vert = disponible). Les boutons « Tout cocher / Matins » vont plus vite.

**Les classes**
- Ajoutez le nom de la classe (ex : 1AC).
- Pour chaque matière de la classe : choisissez la matière, l'enseignant, et le nombre d'heures par semaine.
- Le compteur indique si vous atteignez bien **32h / semaine**.

### Étape 2 — Onglet « Emploi du temps »

- Choisissez la classe.
- Cliquez **« Générer cette classe »** (ou « Générer toutes les classes »).
- L'emploi du temps se crée automatiquement.

### Étape 3 — Vérifier et ajuster

- Les **alertes** en haut signalent les problèmes :
  - 🟥 **Rouge** = un enseignant est sur deux classes en même temps (à corriger).
  - 🟧 **Orange** = une heure sans enseignant disponible (placée quand même, à vérifier).
- Vous pouvez **glisser-déposer** un cours pour le déplacer à la main.
- Cliquez le **×** sur un cours pour le retirer.
- Bouton **🖨️ Imprimer** pour afficher ou distribuer.

---

## ⚙️ Les règles respectées automatiquement

- Horaires : matin 8h30→12h30, après-midi 13h30→16h30 (lundi à jeudi), **vendredi matin uniquement**.
- Pauses (10h30–10h45 et déjeuner 12h30–13h30) **non comptées** dans les heures.
- **32 heures par semaine** au total.
- Une matière **ne dépasse pas 2h par jour**, et si 2h le même jour, elles sont **collées** (consécutives).
- Un enseignant **n'est jamais** sur deux classes au même moment.
- Les cours ne sont placés que sur les créneaux où l'enseignant est disponible.

---

## 💾 Sauvegarde

Les données sont enregistrées **automatiquement dans le navigateur** utilisé.

⚠️ Important : si vous changez d'ordinateur ou de navigateur, les données ne suivent pas.
Pour une utilisation partagée entre plusieurs postes, contactez votre développeur pour brancher une base de données.

---

## 🛠️ Personnalisation (pour le développeur)

Tout est en haut du fichier `app.js` :
- `DAYS` : les jours de la semaine.
- `PERIODS` : les créneaux horaires (cours / pause / déjeuner).
- `CYCLE_LIBRARY` : les matières pré-remplies par cycle.

---

*Académie Georges Claude — El Jadida*
