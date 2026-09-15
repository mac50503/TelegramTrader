# Contexto funcional actual

Estado documentado: septiembre de 2026.

## Propósito

TelegramTrader convierte mensajes de grupos autorizados de Telegram en operaciones administradas por MetaTrader 5. El sistema conserva el mensaje original, la interpretación de IA, las decisiones de validación y riesgo, los tickets del broker y el resultado económico.

La aplicación está diseñada para ejecutarse localmente. Node.js escucha Telegram y expone una API REST en loopback; el EA de MT5 consume esa API. SQLite es la fuente de verdad de señales, asignaciones y auditoría.

## Flujo vigente

1. `MtcuteTelegramAdapter` recibe un mensaje de un chat incluido en la whitelist.
2. La identidad Telegram impide importar dos veces el mismo mensaje.
3. El prefiltro descarta conversación que claramente no contiene una señal.
4. Un proveedor CLI interpreta el texto con un esquema JSON estricto.
5. `SignalValidator` comprueba símbolo, dirección, zona de entrada, SL y TP.
6. Cada TP genera una pierna dentro del mismo grupo de señal.
7. El contexto reciente de MT5 aporta balance y especificaciones reales del símbolo.
8. `RiskEngine` calcula o valida el volumen y aplica los límites configurados.
9. Las piernas aprobadas pasan a `QUEUED` y se asignan transaccionalmente al EA.
10. El EA confirma la asignación y ejecuta a mercado o crea una orden pendiente.
11. El EA reporta fill, rechazo o resultado incierto con claves idempotentes.
12. Al cerrar la posición, reporta precio, beneficio, comisión, swap y motivo.

## Señales con múltiples objetivos

El analizador devuelve `takeProfits` ordenados desde el más cercano hasta el más lejano. El servidor crea una señal por objetivo y conserva:

- `signal_group_id`: identidad común del grupo.
- `leg_index`: índice empezando en cero.
- `leg_count`: cantidad total de piernas.

El servidor puede entregar varias piernas al mismo cliente hasta `MAX_SIMULTANEOUS_TRADES`. El EA dispone de 10 slots. Cuando la primera pierna cierra por TP, intenta mover el SL de las piernas restantes a su precio real de apertura y notifica `/sl-updated`.

## Ejecución y tickets MT5

Dentro de la zona de entrada, el EA envía una orden de mercado con SL y TP. Fuera de la zona, determina si corresponde `BUY_LIMIT`, `BUY_STOP`, `SELL_LIMIT` o `SELL_STOP`, y le asigna una expiración.

Cada orden usa el comentario estable `TT-<signalId>`. Para un fill de mercado, el EA consulta el deal devuelto por MT5 y obtiene `DEAL_POSITION_ID`. Esta asociación es necesaria en cuentas hedging, donde varias posiciones pueden compartir símbolo.

Un fill confirmado nunca se repite. Si no puede resolverse el ticket de posición, se reporta:

```text
result=UNKNOWN
retcode=POSITION_NOT_RESOLVED
```

El servidor lleva la señal a reconciliación en lugar de devolverla a la cola.

## Recuperación después de reinicios

El EA consulta `/api/trades/current` al iniciar. Puede reconstruir hasta 10 asignaciones y buscar cada orden o posición por comentario y ticket. El contexto de cuenta se publica al arrancar y cada 60 segundos usando reloj local, incluso cuando el mercado no produce ticks.

SQLite conserva el estado del servidor. Reiniciar Node no elimina señales ni trades. Los requests repetidos con la misma clave de idempotencia reciben la respuesta original.

## Cancelación administrativa

`POST /api/trades/:signalId/cancel` permite cancelar un trade únicamente en estado `ASSIGNED` o `SUBMITTED` y solamente para el cliente propietario. El trade queda `CANCELED` y la señal se marca `REJECTED` con código `ADMIN_CANCELED`.

