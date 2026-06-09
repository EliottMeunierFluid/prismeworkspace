# Plan d'implémentation — Bouton « Récupérer la configuration » (variante 2a)

> Branche desktop : `feat/config-fetch-button` (depuis `feat/sync-auto-reactivate`).
> Objectif : pull/push de la configuration (skills, contexts, `.mcp.json`) depuis un
> bouton natif de l'app desktop Electron, **sans passer par l'IA** (ni le skill `/update`,
> ni le bootstrap curl).

## 0. Résultat du spike auth (rappel)

- `/api/config/*` (fetch/get/diff/push) n'accepte QUE des tokens `prism_*`
  (`prisme-one-configuration/.../config-sync/guards/token-auth.guard.ts`).
- Les tokens `prism_` sont aujourd'hui créés par une route **admin-only**
  (`POST /api/config/tokens`, guards `AuthGuard+RoleGuard+CompanyContextGuard`).
- Le token du desktop est un **JWT maison HS256** signé par le site SaaS
  (`workspace-prisme-one/src/app/oauth/desktop/page.tsx`), `iss=workspace.prisme.one`,
  `aud=prisme-sync`, claims `{sub,email,plan}` — **pas un JWT Supabase**, **pas de `aal2`**.
- MAIS l'identité est partagée : `sub` = `userId` Supabase commun aux deux apps.

→ **Variante 2a** : ajouter côté API config une route **self-service** qui vérifie le
JWT SaaS (secret partagé) et émet un token `prism_` pour le user. Le desktop réutilise
son JWT sync existant ; aucune nouvelle authentification utilisateur.

---

## 1. Côté serveur — `prisme-one-configuration`

> Repo séparé. À faire sur sa propre branche (ex. `feat/self-service-token`).

### 1.1 Nouveau guard : `SaasJwtGuard`

Fichier : `apps/api/src/app/config-sync/guards/saas-jwt.guard.ts`

- Vérifie `Authorization: Bearer <jwt>` avec `jsonwebtoken.verify(token, SAAS_JWT_SECRET, { algorithms:['HS256'], issuer:'workspace.prisme.one', audience:'prisme-sync' })`.
- `SAAS_JWT_SECRET` = **le même** `JWT_SECRET` que le site SaaS (variable d'env partagée).
- Injecte `request.saasUser = { id: payload.sub, email: payload.email, plan: payload.plan }`.
- 401 si invalide/expiré.

### 1.2 Nouvelle route self-service

Fichier : `apps/api/src/app/config-sync/controllers/config-token.controller.ts`
(ajout d'une méthode ; ou nouveau controller `config-token-self.controller.ts` pour
ne pas mélanger les guards).

```
POST /api/config/tokens/me      @UseGuards(SaasJwtGuard)
```

Logique :
1. `userId = request.saasUser.id` (UUID Supabase).
2. Lookup Supabase via `SupabaseService` (service_role) → `getUserById(userId)` :
   - `companyId` : **`app_metadata.company_id`** (cf §1.4 — source canonique confirmée
     par la doc de `CompanyEntity`). Si absent (super-admin ou user mal provisionné)
     → **400 `company_required`**, pas de fallback silencieux.
   - `poleIds` : `app_metadata.poles` (helper `extractPoles` déjà présent dans le controller).
   - `role` : `app_metadata.role ?? 'employee'`.
3. `tokenService.revokeAllForUser(companyId, userId)` (règle 1 token actif/user — déjà utilisée).
4. `tokenService.createToken(companyId, userId, userName, scopes)` — **TTL 90 j** (défaut
   `DEFAULT_EXPIRATION_DAYS`, ne rien passer ; cf §1.5 le desktop re-génère à expiration).
5. Retour `{ token, expiresAt, apiUrl }` — `token` affiché/consommé une seule fois.

> Réutilise intégralement `TokenService` existant (`token.service.ts`) — rien à modifier
> dans ce service.

### 1.3 Wiring module

`apps/api/src/app/config-sync/config-sync.module.ts` :
- ajouter `SaasJwtGuard` aux `providers` (et `exports` si réutilisé) ;
- si nouveau controller, l'ajouter à `controllers`.

### 1.4 Origine du `companyId` self-service — ✅ TRANCHÉ

La doc de `CompanyEntity` (`apps/api/src/app/admin/entities/company.entity.ts`) est
explicite : **« Chaque user Supabase est rattaché à une et une seule entreprise via
`app_metadata.company_id` »**. Le header `X-Company-Id` du flux admin n'est qu'un
sélecteur d'UI, pas une dérivation.
→ Lire `companyId = supabaseUser.app_metadata.company_id`. Si absent → 400 `company_required`.
  Refuser les super-admins (pas de `company_id`) sur cette route.

### 1.5 Sécurité — ✅ TRANCHÉ : accepter le JWT sync sans `aal2`

Décision produit actée. Justification : la route est intrinsèquement **self-only**
(le `userId` vient du `sub` du JWT signé — on ne peut générer un token que pour
soi-même), contrairement à la route admin qui cible n'importe quel `userId` (d'où son
exigence `aal2`). Le JWT sync est déjà la preuve d'identité protégeant les vaults E2EE.

