# Planning AGC — déploiement sur Vercel

Application d'emplois du temps de l'Académie Georges Claude.
Les données sont enregistrées **sur le serveur** et partagées par tous les postes
qui se connectent avec le même compte.

---

## 1. Mettre les fichiers sur GitHub

Copiez ces fichiers à la racine de votre dépôt :

```
index.html
app.js
package.json
.gitignore
api/planning.js        ← le dossier « api » et son fichier
```

Le dossier `api` doit être **à la racine**, pas dans un sous-dossier.
Vercel le détecte automatiquement et en fait une fonction serveur.

---

## 2. Créer le stockage (une seule fois)

1. Ouvrez votre projet sur **vercel.com**.
2. Onglet **Storage** → **Create Database** → choisissez **Blob**.
3. Donnez-lui un nom (ex. `planning-agc`) puis **Create**.
4. Vercel propose de le connecter au projet : acceptez.

Vercel ajoute alors tout seul la variable `BLOB_READ_WRITE_TOKEN`.
Vous n'avez rien à copier à la main.

> Vercel Blob est le stockage intégré de Vercel. Aucun service extérieur,
> aucun autre compte à créer.

---

## 3. Choisir l'identifiant et le mot de passe

Toujours dans le projet Vercel : **Settings** → **Environment Variables**.

| Nom            | Valeur                    |
|----------------|---------------------------|
| `AGC_USER`     | l'identifiant de l'école   |
| `AGC_PASSWORD` | le mot de passe de l'école |

Cochez les trois environnements (Production, Preview, Development), puis **Save**.

Si vous ne mettez rien, les identifiants par défaut sont `agc` / `agc2026`.
**Changez-les avant de livrer à l'école.**

Tout le personnel utilise ce même compte : c'est voulu, tout le monde travaille
sur le même planning.

---

## 4. Redéployer

Onglet **Deployments** → sur le dernier déploiement, menu `…` → **Redeploy**.
C'est nécessaire pour que les variables soient prises en compte.

L'application est prête.

---

## Comment ça fonctionne au quotidien

**Enregistrement automatique.** Chaque modification part vers le serveur environ
une seconde après la dernière frappe. L'indicateur dans la barre de gauche affiche
l'état : « Enregistrement… », puis « Enregistré sur le serveur ».

**Bouton « Enregistrer maintenant ».** Pour forcer l'envoi immédiatement et avoir
la confirmation à l'écran.

**Plusieurs professeurs en même temps.** L'application surveille le serveur toutes
les 45 secondes. Si quelqu'un modifie le planning depuis un autre poste :

- si vous n'avez rien modifié de votre côté, votre écran se met à jour tout seul
  et un message vous prévient ;
- si vous aviez des modifications en cours, un bandeau orange apparaît en haut
  et vous demande quoi garder : **la version du serveur** ou **vos modifications**.
  Rien n'est écrasé sans votre accord.

**Confirmations.** Toute suppression est confirmée (matière, enseignant, classe,
séance), ainsi que la réinitialisation, le vidage d'un emploi du temps et la
régénération d'un planning déjà rempli.

**Coupure réseau.** L'application continue de fonctionner avec une copie locale et
affiche « Serveur injoignable ». Les modifications repartent dès le retour du réseau.

---

## Questions fréquentes

**Les données peuvent-elles disparaître ?**
Non. Elles sont dans le stockage Vercel Blob, conservé indépendamment du code.
Vous pouvez redéployer, modifier ou réinstaller le site : les données restent.

**Et si j'ouvre `index.html` directement sur un ordinateur, sans Internet ?**
L'application fonctionne en mode local, avec les identifiants de secours inscrits
dans `app.js`. Les données restent alors sur cet ordinateur uniquement.

**Comment faire une sauvegarde ?**
Dans Vercel, onglet Storage → votre Blob → le fichier `planning-agc/data.json`
peut être téléchargé.

**Combien ça coûte ?**
Le volume d'un planning scolaire est de l'ordre de quelques centaines de kilo-octets.
C'est très en dessous des seuils de l'offre gratuite de Vercel.

---

## Modifier les identifiants plus tard

Settings → Environment Variables → modifier `AGC_USER` ou `AGC_PASSWORD` →
puis **Redeploy**. Aucun changement de code n'est nécessaire.

---

*Académie Georges Claude — El Jadida*
