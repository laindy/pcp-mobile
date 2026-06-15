# Intégration `PcpHealthBridge` côté frontend Next.js

L'app Android expose à la WebView un objet JavaScript global
`window.PcpHealthBridge` qui pilote la sync santé native (Health Connect →
backend PCP). Cette sync tourne en background via WorkManager toutes les 6 h
et **ne fait aucune lecture côté JS** — donc zéro impact sur le quota
Health Connect.

Pour qu'elle fonctionne, le frontend doit transmettre au bridge :

1. le **JWT patient** après login NextAuth ;
2. (optionnel) l'**URL API** si elle diffère de `https://patient.pcpinnov.com` ;
3. un appel `clearToken()` au logout.

---

## API exposée

```ts
interface PcpHealthBridge {
  /** Stocke le JWT chiffré + planifie la sync périodique + lance une sync immédiate. */
  setToken(jwt: string): void;

  /** Efface le token + annule la sync périodique. */
  clearToken(): void;

  /** Override de l'URL API (défaut https://patient.pcpinnov.com). */
  setApiBase(url: string): void;

  /** Déclenche une sync one-shot (WorkManager). Réseau requis. */
  triggerSync(): void;

  /** True si un token est actuellement stocké. */
  hasToken(): boolean;

  /** JSON {lastSyncAt, lastErrorAt, lastInserted, lastMessage, hasToken, apiBase}. */
  getLastSyncInfo(): string;
}

declare global {
  interface Window {
    PcpHealthBridge?: PcpHealthBridge;
  }
}
```

L'objet n'existe **que dans la WebView Android**. Le frontend doit toujours
faire un `if (window.PcpHealthBridge?.setToken)` pour ne pas casser le build
web standard.

---

## Intégration recommandée (NextAuth)

Créer un petit hook qui se déclenche dès qu'une session valide est disponible :

```tsx
// frontend/src/hooks/useNativeHealthBridge.ts
"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

export function useNativeHealthBridge() {
  const { data: session, status } = useSession();

  useEffect(() => {
    const bridge = (window as any).PcpHealthBridge;
    if (!bridge) return; // pas dans l'app mobile → no-op

    if (status === "authenticated" && session?.accessToken) {
      bridge.setToken(session.accessToken);
    } else if (status === "unauthenticated") {
      bridge.clearToken();
    }
  }, [status, session?.accessToken]);
}
```

Puis brancher dans le layout patient :

```tsx
// frontend/src/app/[locale]/(patient)/layout.tsx
"use client";

import { useNativeHealthBridge } from "@/hooks/useNativeHealthBridge";

export default function PatientLayout({ children }) {
  useNativeHealthBridge();
  return <>{children}</>;
}
```

---

## Détection "je suis dans l'app mobile"

Le bridge n'existe que dans la WebView Android. Pour un check explicite :

```ts
export const isMobileApp = () =>
  typeof window !== "undefined" && !!(window as any).PcpHealthBridge;
```

Utile pour conditionner l'affichage de UI mobile-spécifique (pas de bandeau
"installer l'app", consentement HC, etc.) ou les liens vers les réglages
système.

---

## Cycle de vie côté natif

| Évènement frontend                       | Action natif                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `setToken(jwt)`                          | Token chiffré → `EncryptedSharedPreferences` ; `PeriodicWork 6h` planifié ; `OneTimeWork` immédiat |
| `clearToken()`                           | Token effacé + `PeriodicWork` annulé                                      |
| `setApiBase(url)`                        | Override persisté (par défaut `https://patient.pcpinnov.com`)              |
| `triggerSync()`                          | `OneTimeWork` immédiat (REPLACE policy, retry backoff 30s)                |
| Worker exécuté (toutes les 6h ou one-shot) | Lit HC (aggregate steps/distance/calories, raw heartRate/weight) → POST `/api/v1/patients/me/health/sync` |

Erreurs backend gérées :
- `2xx` → succès, métadonnées persistées
- `401`/`403` → token effacé silencieusement (utilisateur devra se reconnecter)
- `4xx` autre → success (pas de retry, log natif)
- `5xx` / réseau → `Result.retry()` avec backoff exponentiel WorkManager

---

## Permissions Health Connect

Les permissions sont déclarées par `@capgo/capacitor-health` dans son
`AndroidManifest.xml` et mergées automatiquement :

- `android.permission.health.READ_STEPS`
- `android.permission.health.READ_DISTANCE`
- `android.permission.health.READ_ACTIVE_CALORIES_BURNED`
- `android.permission.health.READ_HEART_RATE`
- `android.permission.health.READ_WEIGHT`

**Le frontend doit guider l'utilisateur** à ouvrir une fois la page de
consentement Health Connect (via le plugin capgo `Health.requestAuthorization`)
pour les accorder. Sinon le worker natif sync sans données (`fetch.errors`
listera les types refusés).

Page debug native pour tester : appuyer sur le FAB "Test Santé" en bas à
droite de l'app (visible en build debug & release pour le moment, à mettre
derrière `BuildConfig.DEBUG` quand le besoin disparaît).

---

## Métriques quota

| Mode                                | Reads HC / 24h | Quota HC (foreground = 2000/15min) |
| ----------------------------------- | -------------- | ---------------------------------- |
| Ancien code JS (Promise.all × 5)    | 100-500 selon clicks | Brûlé en 5-10 refresh             |
| Nouveau worker natif (1× toutes 6h) | ~20 reads/jour | < 1% du quota                      |
| + `triggerSync()` manuel ponctuel   | +5 reads par déclenchement | toujours < 5% du quota         |

Le rate-limit `Request rejected. Rate limited request quota has been exceeded`
ne devrait plus jamais apparaître en conditions normales.