Compensations obligatoires :
- Scopes **dérivés serveur uniquement** (jamais du client) — déjà le cas via `app_metadata`.
- `revokeAllForUser` avant création (1 token actif/user) — limite la fenêtre d'exposition.
- **Refus des super-admins** (pas de `company_id` → 400).
- **Rate-limit léger** sur `/tokens/me` (anti-abus).
- TTL `prism_` : **90 j** (défaut). Le desktop re-génère via `/tokens/me` à expiration,
  transparent pour l'utilisateur.

> Variante 2b (relayer un access_token Supabase aal2) écartée pour la v1 : gros chantier
> (site SaaS + flow 2FA + desktop) pour un gain marginal vu le caractère self-only.

### 1.6 Variable d'env

- `SAAS_JWT_SECRET` (= `JWT_SECRET` du site SaaS). À provisionner dans le `.env` /
  GitLab CI du repo config. **Ne jamais logger.**

### 1.7 Tests

- Unit : `SaasJwtGuard` (token valide / mauvais secret / mauvais iss/aud / expiré).
- Unit/e2e : `POST /tokens/me` → 200 + token `prism_` ; 401 sans JWT ; révocation de
  l'ancien token ; scopes dérivés corrects.

---

## 2. Côté desktop — `prismeworkspace` (cette branche)

### 2.1 Client HTTP API config (process main)

Fichier : `packages/desktop/src/main/config/api.ts` (nouveau ; calqué sur
`packages/desktop/src/main/sync/api.ts`).

- `getConfigApiUrl()` : `process.env.CONFIG_API_URL ?? "https://prisme-one-config.eliottmeunier.com"`
  (URL prod confirmée dans `prisme-one-configuration/docs/DEPLOYMENT.md` — container
  `127.0.0.1:3040:3000` derrière nginx Cloudron. ⚠️ PAS `aveleolabs.io`, valeur d'un
  vieux brouillon obsolète).
- `fetchPrismToken()` : `POST {CONFIG_API_URL}/api/config/tokens/me` avec
  `Authorization: Bearer <JWT sync>` (réutilise `loadAuthToken()` de `sync/auth.ts`).
  → renvoie `{ token: prism_, apiUrl, expiresAt }`.
- `configFetch(prismToken)` : `GET /api/config/fetch`.
- `configGet(prismToken, path)` : `GET /api/config/get?path=`.
- `configDiff(prismToken, body)` : `POST /api/config/diff`.
- `configPush(prismToken, body)` : `POST /api/config/push`.
- `mcpConfig(prismToken)` : `GET /api/mcp-config`.
- `mcpManifest(prismToken)` : `GET /api/mcp-manifest`.

Le `prism_` obtenu est **mis en cache chiffré** via `safeStorage`/electron-store
(clé `config.prism-token`), réutilisé tant que non expiré ; re-fetch via `/tokens/me`
sinon. Modèle : `sync/auth.ts` (`storeAuthToken`/`loadAuthToken`).

### 2.2 Moteur de sync config (port natif de `sync.sh` + logique `/update`)

Fichier : `packages/desktop/src/main/config/engine.ts` (nouveau).

Réimplémente, en TypeScript, ce que faisaient `sync.sh` + le raisonnement du skill :
- **Hash SHA-256 normalisé** : supprimer `\r` et espaces de fin de ligne, puis sha256.
  ⚠️ **Parité octet-pour-octet** avec `ConfigManifestService.hashContent` côté serveur —
  prévoir un test de parité (cf §2.6).
- **Layout disque** dans le projet courant (cf §2.3) :
  `.prisme-one/state/{manifest.json}`, `.prisme-one/<path>` (fichiers réels),
  `.prisme-one/cache/{.mcp.json, mcp-manifest.json}`, symlink `.mcp.json` →
  `.prisme-one/cache/.mcp.json`, symlinks `.claude/skills/<nom>` → `.prisme-one/skills/...`.
- **Diff 3-way** local / ancestor(manifest) / remote → `{pull, push, conflicts, revoked}`.
- **Pull** : `configGet` → écrit `.prisme-one/<path>`.
- **Push** : `configPush` (create/update selon présence dans ancestor).
- **Conflits** : remontés à l'UI (PAS de fusion IA) → résolution **garder local /
  prendre distant** (option fusion = hors périmètre natif, cf décision §0 analyse).
- **Manifest** : jamais écrit si une opération échoue (atomicité — repris au prochain run).
- **MCP** : écrit `.mcp.json` + manifest, gère opt-out `.prisme-one/no-mcp` et backup
  d'un `.mcp.json` pré-existant (`.mcp.json.local-backup.<ts>`).

### 2.3 Projet courant

Le projet actif est `decode64(params.dir)` (cf `session-header.tsx`,
`context/layout.tsx` → `worktree`). Le renderer transmet ce chemin absolu à l'IPC ;
le moteur écrit sous `<worktree>/.prisme-one/...`.

### 2.4 IPC (main ↔ preload ↔ renderer)

