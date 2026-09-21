# Planning AGC — version 4

Emplois du temps de l'Académie Georges Claude, El Jadida.

Application **Next.js 16** avec une base de données **PostgreSQL**.
Toutes les données sont enregistrées en ligne, rien n'est gardé dans le navigateur.
Un seul accès administrateur : **`adminagc`**.

---

## Nouveautés de la version 4

**Export Excel.** Deux boutons dans l'emploi du temps. **Excel** exporte ce qui est
affiché (une classe, un enseignant ou une matière). **Excel — tout** produit un classeur
complet : une page *Sommaire* avec des liens cliquables, puis une feuille par classe
et une feuille par enseignant. Couleurs des matières, pauses regroupées, format A4
paysage prêt à imprimer.

**Nouveaux horaires.** 08h00 – 09h00, 09h00 – 10h00, pause 10h00 – 10h15,
10h15 – 11h00, 11h00 – 12h00, pause déjeuner 12h00 – 12h30, 12h30 – 13h30,
13h30 – 14h30, 14h30 – 15h30. Le vendredi : cours le matin uniquement (08h00 – 12h00).
Soit 32 heures de cours par semaine et par classe.

**Année scolaire.** Réglée dans *Configuration → Établissement*. Elle s'affiche sur
tous les emplois du temps, à l'impression et dans les fichiers Excel.

**Plusieurs matières par enseignant.** Au moment d'ajouter un enseignant, on coche
une ou plusieurs matières. Le bouton livre de chaque enseignant permet de les modifier
à tout moment. L'enseignant est alors proposé pour chacune de ses matières dans les classes.

**Parcours guidé.** L'onglet *Établissement* montre les 4 étapes de mise en place
(matières, enseignants, classes, emplois du temps), leur état, et la prochaine étape
à faire. Chaque section se termine par un bouton « Étape suivante ».

Les données de la version précédente sont converties automatiquement au premier
chargement : rien à faire.

---

## Installation sur Vercel

À faire une seule fois. Si la version 3 est déjà en ligne, seule l'étape 1 est
nécessaire : remplacez les fichiers, Vercel redéploie tout seul.

### 1. Remplacer les fichiers sur GitHub

Dans le dépôt `agcplanning`, **supprimez d'abord les anciens fichiers** :

```
index.html      app.js      package.json
DEPLOIEMENT.md  GUIDE.md    api/  (le dossier entier)
```

C'est indispensable pour le dossier `api/` : l'ancien fichier `api/planning.js`
entrerait en conflit avec la nouvelle version.

Envoyez ensuite le contenu de ce projet à la racine du dépôt :

```
app/  components/  lib/  public/
package.json  package-lock.json  next.config.mjs  tsconfig.json
.gitignore  .env.example  README.md
```

### 2. Indiquer à Vercel que c'est un projet Next.js

Projet `agcplanning` → **Settings** → **Build and Deployment**.

- **Framework Preset** : choisissez **Next.js**
- Laissez vides *Build Command*, *Output Directory* et *Install Command*

### 3. Créer la base de données

Onglet **Storage** → **Create Database** → **Neon** (Serverless Postgres).

- Région : **Europe (Frankfurt)**, la plus proche du Maroc
- Offre gratuite : largement suffisante pour un établissement
- Acceptez de la **connecter au projet** `agcplanning`

Vercel ajoute tout seul la variable `DATABASE_URL`. Aucune commande SQL à lancer :
les tables se créent au premier démarrage.

> **Conseillé** : Settings → **Functions** → Function Region → **Frankfurt (fra1)**.

### 4. Choisir le mot de passe administrateur

**Settings** → **Environment Variables** → **Add Environment Variable**

| Nom              | Valeur                          | Obligatoire |
|------------------|---------------------------------|-------------|
| `ADMIN_PASSWORD` | le mot de passe de l'école      | **oui**     |
| `ADMIN_USER`     | `adminagc`                      | non (valeur par défaut) |

Cochez **Production**, **Preview** et **Development**, puis **Save**.
Le mot de passe n'est écrit nulle part dans le code (le dépôt GitHub est public).

