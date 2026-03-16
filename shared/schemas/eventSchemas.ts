import { z } from "zod";

// -----------------------------------------------------------------------
// Primitive schemas (reused across event payloads)
// -----------------------------------------------------------------------

const OrderItemSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive(),
});

// -----------------------------------------------------------------------
// Event payload schemas
// -----------------------------------------------------------------------

export const OrderCreatedPayloadSchema = z.object({
  customerId: z.string().min(1),
  customerEmail: z.string().email(),
  items: z.array(OrderItemSchema).min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
});

export const PaymentCompletedPayloadSchema = z.object({
  paymentId: z.string().uuid(),
  amount: z.number().positive(),
  currency: z.string().length(3),
  customerEmail: z.string().email(),
  items: z.array(OrderItemSchema).min(1),
});

export const PaymentFailedPayloadSchema = z.object({
  paymentId: z.string().uuid(),
  amount: z.number(),
  currency: z.string(),
  customerEmail: z.string().email(),
  reason: z.string(),
});

export const InventoryReservedPayloadSchema = z.object({
  customerId: z.string().optional(),
  customerEmail: z.string().email(),
  items: z.array(OrderItemSchema),
  amount: z.number(),
  currency: z.string(),
});

export const InventoryFailedPayloadSchema = z.object({
  customerEmail: z.string().email().optional(),
  items: z.array(OrderItemSchema).optional(),
  reason: z.string(),
});

export const PaymentRefundRequestedPayloadSchema = z.object({
  amount: z.number(),
  currency: z.string(),
  customerEmail: z.string().email().optional(),
  reason: z.string(),
});

export const PaymentRefundedPayloadSchema = z.object({
  paymentId: z.string().uuid(),
  amount: z.number(),
  currency: z.string(),
  customerEmail: z.string().email().optional(),
  reason: z.string(),
  refundedAt: z.string().datetime(),
});

export const OrderConfirmedPayloadSchema = z.object({
  customerEmail: z.string().email(),
  items: z.array(OrderItemSchema),
  amount: z.number(),
  currency: z.string(),
});

export const OrderCancelledPayloadSchema = z.object({
  reason: z.string(),
  customerEmail: z.string().email().optional(),
  timeoutAfterMs: z.number().optional(),
  refundAmount: z.number().optional(),
});

// -----------------------------------------------------------------------
// Base event envelope schema
// -----------------------------------------------------------------------

export const BaseEventSchema = z.object({
  eventId: z.string().uuid(),
  sagaId: z.string().uuid(),
  correlationId: z.string().uuid().nullable().optional(),
  orderId: z.string().uuid(),
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()),
});

// -----------------------------------------------------------------------
// Typed-payload event schemas (envelope + specific payload)
// -----------------------------------------------------------------------

export const OrderCreatedEventSchema = BaseEventSchema.extend({
  payload: OrderCreatedPayloadSchema,
});

export const PaymentCompletedEventSchema = BaseEventSchema.extend({
  payload: PaymentCompletedPayloadSchema,
});

export const PaymentFailedEventSchema = BaseEventSchema.extend({
  payload: PaymentFailedPayloadSchema,
});

export const InventoryReservedEventSchema = BaseEventSchema.extend({
  payload: InventoryReservedPayloadSchema,
});

export const InventoryFailedEventSchema = BaseEventSchema.extend({
  payload: InventoryFailedPayloadSchema,
});

export const PaymentRefundRequestedEventSchema = BaseEventSchema.extend({
  payload: PaymentRefundRequestedPayloadSchema,
});

export const PaymentRefundedEventSchema = BaseEventSchema.extend({
  payload: PaymentRefundedPayloadSchema,
});

export const OrderConfirmedEventSchema = BaseEventSchema.extend({
  payload: OrderConfirmedPayloadSchema,
});

export const OrderCancelledEventSchema = BaseEventSchema.extend({
  payload: OrderCancelledPayloadSchema,
});

// -----------------------------------------------------------------------
// TS inferred types
// -----------------------------------------------------------------------

export type OrderItem = z.infer<typeof OrderItemSchema>;
export type BaseEvent = z.infer<typeof BaseEventSchema>;

export type OrderCreatedPayload = z.infer<typeof OrderCreatedPayloadSchema>;
export type PaymentCompletedPayload = z.infer<typeof PaymentCompletedPayloadSchema>;
export type PaymentFailedPayload = z.infer<typeof PaymentFailedPayloadSchema>;
export type InventoryReservedPayload = z.infer<typeof InventoryReservedPayloadSchema>;
export type InventoryFailedPayload = z.infer<typeof InventoryFailedPayloadSchema>;
export type PaymentRefundRequestedPayload = z.infer<typeof PaymentRefundRequestedPayloadSchema>;
export type PaymentRefundedPayload = z.infer<typeof PaymentRefundedPayloadSchema>;
export type OrderConfirmedPayload = z.infer<typeof OrderConfirmedPayloadSchema>;
export type OrderCancelledPayload = z.infer<typeof OrderCancelledPayloadSchema>;

export type OrderCreatedEvent = z.infer<typeof OrderCreatedEventSchema>;
export type PaymentCompletedEvent = z.infer<typeof PaymentCompletedEventSchema>;
export type PaymentFailedEvent = z.infer<typeof PaymentFailedEventSchema>;
export type InventoryReservedEvent = z.infer<typeof InventoryReservedEventSchema>;
export type InventoryFailedEvent = z.infer<typeof InventoryFailedEventSchema>;
export type PaymentRefundRequestedEvent = z.infer<typeof PaymentRefundRequestedEventSchema>;
export type PaymentRefundedEvent = z.infer<typeof PaymentRefundedEventSchema>;
export type OrderConfirmedEvent = z.infer<typeof OrderConfirmedEventSchema>;
export type OrderCancelledEvent = z.infer<typeof OrderCancelledEventSchema>;

export type SagaEvent =
  | OrderCreatedEvent
  | PaymentCompletedEvent
  | PaymentFailedEvent
  | InventoryReservedEvent
  | InventoryFailedEvent
  | PaymentRefundRequestedEvent
  | PaymentRefundedEvent
  | OrderConfirmedEvent
  | OrderCancelledEvent;
