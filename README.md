# TelegramTrader

MVP local para convertir mensajes de Telegram recibidos mediante una cuenta de usuario/MTProto en señales estructuradas, validarlas, aplicar límites de riesgo y entregarlas por REST a un Expert Advisor de MetaTrader 5.

El proyecto inicia siempre en `SIMULATION`. El agente de IA interpreta texto, pero no tiene acceso al broker ni autoridad para ejecutar operaciones.

## Estado y alcance

- Servidor central Node.js + TypeScript.
- Telegram mediante `@mtcute/node` y whitelist de chats.
- Agente CLI aislado mediante `stdin`/`stdout` JSON.
- SQLite transaccional; no se usan archivos planos como cola o transporte.
- Validación técnica y RiskEngine independiente.
- API REST autenticada e idempotente.
- EA MQL5 con una sola operación activa.
- Ejecución simulada con precios recibidos por MT5.
- LIVE deshabilitado por defecto y protegido por confirmaciones múltiples.

El MVP ejecuta órdenes de mercado. `entry` es el precio de referencia de la señal; el precio real puede diferir. Las órdenes limit/stop quedan fuera de esta versión.

## Arquitectura

```text
Telegram
  -> MtcuteTelegramAdapter (MTProto)
  -> SignalPipeline
  -> CliSignalAnalyzer
  -> SignalValidator
  -> RiskEngine
  -> SQLite / Trade Queue
  -> Fastify REST API
  -> TelegramTraderEA.mq5
  -> MetaTrader 5 / Broker
```

Responsabilidades:

- Telegram: informa que llegó un mensaje.
- AI CLI: propone una interpretación estructurada.
- Validation: comprueba que la señal sea técnicamente coherente.
- RiskEngine: calcula o autoriza el volumen.
- Node.js: persiste, audita y asigna señales.
- EA: ejecuta o simula y reporta el resultado.
- Broker: confirma o rechaza la operación real.

## Requisitos

- Node.js 22 o superior.
- MetaTrader 5 para utilizar el EA.
- Cuenta de Telegram y credenciales de aplicación de <https://my.telegram.org/apps>.
- Un agente CLI capaz de leer JSON por `stdin` y devolver exclusivamente JSON por `stdout`.

## Instalación local

```powershell
npm install
Copy-Item .env.example .env
npm run typecheck
npm test
npm run build
```

Edite `.env` antes de iniciar:

```powershell
npm run dev
```

La API escuchará por defecto únicamente en `127.0.0.1:3000`.

## Configuración

Consulte [.env.example](./.env.example). Los valores más importantes son:

| Variable | Descripción |
|---|---|
| `TELEGRAM_ENABLED` | Activa el listener MTProto |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | Credenciales de aplicación Telegram |
| `TELEGRAM_SESSION_PATH` | Ubicación local de la sesión, fuera de Git |
| `TELEGRAM_ALLOWED_CHATS` | IDs permitidos separados por coma; vacío acepta ninguno |
| `AI_AGENT_ENABLED` | Activa el proceso CLI |
| `AI_AGENT_COMMAND` | Ruta del ejecutable, sin texto Telegram concatenado |
| `AI_AGENT_ARGS_JSON` | Argumentos como arreglo JSON |
| `DATABASE_URL` | Ruta SQLite o `:memory:` para pruebas |
| `API_KEY` | Secreto compartido entre Node y el EA |
| `TRADING_MODE` | `SIMULATION` o `LIVE` |
| `MAX_*` | Límites de lotaje, riesgo, trades y pérdida diaria |

No guarde `.env`, sesiones Telegram, bases de datos ni logs en Git.

## Telegram MTProto

La decisión está documentada en [ADR-001](./docs/adr/001-mtproto-client.md). Se eligió `mtcute` porque GramJS fue archivado en julio de 2026 y TDLib añade una dependencia nativa considerable al MVP.

1. Cree una aplicación en <https://my.telegram.org/apps>.
2. Configure `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` y `TELEGRAM_SESSION_PATH`.
3. Ejecute la autenticación interactiva:

```powershell
npm run telegram:login
```

4. Obtenga los IDs numéricos de los chats deseados y configúrelos en `TELEGRAM_ALLOWED_CHATS`.
5. Active `TELEGRAM_ENABLED=true`.

La sesión MTProto permite acceder a la cuenta y debe tratarse como un secreto crítico. Use una cuenta dedicada y 2FA.

## Agente CLI

Node envía por `stdin` un objeto JSON con instrucciones, esquema, `signalId` y mensaje. El CLI debe devolver un solo objeto JSON:

```json
{
  "isSignal": true,
  "symbol": "XAUUSD",
  "side": "BUY",
  "entry": 3345,
  "stopLoss": 3335,
  "takeProfit": 3370,
  "riskPercentage": 1,
  "confidence": 0.98
}
```

Para texto no ejecutable:

```json
{ "isSignal": false }
```

