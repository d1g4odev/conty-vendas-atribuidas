# Vendas atribuídas ao criador

API que recebe webhooks de pedidos e de reembolsos no estilo Shopify, atribui cada venda a no máximo um criador e mantém o saldo de cada criador num ledger append-only. Reembolso e cancelamento estornam valores com lançamentos negativos e nada é apagado.

Stack: Node 22+, TypeScript estrito, Fastify 5, Zod 4, Vitest.

## Como rodar

```bash
npm install
npm start
npm test
npm run typecheck
```

O servidor sobe em `:3000` (use `PORT` para trocar) e carrega os criadores de `data/creators.json` (use `CREATORS_FILE` para outro arquivo):

```json
[{ "id": "ana", "name": "Ana Souza", "coupons": ["ANA10"], "utmCampaigns": ["ana-souza"] }]
```

## Endpoints

| Método | Rota | O que faz |
| --- | --- | --- |
| POST | `/webhooks/orders` | Recebe ou atualiza um pedido |
| POST | `/webhooks/refunds` | Recebe um reembolso (200 se foi aplicado, 202 se ficou pendente) |
| GET | `/orders/:id` | Pedido com atribuição, reembolsos, histórico e lançamentos no ledger |
| GET | `/creators` | Criadores cadastrados |
| GET | `/creators/:id/sales` | Saldo líquido, vendas, reembolsos, pedidos e ledger do criador |
| GET | `/refunds/pending` | Reembolsos que chegaram antes do pedido |

Valores entram como decimal (`"199.90"` ou `199.9`, no máximo 2 casas) e saem em centavos inteiros (`totalCents`). Os headers `X-Shopify-Webhook-Id` ou `X-Webhook-Id`, quando enviados, deduplicam a entrega.

### Exemplo

Um reembolso que chega antes do pedido fica pendente:

```bash
curl -XPOST localhost:3000/webhooks/refunds -H 'content-type: application/json' \
  -d '{"id":"r-1","order_id":"1001","amount":"30.00"}'
```

```json
{"outcome":"pending","refund":{"id":"r-1","orderId":"1001","requestedCents":3000,"appliedCents":null,"state":"pending","receivedAt":"...","appliedAt":null}}
```

Depois chega o pedido, com cupom de uma criadora e UTM de outro criador:

```bash
curl -XPOST localhost:3000/webhooks/orders -H 'content-type: application/json' -H 'x-shopify-webhook-id: wh-1' \
  -d '{"id":"1001","total":"100.00","coupon":"ANA10","utm":{"campaign":"bruno-lima"},"status":"paid"}'
```

```json
{
  "outcome": "created",
  "order": {
    "id": "1001", "totalCents": 10000, "status": "paid",
    "attribution": { "creatorId": "ana", "source": "coupon", "matched": "ana10" },
    "refundedCents": 3000, "netCents": 7000,
    "refunds": [{ "id": "r-1", "requestedCents": 3000, "appliedCents": 3000, "state": "applied" }],
    "history": [{ "event": "order_received" }, { "event": "refund_applied" }],
    "ledger": [
      { "seq": 1, "creatorId": "ana", "deltaCents": 10000, "reason": "order_paid" },
      { "seq": 2, "creatorId": "ana", "deltaCents": -3000, "reason": "refund_applied", "ref": "r-1" }
    ]
  }
}
```

`GET /creators/ana/sales` retorna `{"netCents":7000,"salesCents":10000,"refundedCents":3000,"orders":[...],"ledger":[...]}`.

Erros: `400 invalid_payload` (lista as issues do Zod), `404 not_found`, `409 conflict`.

## Regras e decisões

- **Desempate cupom × UTM** fica em um lugar só, `resolveAttribution` em `src/attribution.ts`, e é testado em `test/attribution.test.ts`. O cupom vence, porque é uma ação explícita do comprador no checkout, enquanto a UTM pode ter vindo de um clique antigo. Um cupom que não pertence a nenhum criador não bloqueia a UTM. A UTM considerada é só `utm_campaign`. A comparação ignora maiúsculas/minúsculas e espaços nas pontas.
- **No máximo um criador**: a atribuição é calculada na primeira vez que o pedido chega e fica congelada. Um cupom ou campanha cadastrado para dois criadores derruba a inicialização. Se um webhook posterior mudar `total`, `coupon` ou `utm`, a API responde 409 e a atribuição não muda.
- **Status**: `pending`, `paid` e `cancelled`, e só andam para frente. Uma regressão que chega fora de ordem (por exemplo, `paid` depois de `cancelled`) é ignorada e fica registrada no histórico como `status_regression_ignored`.
- **Ledger**: o líquido do pedido é `total - reembolsado` se ele estiver `paid`, e 0 se não estiver. Cada evento que altera esse valor gera um lançamento com o delta, então a soma do ledger do criador é sempre igual à soma dos líquidos dos pedidos dele. Reembolso total ou cancelamento zera o saldo com um lançamento negativo; o pedido, a atribuição, os reembolsos e o histórico continuam lá.
- **Reembolsos parciais e repetidos**: cada `id` de reembolso diferente acumula. O mesmo `id` com os mesmos dados é `duplicate` e não altera nada. O mesmo `id` com outro valor ou outro pedido retorna 409.
- **Soma dos reembolsos nunca passa da venda**: o valor aplicado é `min(pedido, total - já reembolsado)`. O excedente não é rejeitado, porque um reembolso pendente só pode ser checado quando o pedido chega e não daria mais para devolver erro à Shopify. O registro guarda `requestedCents` e `appliedCents`, e o histórico marca `capped: true`.
- **Reembolso antes do pedido**: fica `pending` e é aplicado, na ordem de chegada, assim que o pedido chega, já com o teto aplicado.
- **Webhook duplicado**: há duas camadas. O id da entrega no header encerra o processamento logo no início. Sem header, o processamento continua idempotente: o mesmo pedido com o mesmo status volta como `unchanged`, e o mesmo reembolso volta como `duplicate`.
- **Relógio injetável** (`Clock` / `ManualClock`), usado nos timestamps do histórico e do ledger e nos testes.

## O que ficou de fora

- Persistência: o estado fica em memória, atrás do `SalesService`. Para produção, o próximo passo seria Postgres com transação por webhook e unique constraints em `order.id`, `refund.id` e `delivery_id`.
- Verificação HMAC (`X-Shopify-Hmac-Sha256`) do corpo bruto.
- Moeda: tudo é tratado como uma moeda só.
- Edição de pedido (mudança de total depois de criado) e os status financeiros completos da Shopify (`authorized`, `partially_paid`, `voided`...). Hoje os reembolsos vêm só do webhook de refunds; o status `refunded` do pedido não é aceito, para não contar o mesmo valor duas vezes.
- Cálculo de comissão (percentual por criador); a API entrega a base líquida.

## Uso de IA

Código gerado com assistência de IA (Claude Code). O que a IA fez:

- Modelou o domínio (atribuição, ledger por delta, reembolsos pendentes e com teto, máquina de status).
- Escreveu a API Fastify, a validação com Zod e o relógio injetável.
- Escreveu os testes (unitários do domínio e de API via `fastify.inject`).
- Escreveu este README.

Revisao humana: [Rodrigo completa]