Una posición ya llena no se puede cancelar mediante esta ruta. Debe cerrarse en MT5 y reportarse por el flujo normal o reconciliarse administrativamente.

## Historial y balance

`positions` representa una posición lógica por trade y se usa para consultas normales. `mt5_deal_history` conserva el ledger inmutable del broker, con una fila por deal y tickets de orden y posición. Este ledger permite reconstruir el resultado exacto incluso cuando un error histórico produjo varias posiciones para una misma señal.

Los cierres marcados `ADMIN_REVIEW` no se incluyen en el cálculo automático de pérdida diaria. Esto evita que un ajuste manual de reconciliación bloquee nuevas señales como si fuera una pérdida operativa confirmada.

## Modos de operación

### SIMULATION

- No envía órdenes al broker.
- Usa bid/ask de MT5 como fill simulado.
- Detecta SL y TP con precios publicados por la terminal.
- Sigue usando persistencia, auditoría e idempotencia reales.

### LIVE

Requiere simultáneamente:

- `TRADING_MODE=LIVE`.
- `LIVE_TRADING_CONFIRM=I_UNDERSTAND_LIVE_TRADING`.
- Cuenta permitida cuando `MT5_ALLOWED_ACCOUNT_IDS` está configurado.
- `EnableLiveTrading=true` en el EA.
- AutoTrading habilitado en MT5.

`RequireDemoAccountForLive=true` mantiene el EA restringido a cuentas demo. La configuración de Node y la del EA deben coincidir.

## Estados relevantes

Señal:

```text
RECEIVED -> ANALYZING -> VALIDATED -> QUEUED -> ASSIGNED -> EXECUTED -> CLOSED
                |            |          |          |
                |            |          |          +-> RECONCILIATION_REQUIRED
                |            |          +-> REJECTED (cancelación administrativa)
                |            +-> EXPIRED / REJECTED
                +-> IGNORED / ERROR
```

Trade:

```text
ASSIGNED -> SUBMITTED -> FILLED -> CLOSED
    |           |          |
    +-----------+          +-> UNKNOWN
         |
         +-> CANCELED / REJECTED
```

## Seguridad vigente

- API ligada a `127.0.0.1` por defecto.
- API key comparada en tiempo constante.
- Rate limiting y esquemas Zod estrictos.
- Claves de idempotencia en operaciones mutables.
- Sesiones, secretos y base de datos excluidos de Git.
- Los analizadores reciben texto no confiable sin autoridad sobre el broker.
- Codex se ejecuta con sandbox de solo lectura y reintenta una vez tras 15 segundos.
- LIVE permanece protegido por confirmación explícita y controles del EA.
- La versión alta vulnerable de `fast-uri` fue reemplazada por versiones corregidas.

## Límites y trabajo pendiente conocido

- `mt5_deal_history` define el almacenamiento, pero la importación exacta desde MT5 sigue siendo una tarea de reconciliación; no existe todavía un sincronizador permanente dentro del servidor.
- La migración automatizada desde el esquema histórico con índice único de Telegram todavía tiene una prueba fallida y debe corregirse antes de depender de esa ruta en instalaciones antiguas.
- Vitest mantiene alertas moderadas de desarrollo cuya corrección disponible requiere una actualización mayor.
- La API no debe exponerse fuera del equipo sin TLS, filtrado de red y rotación de secretos.
- Toda modificación del EA debe compilarse y probarse primero en demo.

## Fuentes de verdad

- Comportamiento del servidor: `src/`.
- Comportamiento del EA: `mt5/Experts/TelegramTraderEA.mq5`.
- Esquema persistente: `src/database/schema.ts`.
- Configuración admitida: `.env.example` y `src/config/config.ts`.
- Contrato y pruebas: `tests/`.

Este documento describe capacidades del código. El modo de cuenta, balance, posiciones abiertas y procesos en ejecución son estado operativo y deben consultarse directamente antes de operar.