Controles del adaptador:

- `spawn` sin shell.
- El texto llega por `stdin`; nunca forma parte del comando.
- Timeout y límite de salida.
- JSON Schema estricto y rechazo de campos desconocidos.
- El subproceso solo recibe `PATH`, no los secretos del servidor.
- Una salida inválida produce `ERROR`; nunca genera una operación.

`AI_AGENT_COMMAND` debe ser el ejecutable. Configure argumentos en `AI_AGENT_ARGS_JSON`, por ejemplo `[
"path/al/script.js"]`. No use una cadena de shell con pipes o redirecciones.

## Señales y estados

Flujo normal:

```text
RECEIVED -> ANALYZING -> VALIDATED -> QUEUED -> ASSIGNED -> EXECUTED -> CLOSED
                         |            |          |
                         +->REJECTED  +->EXPIRED +->RECONCILIATION_REQUIRED

ANALYZING -> IGNORED
ANALYZING -> ERROR
```

Cada mensaje conserva texto original, JSON del agente, resultado de validación, timestamps, estado y motivo de rechazo. La tabla `signal_status_history` conserva las transiciones.

La unicidad `(source, telegramChatId, telegramMessageId)` bloquea duplicados exactos. Una huella semántica temporal bloquea reenvíos equivalentes.

## RiskEngine

Soporta:

- Lotaje fijo.
- Porcentaje del balance.

Para porcentaje:

```text
distanceTicks = abs(entry - stopLoss) / tickSize
lossPerLot = distanceTicks * tickValueLoss
riskAmount = balance * riskPercentage / 100
volume = floorToVolumeStep(riskAmount / lossPerLot)
```

El EA publica mediante `POST /api/mt5/context` balance, moneda y propiedades reales del símbolo: tick size/value, contract size y volume min/max/step. Si faltan o están vencidas, la señal no se asigna. No se aplica una fórmula Forex genérica a oro, cripto o índices.

## API REST

Salvo `/api/health`, envíe:

```text
X-API-Key: <secret>
X-Request-ID: <unique request ID>       # POST
Idempotency-Key: <stable retry key>     # POST
```

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/health` | Salud y modo |
| POST | `/api/mt5/context` | Contexto de cuenta/símbolo |
| GET | `/api/trades/next?clientId=...` | Reserva atómica de siguiente señal |
| GET | `/api/trades/current?clientId=...` | Recuperación de asignación activa |
| POST | `/api/trades/:signalId/assigned` | Acuse de asignación |
| POST | `/api/trades/:signalId/execution` | Fill, simulación, rechazo o resultado incierto |
| POST | `/api/trades/:signalId/closed` | Cierre y P&L |
| GET | `/api/trades/:signalId` | Estado del trade |
| GET | `/api/signals` | Lista paginada y filtrable |
| GET | `/api/signals/:signalId` | Detalle de señal |

Respuesta sin señal:

```json
{ "hasSignal": false }
```

Respuesta con asignación:

```json
{
  "hasSignal": true,
  "signal": {
    "signalId": "SIG-20260814-000001",
    "tradeId": "TRD-...",
    "assignmentToken": "...",
    "mode": "SIMULATION",
    "symbol": "XAUUSD",
    "side": "BUY",
    "entry": "3345",
    "stopLoss": "3335",
    "takeProfit": "3370",
    "volume": "0.1",
    "expiresAt": "2026-08-14T22:00:00.000Z"
  }
}
```

## Idempotencia y fallos de red

`GET /next` cambia `QUEUED` a `ASSIGNED` dentro de la misma transacción que crea el trade. Dos clientes nunca reciben la misma señal.

Los POST almacenan su primera respuesta por scope e `Idempotency-Key`. Repetir el mismo request devuelve la respuesta previa. Los identificadores de ejecución, request y tickets MT5 también son únicos.

Si se pierde la respuesta después de enviar una orden, el EA no debe enviar otra. Primero debe revisar posiciones/deals y consultar `/current`. Un resultado ambiguo se reporta como `UNKNOWN`/`RECONCILIATION_REQUIRED`; nunca vuelve automáticamente a la cola.

## Expert Advisor MT5

Archivos:

- `mt5/Experts/TelegramTraderEA.mq5`
- `mt5/Include/TelegramTraderHttp.mqh`
- `mt5/Include/TelegramTraderJson.mqh`

Copie los archivos a las carpetas equivalentes dentro de `MQL5`, abra MetaEditor y compile el EA.

En MetaTrader 5:

1. Abra `Tools > Options > Expert Advisors`.
2. Active WebRequest para URLs permitidas.
3. Añada `http://127.0.0.1:3000` exactamente.
4. Adjunte el EA al gráfico del símbolo del broker.
5. Configure `ApiKey`, `ClientId`, `CanonicalSymbol` y, si difiere, `BrokerSymbol`.
6. Mantenga `EnableLiveTrading=false`.

