import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { CreatorDirectory, type Creator } from "./attribution.ts";
import { systemClock, type Clock } from "./clock.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { SalesService } from "./sales.ts";
import { orderWebhookSchema, refundWebhookSchema } from "./schemas.ts";

export interface AppOptions {
  creators: readonly Creator[];
  clock?: Clock;
  logger?: boolean;
}

const DELIVERY_HEADERS = ["x-shopify-webhook-id", "x-webhook-id"] as const;

const deliveryId = (request: FastifyRequest): string | undefined => {
  for (const header of DELIVERY_HEADERS) {
    const value = request.headers[header];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

export function buildApp({ creators, clock = systemClock, logger = false }: AppOptions): FastifyInstance {
  const directory = new CreatorDirectory(creators);
  const sales = new SalesService(directory, clock);
  const app = Fastify({ logger });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "invalid_payload", issues: error.issues });
    }
    if (error instanceof ConflictError) {
      return reply.status(409).send({ error: "conflict", message: error.message, details: error.details });
    }
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: "not_found", message: error.message });
    }
    const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
    if (status >= 500) app.log.error(error);
    const message = status >= 500 || !(error instanceof Error) ? "Internal server error" : error.message;
    return reply.status(status).send({ error: "request_failed", message });
  });

  app.post("/webhooks/orders", async (request) => {
    return sales.receiveOrder(orderWebhookSchema.parse(request.body), deliveryId(request));
  });

  app.post("/webhooks/refunds", async (request, reply) => {
    const result = sales.receiveRefund(refundWebhookSchema.parse(request.body), deliveryId(request));
    return reply.status(result.outcome === "pending" ? 202 : 200).send(result);
  });

  app.get<{ Params: { id: string } }>("/orders/:id", async (request) => sales.getOrder(request.params.id));

  app.get("/refunds/pending", async () => ({ refunds: sales.pendingRefunds() }));

  app.get("/creators", async () => ({ creators: directory.list() }));

  app.get<{ Params: { id: string } }>("/creators/:id/sales", async (request) => sales.creatorSummary(request.params.id));

  return app;
}
