# Codemagic — build iOS sans Mac récent

Capacitor 8 exige **Xcode 26+** (impossible sur MacBook 2017). Codemagic compile sur un **Mac M2 cloud** et envoie sur **TestFlight**.

Repo : [github.com/laindy/pcp-mobile](https://github.com/laindy/pcp-mobile)  
Bundle ID : `com.pcpinnov.patient`  
Team Apple : `3R2J5F2KQZ`

---

## 1. Compte Codemagic

1. [codemagic.io](https://codemagic.io) → s'inscrire (GitHub).
2. **Add application** → repo `pcp-mobile`.
3. Codemagic détecte `codemagic.yaml` à la racine après le premier push.

Plan gratuit : ~500 min/mois (suffisant pour quelques builds TestFlight / mois).

---

## 2. Clé API App Store Connect

1. [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access** → **Integrations** → **App Store Connect API**.
2. **+** → nom `Codemagic PCP`, rôle **App Manager**.
3. Télécharger le `.p8` (une seule fois).
4. Noter **Issuer ID** et **Key ID**.

Dans Codemagic :

- **Team settings** → **Team integrations** → **Developer Portal** → **Manage keys**
- **Add key** → nom **`PCP_AppStoreConnect`** (identique à `codemagic.yaml`)
- Issuer ID, Key ID, fichier `.p8`

---

## 3. Certificat + profil iOS

### Option A — génération Codemagic (recommandé)

1. **Team settings** → **codemagic.yaml settings** → **Code signing identities**
2. **iOS certificates** → **Generate certificate** → type **Apple Distribution**, clé `PCP_AppStoreConnect`
3. Télécharger le `.p12` une fois (backup local)
4. **iOS provisioning profiles** → **Fetch profiles** → profil **App Store** pour `com.pcpinnov.patient`
   - Le profil doit inclure **HealthKit** (capability déjà dans `App.entitlements`)

### Option B — upload manuel

Deux onglets **distincts** dans Codemagic → **Settings** → **Code signing identities** :

| Onglet | Fichier | Reference name (exact) |
|--------|---------|------------------------|
| **iOS certificates** | `.p12` Distribution | `pcp_distribution` |
| **iOS provisioning profiles** | `.mobileprovision` App Store | `pcp_distribution` (ou tout nom unique — doit matcher le YAML) |

Le certificat et le profil sont des entrées séparées. Un certificat uploadé seul ne suffit pas.

Sur Apple Developer → **Profiles** → **+** → **App Store Connect** → app `com.pcpinnov.patient` → certificat **identique** à `pcp_distribution` → cocher **HealthKit** → télécharger le `.mobileprovision`.

Après upload du profil, la colonne **Certificate** doit afficher une coche verte (profil lié au bon certificat).

---

## 4. App Store Connect — créer l'app

1. **Apps** → **+** → iOS, nom **PCPTherapy**, bundle `com.pcpinnov.patient`.
2. **General → App Information → Apple ID** (nombre, ex. `6750123456`).
3. Copier cet ID dans `codemagic.yaml` :

```yaml
APP_STORE_APPLE_ID: 6770956276
```

4. **TestFlight** → créer un groupe testeurs (ex. `Internal Testers`) — même nom que dans `beta_groups` du YAML.

### Clé API App Store Connect (PCP INNOV)

| Champ | Valeur |
|-------|--------|
| Nom dans Apple | `pcp` |
| Issuer ID | `04c9e428-5053-4729-bc5f-13614249776d` |
| Key ID | `2UGWQSWK52` |
| Accès | Admin |
| Fichier | `AuthKey_2UGWQSWK52.p8` (téléchargé une seule fois) |

Dans Codemagic → **Team integrations** → nom **`PCP_AppStoreConnect`** (nom Codemagic, pas le nom Apple).

> La **toute première** version peut exiger un upload manuel ou la complétion de métadonnées (privacy URL, catégorie) dans App Store Connect.

---

## 5. Premier build

```bash
cd mobile
git add codemagic.yaml docs/codemagic-setup.md
git commit -m "ci: Codemagic iOS TestFlight"
git push origin main
```

Dans Codemagic → app `pcp-mobile` → workflow **iOS → TestFlight** → build démarre.

Durée typique : 15–25 min.

---

## 6. Workflows

| Workflow | Déclencheur | Résultat |
|----------|-------------|----------|
| **iOS → TestFlight** | push `main`, `feat/*`, tags `v*` | IPA + upload TestFlight |
| **iOS build (sans upload)** | pull request | IPA en artifact (vérif compile) |

Build manuel : bouton **Start new build** dans l'UI Codemagic.

---

## 7. Workflow quotidien (Mac 2017)

| Action | Où |
|--------|-----|
| Éditer JS (`www/`) ou Swift | Mac local |
| `npx cap sync ios` | **Codemagic** (inclus dans le workflow) |
| Archive + signature | **Codemagic** |
| Test sur iPhone | **TestFlight** |
| Contenu web seul (`patient.pcpinnov.com`) | Pas de rebuild iOS nécessaire |

Rebuild iOS requis si : plugins Capacitor, Swift natif, permissions, `Info.plist`, icônes.

---

## 8. Dépannage

| Erreur | Piste |
|--------|-------|
| `No provisioning profile with reference '…'` | Le **Reference name** du profil doit être identique à `profile:` dans `codemagic.yaml` |
| `Certificate: Not uploaded` (rouge) | Le `.p12` dans **iOS certificates** n’est pas celui utilisé pour créer le profil sur Apple — aligner ou regénérer |
| `No matching provisioning profiles` | Profil App Store + HealthKit pour `com.pcpinnov.patient` |
| `Xcode 26` / SDK | `xcode: latest` sur `mac_mini_m2` — vérifier la stack Codemagic |
| `pod install` fail | `pod install` local une fois pour commit `Podfile.lock` si absent |
| Build number duplicate | Vérifier `APP_STORE_APPLE_ID` (non `0`) |
| TestFlight sans testeurs | Ajouter emails au groupe dans App Store Connect |

Logs : Codemagic UI → build → **xcodebuild_logs**.

---

## 9. Android (optionnel, même compte)

Keystore : voir `android/keystore.properties.example`.  
Workflow Android Play Store : [doc Codemagic Ionic/Capacitor](https://docs.codemagic.io/yaml-quick-start/building-an-ionic-app/).
