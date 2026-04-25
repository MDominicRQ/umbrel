# CSP Reverse Proxy Fix - Análisis y Plan de Acción

## Estado Actual del Problema

### Síntomas
- La página carga pero muestra "Something went wrong"
- El frontend hace requests a `http://os.dominic.pw/trpc/...` (HTTP, no HTTPS)
- La CSP del backend es `connect-src 'self' https://apps.umbrel.com` - NO incluye el dominio externo
- La CSP no está leyendo `X-Forwarded-Host` como esperado

### Causa Raíz Identificada

El flujo actual:
1. El upstream umbrel se descarga como archivos TypeScript
2. Se eliminan los .js del upstream
3. Se copian nuestros archivos .ts (incluyendo server/index.ts con el fix de CSP)
4. Se copia TODO a /opt/umbreld en el stage de build
5. `npm clean-install && npm link` solo prepara dependencias, NO compila TypeScript
6. El servidor se ejecuta con `tsx` (TypeScript interpreter)

**El problema:** Aunque nuestros archivos .ts están siendo copiados, hay un problema de cómo se están aplicando los cambios o cómo Node.js/tsx los está cargando.

## Soluciones Posibles

### Opción 1: Verificar que nuestros archivos .ts se estén usando correctamente

Nuestro server/index.ts tiene la función `connectSrc` que lee headers. Pero necesito verificar que:
1. El archivo se está copiando correctamente
2. No hay un problema de importación/resolución de módulos
3. El archivo es válido TypeScript

### Opción 2: CSP más agresiva - incluir todos los orígenes posibles

Modificar la CSP para que sea más permisiva y cubra todos los casos:
- Incluir `http://*` y `https://*` para cubrir cualquier dominio
- Usar `upgradeInsecureRequests: true` para forzar upgrades HTTP->HTTPS

### Opción 3: Solución alternativa - Traefik Labels

Si el problema es que Traefik no está enviando los headers correctos, podemos:
- Configurar Traefik para reenviar headers正确
- O usar labels en el contenedor para indicar el dominio

### Opción 4: Compilar TypeScript en el Dockerfile

Agregar un paso de compilación para generar .js desde nuestros .ts, asegurando que el códigofix se ejecute correctamente.

## Plan de Implementación

### Fase 1: Verificación (crítico)
- [ ] Verificar que el archivo source/modules/server/index.ts tenga el fix de CSP
- [ ] Verificar que no haya errores de sintaxis en los archivos .ts
- [ ] Verificar que el Dockerfile esté copiando los archivos correctamente

### Fase 2: Fix Inmediato (si Fase 1 no resuelve)
- [ ] Modificar la CSP para ser más agresiva y cubrir más casos
- [ ] Incluir `upgradeInsecureRequests: true` para forzar HTTPS
- [ ] Incluir orígenes HTTP y HTTPS wildcard para el dominio del proxy

### Fase 3: Verificación de Traefik (si aún falla)
- [ ] Verificar que Traefik envíe los headers X-Forwarded-Host y X-Forwarded-Proto
- [ ] Ajustar configuración de Traefik si es necesario

### Fase 4: Compilación (último recurso)
- [ ] Agregar paso de compilación TypeScript en el Dockerfile
- [ ] Generar .js desde nuestros .ts para garantizar ejecución

## Archivo Crítico a Modificar

`services/umbrel/deploy` en Dokploy probablemente tiene configuración de Traefik. Necesitamos asegurarnos de que:
1. Los headers `X-Forwarded-Host` y `X-Forwarded-Proto` se envíen
2. El dominio configurado en Traefik coincida con lo que esperamos

## Nota de Seguridad

La CSP que estamos implementando es para permitir conexiones desde el dominio externo al backend. Esto es seguro porque:
1. Solo permitimos el dominio que viene en X-Forwarded-Host (set by proxy, not client)
2. Agregamos 'self' primero para mantener seguridad original
3. Solo affecta a connect-src, no a otros vectores de ataque