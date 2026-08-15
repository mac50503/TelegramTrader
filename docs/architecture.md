# Arquitectura y decisiones operativas

TelegramTrader es un monolito modular local. Los módulos se comunican mediante interfaces y objetos de dominio; SQLite es la única fuente de verdad del MVP.

## Consistencia

- La ingestión usa la identidad única de Telegram.
- La asignación se realiza dentro de una transacción.
- Un trade tiene exactamente una señal.
- Los POST mutables requieren clave idempotente.
- Una ejecución incierta nunca se reencola automáticamente.
- Los cambios de estado se auditan.

## Disponibilidad

- Reiniciar Node conserva señales y trades.
- Reiniciar el EA permite consultar `/current`.
- Los contextos MT5 caducan para impedir cálculos con balance o tick values obsoletos.
- Los fallos de red se reintentan desde el cliente usando la misma clave idempotente.

## Migración

Los repositorios SQLite implementan puertos de aplicación. PostgreSQL deberá implementar los mismos puertos y conservar las restricciones únicas. Una cola SQS futura transportará IDs, no señales completas; la base seguirá siendo la autoridad de idempotencia y estado.
