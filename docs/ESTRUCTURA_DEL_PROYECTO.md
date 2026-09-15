# Estructura del proyecto

Este documento describe cómo está organizado TelegramTrader y dónde debe hacerse cada tipo de cambio. El proyecto es un monolito modular local: Node.js coordina la lógica y un Expert Advisor conecta esa lógica con MetaTrader 5.

## Árbol principal

```text
TelegramTrader/
├── src/
│   ├── agents/          # Adaptadores de IA y contrato de salida estructurada
│   ├── api/             # API Fastify, validación HTTP y página de ajustes
│   ├── application/     # Puertos que desacoplan dominio y persistencia
│   ├── config/          # Lectura, validación y actualización de .env
│   ├── database/        # Esquema SQLite, apertura y migraciones
│   ├── logging/         # Eventos estructurados y redacción de datos
│   ├── models/          # Tipos de señales, trades y contexto MT5
│   ├── repositories/    # Implementación SQLite de los puertos
│   ├── risk/            # Cálculo de volumen y límites de riesgo
│   ├── scripts/         # Login y diagnóstico de Telegram
│   ├── services/        # Orquestación del ciclo de una señal
│   ├── shared/          # Decimales, procesos, seguridad y utilidades
│   ├── signals/         # Validación técnica de señales
│   ├── telegram/        # Adaptador MTProto basado en mtcute
│   └── main.ts          # Composición y arranque de la aplicación
├── mt5/
│   ├── Experts/         # Expert Advisor TelegramTraderEA.mq5
│   └── Include/         # Cliente HTTP y parser JSON para MQL5
├── tests/               # Pruebas unitarias, integración y migraciones
├── docs/
│   ├── adr/             # Decisiones de arquitectura
│   ├── architecture.md
│   ├── ESTRUCTURA_DEL_PROYECTO.md
│   └── CONTEXTO_FUNCIONAL_ACTUAL.md
├── .env.example         # Plantilla sin secretos
├── package.json         # Scripts y dependencias Node.js
├── tsconfig.json        # Compilación TypeScript
└── vitest.config.ts     # Configuración de pruebas
```

## Responsabilidad de los módulos

### Entrada de Telegram

`src/telegram/mtcute-telegram-adapter.ts` mantiene la sesión MTProto, filtra por la lista de chats permitidos y entrega mensajes normalizados a `SignalPipeline`. Los scripts de `src/scripts/` sirven para autenticar la sesión, resolver teléfonos y listar chats.

### Interpretación mediante IA

`src/agents/analyzer-factory.ts` selecciona Claude, Codex, Kiro o un comando explícito. `prompt-builder.ts` y `signal-schema.ts` definen el contrato estricto. El prefiltro heurístico evita invocar IA para mensajes evidentemente ajenos a trading. El adaptador de Codex reintenta una vez, después de 15 segundos, cuando el primer análisis falla.

La IA no decide si una orden se ejecuta. Solamente produce símbolo, dirección, zona de entrada, SL, lista de TP, lote o porcentaje de riesgo y confianza.

### Pipeline y riesgo

`src/services/signal-pipeline.ts` coordina la recepción, análisis, validación, deduplicación y puesta en cola. Una señal con varios TP genera una pierna por objetivo, todas relacionadas mediante `signal_group_id`.

`src/signals/signal-validator.ts` valida coherencia BUY/SELL y niveles. `src/risk/risk-engine.ts` calcula el volumen usando balance y especificaciones publicadas por MT5, y respeta máximos de lote, riesgo, operaciones diarias, pérdida diaria y simultaneidad.

### Persistencia

`src/database/schema.ts` contiene el esquema SQLite. `src/repositories/sqlite-repositories.ts` implementa acceso transaccional, cambios de estado, idempotencia, asignaciones y cierres.

Las tablas principales son:

- `signals`: mensaje original, interpretación, grupo y estado.
- `trades`: asignación de una señal a un cliente MT5.
- `executions`: resultado y tickets reportados por el EA.
- `positions`: posición lógica, niveles y P&L.
- `mt5_clients`: último contexto de cada terminal.
- `mt5_deal_history`: ledger exacto importado desde el broker.
- `signal_status_history`, `system_events` y `errors`: auditoría.
- `idempotency_records`: respuestas estables para reintentos HTTP.

### API local

`src/api/server.ts` expone salud, ajustes, contexto MT5, cola de trades, confirmación, cancelación, ejecución, actualización de SL, cierre y consultas. `src/api/schemas.ts` valida los cuerpos con Zod. Todas las rutas operativas requieren API key y los POST requieren clave de idempotencia.

### Expert Advisor

`mt5/Experts/TelegramTraderEA.mq5` mantiene hasta 10 slots. Publica contexto, recibe asignaciones, coloca órdenes de mercado o pendientes, monitorea fills y cierres, mueve piernas hermanas a breakeven y recupera operaciones al reiniciar.

En cuentas hedging, la posición de un fill se resuelve desde `DEAL_POSITION_ID`; no se selecciona una posición arbitraria por símbolo. Si el broker llenó la orden pero el ticket no puede resolverse, se reporta `UNKNOWN` y la orden no se repite.

## Dependencias entre capas

```text
Telegram adapter ─┐
                  v
              SignalPipeline -> SignalValidator
                  |            -> RiskEngine
                  v
          Application ports
                  |
                  v
        SQLite repositories <-> Fastify API <-> MT5 EA <-> Broker
```

Los módulos de dominio no importan SQLite, Fastify ni MQL5. Esa separación permite sustituir la persistencia o el transporte sin reescribir las reglas de validación y riesgo.

## Artefactos que no deben versionarse

- `.env` y cualquier secreto.
- Sesiones de Telegram.
- Bases SQLite, archivos WAL y SHM.
- `node_modules`, `dist`, logs y binarios compilados del EA.
- Copias de respaldo e historiales exportados del broker.

## Validación recomendada

```powershell
npm ci
npm audit
npm run typecheck
npm test
npm run build
```

El EA debe compilarse adicionalmente con MetaEditor y validarse en una cuenta demo antes de cualquier despliegue LIVE.
