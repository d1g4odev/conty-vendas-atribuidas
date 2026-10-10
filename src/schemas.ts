import { z } from "zod";
import { toCents } from "./money.ts";
import { ORDER_STATUSES, type OrderInput, type RefundInput } from "./sales.ts";

const id = z.union([z.string().trim().min(1), z.number().int().nonnegative()]).transform(String);

const amount = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const cents = toCents(value);
  if (cents === null) {
    ctx.addIssue({ code: "custom", message: "must be a non-negative decimal with at most 2 decimal places" });
    return z.NEVER;
  }
  return cents;
});

const optionalText = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || undefined);

export const orderWebhookSchema = z
  .object({
    id,
    total: amount,
    coupon: z
      .string()
      .nullish()
      .transform((value) => value?.trim() || null),
    utm: z
      .object({
        source: optionalText,
        medium: optionalText,
        campaign: optionalText,
        content: optionalText,
        term: optionalText,
      })
      .nullish()
      .transform((value) => value ?? {}),
    status: z.enum(ORDER_STATUSES),
  })
  .transform(
    (payload): OrderInput => ({
      id: payload.id,
      totalCents: payload.total,
      coupon: payload.coupon,
      utm: payload.utm,
      status: payload.status,
    }),
  );

export const refundWebhookSchema = z
  .object({
    id,
    order_id: id,
    amount: amount.refine((cents) => cents > 0, "must be greater than zero"),
  })
  .transform(
    (payload): RefundInput => ({
      id: payload.id,
      orderId: payload.order_id,
      amountCents: payload.amount,
    }),
  );

export const creatorsSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    coupons: z.array(z.string()).default([]),
    utmCampaigns: z.array(z.string()).default([]),
  }),
);