`WebRequest` es síncrono y MetaTrader no lo permite en Strategy Tester. Las pruebas REST usan un cliente MT5 falso; el EA debe probarse en terminal demo.

Estados internos:

```text
IDLE -> CHECKING_SIGNAL -> EXECUTING -> POSITION_OPEN -> REPORTING_CLOSE -> IDLE
                              |                                  |
                              +------------- ERROR --------------+
```

Mientras está en `POSITION_OPEN` no llama a `/api/trades/next`. En el MVP, si existe cualquier posición en la cuenta, tampoco solicita otra señal.

## Simulation Mode

Configuración inicial:

```dotenv
TRADING_MODE=SIMULATION
```

El EA:

- No llama `CTrade.Buy` ni `CTrade.Sell`.
- Usa bid/ask de MT5 como fill simulado.
- Mantiene una posición virtual.
- Detecta SL/TP con precios de MT5.
- Reporta `SIMULATED_EXECUTION` y el cierre.

Ninguna prueba automatizada ejecuta órdenes reales.

## Live Mode

No active LIVE hasta validar el flujo completo en una cuenta demo.

Node requiere:

```dotenv
TRADING_MODE=LIVE
LIVE_TRADING_CONFIRM=I_UNDERSTAND_LIVE_TRADING
MT5_ALLOWED_ACCOUNT_IDS=123456
```

El EA requiere además `EnableLiveTrading=true` y AutoTrading habilitado. Si Node y EA no coinciden en el modo, la operación se rechaza.

Una request enviada no se considera éxito. El EA comprueba `ResultRetcode`, deal y posición antes de reportar `FILLED`.

## Base de datos

SQLite se crea automáticamente en `DATABASE_URL`, con:

- Foreign keys.
- WAL para base persistente.
- Busy timeout.
- Migraciones versionadas.
- Tablas `signals`, `signal_status_history`, `trades`, `executions`, `positions`, `mt5_clients`, `errors`, `system_events` e `idempotency_records`.

La lógica de negocio accede mediante repositorios; cambiar a PostgreSQL no requiere modificar casos de uso.

## Pruebas

```powershell
npm run typecheck
npm test
npm run build
```

Las pruebas cubren JSON del agente, BUY/SELL, SL/TP inválidos, símbolo, expiración, riesgo, límites, duplicados, cola, asignación única, API key, ejecución simulada, cierre e idempotencia.

## Seguridad

- API enlazada a loopback por defecto.
- API key comparada en tiempo constante.
- Rate limiting.
- Requests y JSON estrictamente validados.
- Whitelist Telegram con aceptación por defecto vacía.
- Sesión y secretos fuera de Git.
- Redacción de secretos en logs.
- Texto Telegram nunca se ejecuta ni se concatena al shell.
- LIVE bloqueado por defecto.
- Cuenta LIVE opcionalmente restringida por ID.
- Una sola operación activa en servidor y EA.

Para exponer la API fuera del equipo local es obligatorio añadir TLS, rotación de secretos y controles de red.

## Preparación para AWS

El dominio no importa SDKs de AWS. Sustituciones previstas:

| Local | AWS futuro |
|---|---|
| SQLite repository | PostgreSQL/RDS repository |
| Cola en DB | SQS FIFO + idempotencia en DB |
| Variables seguras | Secrets Manager |
| Pino stdout | CloudWatch |
| Fastify local | API Gateway + Lambda/ECS |
| Worker local | Lambda/SQS o ECS |

El listener MTProto necesita conexión y sesión persistentes, por lo que encaja mejor en ECS/Fargate que en Lambda. API y workers sin estado sí pueden migrarse a Lambda.

## Solución de problemas

### MT5 devuelve error 4014 o WebRequest falla

Añada `http://127.0.0.1:3000` a la lista de URLs permitidas en las opciones de Expert Advisors. La lista no puede configurarse desde código.

### `/next` responde `MT5_CONTEXT_REQUIRED`

El EA aún no publicó contexto o su timestamp superó `MT5_CONTEXT_MAX_AGE_SECONDS`. Verifique conexión, API key y símbolo.

### La señal queda en `VALIDATED`

No hay contexto MT5 reciente o aún no se conoce el símbolo canónico. Al recibir un contexto válido, Node vuelve a procesar estas señales.

### Telegram no recibe mensajes

Compruebe `TELEGRAM_ENABLED`, la sesión y que el ID exacto esté en `TELEGRAM_ALLOWED_CHATS`. Una whitelist vacía bloquea todos los chats.

### El agente devuelve `AI_INVALID_JSON`

El CLI escribió texto adicional, Markdown o JSON que no cumple el esquema. Debe emitir únicamente un objeto JSON por `stdout`.

### El EA no pide otra señal

Es intencional si existe una posición, asignación o ejecución incierta. Resuelva primero el trade activo; no cambie manualmente una señal a `QUEUED`.