- `packages/desktop/src/main/config/ipc.ts` (nouveau) : handlers
  `config:status`, `config:fetchToken`, `config:plan` (calcul diff, renvoie le résumé),
  `config:apply` (exécute pull/push + résolutions de conflit passées par l'UI).
- Enregistrer dans le bootstrap IPC du main (cf `packages/desktop/src/main/ipc.ts` +
  l'enregistrement existant de `sync/ipc.ts`).
- `packages/desktop/src/preload/index.ts` + `types.ts` : exposer
  `window.api.config.*` (mêmes signatures).

### 2.5 UI — bouton dans la titlebar (à côté de Sync)

- Emplacement : `packages/app/src/components/titlebar.tsx` (~ligne 329, portail
  `#opencode-titlebar-right`), à côté de `<SyncIndicator />`.
- Nouveau composant `packages/app/src/components/config-indicator.tsx` (calqué sur
  `sync-indicator.tsx`) :
  - icône + état (à jour / changements dispo / erreur / non configuré) ;
  - clic → ouvre un panneau : « Récupérer la configuration » (pull), résumé du diff
    (pull/push/conflits/révoqués), confirmation, résolution de conflits (garder
    local / prendre distant), rapport final.
- i18n : ajouter les clés dans les fichiers de langue (cf `context/language`).

### 2.6 Tests

- Parité hash (vecteurs partagés avec le serveur).
- Diff 3-way (cas pull/push/conflict/revoked).
- Atomicité manifest sur échec réseau.
- IPC round-trip (mock du client API).

---

## 3. Séquencement recommandé / avancement

1. [x] **Serveur 2a** (`prisme-one-configuration`, branche `feat/self-service-token`) :
   `SaasJwtGuard` + `POST /api/config/tokens/me` + tests (16/16). Var `SAAS_JWT_SECRET`.
2. [x] **Desktop — client API + fetchToken** (`main/config/api.ts`, `token-store.ts`) :
   `fetchPrismToken()` (JWT sync → prism_), cache chiffré safeStorage.
3. [x] **Desktop — pull-only** (`main/config/engine.ts` : fetch→get→write→symlinks→
   manifest→mcp) + hash normalisé avec **test de parité serveur** (`hash.test.ts`, 9/9)
   + IPC (`main/config/ipc.ts`) + preload + bouton `<ConfigIndicator />` titlebar.
4. [x] **Desktop — diff + push** (`config/diff.ts` : diff3Way pur + 10 tests ;
   `engine.ts` : `computeLocalState`, `planSync`, `applySync` ; IPC `config:plan` /
   `config:apply` ; preload + types).
5. [x] **Desktop — conflits** (UI : par conflit, boutons Local / Distant ; case
   "supprimer les révoqués" ; bouton Appliquer désactivé tant que conflits non résolus ;
   read-only → bouton Local désactivé).
6. [x] **UI polish + i18n + tests** :
   - i18n : tous les libellés du `<ConfigIndicator />` passés en clés `header.config.*`
     (EN dans `i18n/en.ts` = source de vérité du type, FR dans `i18n/fr.ts`). Plus aucun
     texte en dur ; interpolation `{{count}}`/`{{date}}` type-checkée.
   - tests : `engine.test.ts` — 8 tests d'intégration **sur disque réel** (temp dir,
     réseau mocké via `mock.module`) couvrant pull / push (create+update) / conflit
     résolu local|remote / révocation (avec et sans suppression) / no-op / exclusion
     state+cache. Total module : **27 tests** verts.

> État au 2026-06-09 : étapes 1-6 **terminées**. Typecheck app+desktop OK ; 27 tests
> config OK ; lint 0 erreur (warnings résiduels = pattern JSON-parse identique à
> `sync/api.ts`). Le bouton calcule un **diff 3-way** et applique pull/push/révocations
> + résolution de conflits Local/Distant (pas de fusion IA), entièrement i18n.
> `config:pull` (pull simple) reste dispo pour une 1ère synchro/fallback.
>
> Reste avant prod (ops, hors code) : déployer le serveur 2a + aligner `SAAS_JWT_SECRET`.
> Un vrai E2E réseau (desktop ↔ serveur déployé) reste à faire en environnement intégré.

## 4. Décisions — toutes tranchées (2026-06-08)

- [x] **Origine `companyId`** : `app_metadata.company_id` (canonique, cf `CompanyEntity`) ;
      400 si absent ; super-admins refusés (§1.4).
- [x] **Sécurité `/tokens/me`** : JWT sync accepté sans `aal2` (route self-only) +
      compensations (revoke, refus super-admin, rate-limit) (§1.5).
- [x] **TTL `prism_`** : 90 j (défaut), re-génération auto transparente (§1.5).
- [x] **Fusion de conflit** : hors périmètre natif v1 → garder local / prendre distant.
- [x] **URL prod** : `https://prisme-one-config.eliottmeunier.com` (cf DEPLOYMENT.md),
      surchargeable via `CONFIG_API_URL`.

> Reste à provisionner (ops, hors code) : variable d'env partagée `SAAS_JWT_SECRET`
> (= `JWT_SECRET` du site SaaS) côté `prisme-one-configuration`.