Ne supprimez pas la variable `BLOB_READ_WRITE_TOKEN` si elle existe : elle permet de
reprendre automatiquement les données de la toute première version.

### 5. Redéployer

**Deployments** → dernier déploiement → menu `…` → **Redeploy**.

### 6. Vérifier

Ouvrez le site. S'il manque un réglage, un **encadré orange « Configuration
incomplète »** apparaît au-dessus du formulaire de connexion et indique quoi corriger.

Connectez-vous avec `adminagc`. En bas de la barre latérale, l'indicateur doit
afficher en vert **« Enregistré en ligne »**.

---

## Utilisation au quotidien

**Enregistrement automatique.** Chaque modification part vers la base environ une
seconde après. L'indicateur de la barre latérale montre l'état :

| Indicateur                        | Signification |
|-----------------------------------|---------------|
| Enregistré en ligne (vert)        | Tout est sauvegardé |
| Enregistrement… (jaune)           | Envoi en cours |
| Non enregistré — nouvel essai     | Réseau coupé : l'application réessaie toute seule |
| Conflit à régler                  | Le planning a été modifié sur un autre appareil |
| Session expirée                   | Reconnexion nécessaire (rien n'est perdu) |

**Historique.** Une copie est gardée avant chaque action confirmée (suppression,
réinitialisation, régénération, vidage) et toutes les 10 minutes pendant le travail.
Le bouton **Restaurer** revient à une version précédente, et la restauration elle-même
peut être annulée.

**Deux appareils en même temps.** L'application le détecte. Sans modification en cours,
l'écran se met à jour tout seul ; sinon, un bandeau demande quoi garder, et la version
écartée reste dans l'historique.

**Coupure Internet.** On peut continuer à travailler : les modifications partent dès
le retour du réseau.

**Session.** La connexion dure 7 jours et se prolonge à chaque utilisation. Changer le
mot de passe dans Vercel déconnecte tous les appareils. Après 8 mots de passe erronés,
l'accès est bloqué 15 minutes pour cette adresse.

---

## Contrôles effectués avant livraison

- 102 vérifications dans un vrai navigateur Chrome, chacune confirmée dans la base
  PostgreSQL : connexion, établissement et année scolaire, matières, enseignants à
  plusieurs matières, classes, génération, glisser-déposer, ajout et retrait de séances,
  vues, impression, exports Excel, rechargement, conflit entre appareils, coupure
  réseau, historique, session expirée, conversion des anciennes données, déconnexion.
- 38 tests de l'API : sécurité, sessions, verrouillage, historique, limites.
- Fichiers Excel ouverts et analysés par un lecteur indépendant.
- Reconstruction complète à partir de zéro, comme sur Vercel.

---

## Essai sur un ordinateur (développeurs)

```bash
npm install
cp .env.example .env.local     # puis renseigner DATABASE_URL et ADMIN_PASSWORD
npm run dev                    # http://localhost:3000
```

Node.js 20.9 ou plus récent est nécessaire.

---

## Contenu technique

| Élément                      | Rôle |
|------------------------------|------|
| `app/login/`                 | Écran de connexion |
| `app/page.tsx`               | Page principale, réservée à l'administrateur connecté |
| `app/api/auth/`              | Connexion et déconnexion |
| `app/api/planning/`          | Lecture et enregistrement du planning, historique |
| `app/api/health/`            | Diagnostic de la configuration |
| `lib/db.ts`                  | Accès PostgreSQL, création et réparation automatiques des tables |
| `lib/session.ts`             | Session signée, vérification du mot de passe |
| `public/planning/app.js`     | Moteur du planning (génération, glisser-déposer, export Excel) |
| `public/vendor/`, `public/fonts/` | Icônes, outil Excel et polices, hébergés par le site |

Aucune dépendance à un service externe à l'exécution.

**Versions** : Next.js 16.3.5 · React 19.3 · PostgreSQL (pilote `pg` 8.23) · ExcelJS 4.4 · TypeScript 5.9

---

*Académie Georges Claude — El Jadida · Collège & Lycée*
