# ADR-001: cliente MTProto para Node.js

- Estado: aceptado
- Fecha: 2026-08-14

## Contexto

TelegramTrader necesita escuchar chats y canales con una cuenta de usuario, sin depender inicialmente de un bot. El adaptador debe funcionar con Node.js/TypeScript y mantenerse reemplazable.

## Opciones

### GramJS

Biblioteca conocida y TypeScript, pero su repositorio fue archivado el 14 de julio de 2026. No se selecciona para un proyecto nuevo.

### TDLib

Cliente oficial, estable y resistente a fallos de red. Exige biblioteca nativa C++, compilación/distribución y un binding o interfaz JSON para Node. Se conserva como alternativa futura si se necesita máxima robustez.

### mtcute

Biblioteca MTProto moderna, TypeScript nativo, paquete Node dedicado, tipos estrictos, actividad reciente y almacenamiento/transporte reemplazables.

### Otras bibliotecas TypeScript

Teleproto y MTKruto son alternativas viables, pero para este MVP tienen menor madurez o adopción observable que mtcute.

## Decisión

Usar `@mtcute/node` detrás del puerto `TelegramAdapter`.

La lógica de aplicación solo recibe `TelegramMessage`; no importa clases de mtcute. Una migración a TDLib sustituiría el adaptador sin cambiar análisis, validación, riesgo, persistencia o API.

## Consecuencias

- La sesión SQLite interna de mtcute se almacena fuera del repositorio.
- La sesión se considera un secreto crítico.
- Se fija la versión mediante `package-lock.json`.
- Las actualizaciones de mtcute se revisarán antes de aplicarlas.
- Telegram sigue siendo únicamente una fuente de eventos.
