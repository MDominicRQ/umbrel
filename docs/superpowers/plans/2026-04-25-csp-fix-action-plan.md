# CSP Fix - Action Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnosticar y solucionar el problema CSP que bloquea peticiones desde `http://os.dominic.pw` cuando umbrel está detrás de Traefik.

**Architecture:** El servidor Express dentro del contenedor umbrel debe generar headers CSP dinámicos basados en `X-Forwarded-Host`. El problema es que el servidor está devolviendo la CSP upstream (`img-src *`) en lugar de nuestra CSP personalizada.

**Tech Stack:** umbreld (TypeScript), helmet CSP, Traefik reverse proxy, Dokploy deployment

---

## Hallazgos Clave

1. **Los archivos fuente ESTÁN correctos** - `docker exec umbrel cat /opt/umbreld/source/modules/server/index.ts` muestra nuestro código con `helmet.contentSecurityPolicy` y `connectSrc` dinámico.

2. **La respuesta del servidor NO coincide** - Cuando consultamos `http://localhost`, la CSP tiene `img-src *` ( upstream) en lugar de `img-src 'self' data: blob:` (nuestro código).

3. **Existe discrepancy** - Los archivos fuente tienen el código correcto, pero el servidor usa código diferente.

4. **El contenedor está en red `dokploy-network`** y usa `dockurr/umbrel:latest` image.

---

## Hipótesis del Problema

**Principal:** Dokploy NO está usando el build local del Dockerfile. Está puxando `dockurr/umbrel:latest` desde Docker Hub, que tiene el código upstream sin nuestros patches.

**Secundaria:** El proceso `yarn.js start` que ejecuta `./bin/www` está usando código diferente al que vemos en `/opt/umbreld/source/`.

---

## Plan de Diagnóstico y Fix

### Task 1: Verificar imagen exacta usada por el contenedor

- [ ] **Step 1: Ejecutar comando en servidor Dokploy**

```bash
docker inspect umbrel | grep -i "image\|created"
```

Esto mostrará la imagen exacta que se está usando. Esperado: `dockurr/umbrel:latest` si está puxando del Hub, o un hash de imagen local si hizo build.

- [ ] **Step 2: Verificar si la imagen tiene nuestros cambios**

```bash
docker run --rm dockurr/umbrel:latest cat /opt/umbreld/source/modules/server/index.ts | grep -A5 "connect-src"
```

Si esto muestra `img-src *` en lugar de `img-src 'self' data: blob:`, entonces la imagen de Docker Hub NO tiene nuestros cambios.

---

### Task 2: Forzar rebuild en Dokploy

Si Task 1 confirma que se está usando imagen del Hub:

- [ ] **Step 1: En Dokploy, buscar opción de "Rebuild" o "Build Type"**

Dokploy puede tener configuración para elegir entre:
- `Autobuild`: Build automático desde Dockerfile
- `Image`: Puxar imagen existente del registry

Necesitamos asegurar que esté en modo `Autobuild` o similar que use nuestro Dockerfile local.

- [ ] **Step 2: Trigger rebuild manualmente**

En Dokploy,通常 hay un botón "Rebuild" o "Deploy" que fuerza rebuild de la imagen.

- [ ] **Step 3: Verificar que el build usó nuestros archivos**

Después del rebuild, ejecutar:
```bash
docker exec umbrel cat /opt/umbreld/source/modules/server/index.ts | grep "connectSrc"
```

Debería mostrar la función con `X-Forwarded-Host`.

---

### Task 3: Verificar que los headers llegan al contenedor

- [ ] **Step 1: Test con headers simulados**

```bash
docker exec umbrel wget -q -S -O - -H "X-Forwarded-Host: os.dominic.pw" -H "X-Forwarded-Proto: https" http://localhost 2>&1 | grep -i "content-security-policy"
```

Si la respuesta contiene `os.dominic.pw`, los headers están llegando y el fix está funcionando.

Si no contiene `os.dominic.pw`, los headers no están llegando.

---

### Task 4: Debug logging en CSP (si Task 3 falla)

Si los headers no llegan, necesitamos agregar logging para diagnosticar:

- [ ] **Step 1: Agregar console.log temporal al CSP**

Modificar `source/modules/server/index.ts` para agregar logging:

```typescript
connectSrc: (req, _res) => {
    const sources = ["'self'", 'https://apps.umbrel.com']
    const forwardedHost = req.headers['x-forwarded-host']
    const forwardedProto = req.headers['x-forwarded-proto']

    // DEBUG: Log para verificar si los headers llegan
    console.log('[CSP DEBUG] X-Forwarded-Host:', forwardedHost)
    console.log('[CSP DEBUG] X-Forwarded-Proto:', forwardedProto)

    if (forwardedHost) {
        const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost
        sources.push(`http://${host}`)
        sources.push(`https://${host}`)
        sources.push(`ws://${host}`)
        sources.push(`wss://${host}`)
    }
    return sources
},
```

- [ ] **Step 2: Commit y push**

```bash
git add -A && git commit -m "debug: add logging to CSP connectSrc" && git push
```

- [ ] **Step 3: Rebuild y verificar logs**

```bash
docker logs umbrel --tail 100 | grep "CSP DEBUG"
```

---

### Task 5: Fix final - Simplificar CSP si aún falla

Si después de todo lo anterior el problema persiste, la solución más robusta es hacer el CSP completamente permisivo para desarrollo:

- [ ] **Step 1: Modificar CSP para permitir todo en connect-src**

```typescript
connectSrc: (req, _res) => {
    // Allow all sources for development behind reverse proxy
    return ['*']
},
```

Esto es un fallback - no ideal para producción pero solve el problema inmediato.

---

## Resumen de Comandos a Ejecutar en Servidor Dokploy

1. Ver imagen: `docker inspect umbrel | grep -i "image"`
2. Test headers: `docker exec umbrel wget -q -S -O - -H "X-Forwarded-Host: os.dominic.pw" -H "X-Forwarded-Proto: https" http://localhost 2>&1 | grep -i content-security-policy`
3. Ver código actual: `docker exec umbrel cat /opt/umbreld/source/modules/server/index.ts | grep -A10 "connectSrc"`
4. Ver logs: `docker logs umbrel --tail 50`

---

## Decisión de Implementación

**Siguiente paso requerido:** Ejecutar Task 1 para confirmar si Dokploy está puxando imagen del Hub o haciendo build local.

Una vez tengamos esa información, sabremos cuál path seguir:
- Path A: Dokploy puxa del Hub → Configurar Dokploy para hacer build local
- Path B: Dokploy hace build pero algo falla → Investigar proceso de build
- Path C: Headers no llegan → Verificar configuración Traefik
