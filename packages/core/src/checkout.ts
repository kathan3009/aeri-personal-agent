import { z } from 'zod';
import type { Cart } from './index';
import { normalizeName } from './names';

const cents = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });
export const checkoutLineSchema = z.object({
  itemId: z.string().min(1), title: z.string().min(1), productUrl: z.string().url().optional(),
  variant: z.string().optional(), size: z.string().optional(), quantity: z.number().int().positive(),
  unitPriceCents: cents, lineTotalCents: cents,
});
/** A complete final merchant summary. Unknown charges cannot be represented as a final snapshot. */
export const checkoutSnapshotSchema = z.object({
  id: z.string().min(1), cartId: z.string().min(1), merchant: z.string().min(1), checkoutUrl: z.string().url(),
  capturedAt: timestamp, source: z.enum(['mock', 'merchant']), currency: z.literal('USD'),
  fulfillment: z.enum(['delivery', 'pickup']), locationKey: z.string().min(1),
  lines: z.array(checkoutLineSchema).min(1), subtotalCents: cents, feesCents: cents,
  taxCents: cents, tipCents: cents, discountCents: cents, totalCents: cents,
}).superRefine((snapshot, context) => {
  if (new Set(snapshot.lines.map(line => line.itemId)).size !== snapshot.lines.length) context.addIssue({ code: 'custom', message: 'Checkout contains duplicate item IDs', path: ['lines'] });
  if (snapshot.lines.some(line => line.quantity * line.unitPriceCents !== line.lineTotalCents)) context.addIssue({ code: 'custom', message: 'Checkout line totals do not match their quantities and prices', path: ['lines'] });
  if (snapshot.lines.reduce((sum, line) => sum + line.lineTotalCents, 0) !== snapshot.subtotalCents) context.addIssue({ code: 'custom', message: 'Checkout subtotal does not match its lines', path: ['subtotalCents'] });
  if (snapshot.subtotalCents + snapshot.feesCents + snapshot.taxCents + snapshot.tipCents - snapshot.discountCents !== snapshot.totalCents) context.addIssue({ code: 'custom', message: 'Checkout total does not match its final charges', path: ['totalCents'] });
});
export type CheckoutSnapshot = z.infer<typeof checkoutSnapshotSchema>;

export const purchaseApprovalSchema = z.object({
  id: z.string().min(1), cartId: z.string().min(1), snapshotId: z.string().min(1), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  maximumTotalCents: cents, createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(['active', 'used', 'invalidated']), usedAt: timestamp.optional(), invalidatedAt: timestamp.optional(), invalidationReason: z.string().optional(),
}).superRefine((approval, context) => {
  if (Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)) context.addIssue({ code: 'custom', message: 'Purchase approval must expire after it is created', path: ['expiresAt'] });
  if (approval.status === 'used' && !approval.usedAt) context.addIssue({ code: 'custom', message: 'Used approval needs a use timestamp', path: ['usedAt'] });
  if (approval.status === 'invalidated' && (!approval.invalidatedAt || !approval.invalidationReason)) context.addIssue({ code: 'custom', message: 'Invalidated approval needs a timestamp and reason' });
});
export type PurchaseApproval = z.infer<typeof purchaseApprovalSchema>;
export const CHECKOUT_SNAPSHOT_TTL_MS = 5 * 60_000;

/** Hash parsed values, with stable key/line order. Capture metadata changes also require fresh approval. */
export async function checkoutSnapshotHash(input: CheckoutSnapshot): Promise<string> {
  const snapshot = checkoutSnapshotSchema.parse(input);
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : value;
  const canonical = { ...snapshot, lines: [...snapshot.lines].sort((a, b) => a.itemId.localeCompare(b.itemId)) };
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(canonical))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const validNow = (now: string) => { const time = Date.parse(now); if (!Number.isFinite(time)) throw new Error('A valid current time is required'); return time; };
const freshSnapshot = (snapshot: CheckoutSnapshot, now: string) => { const age = validNow(now) - Date.parse(snapshot.capturedAt); return age >= 0 && age < CHECKOUT_SNAPSHOT_TTL_MS; };

/** Match the final product selection against the frozen offers the person approved. */
export function matchCartCheckout(cart: Cart, input: CheckoutSnapshot): { matches: boolean; discrepancies: string[] } {
  const parsed = checkoutSnapshotSchema.safeParse(input);
  if (!parsed.success) return { matches: false, discrepancies: ['The merchant checkout summary is incomplete or inconsistent.'] };
  const snapshot = parsed.data, discrepancies: string[] = [];
  if (!['approved', 'checkout_ready'].includes(cart.status)) discrepancies.push('The shopping cart has not been approved.');
  if (snapshot.cartId !== cart.id) discrepancies.push('The checkout belongs to a different cart.');
  if (!cart.merchant || normalizeName(snapshot.merchant) !== normalizeName(cart.merchant)) discrepancies.push('The merchant differs from the approved cart.');
  if (snapshot.lines.length !== cart.items.length) discrepancies.push('The number of checkout items differs from the approved cart.');
  for (const item of cart.items) {
    const line = snapshot.lines.find(entry => entry.itemId === item.id);
    if (!line) { discrepancies.push(`${item.name} is missing from checkout.`); continue; }
    if (!item.offer) { discrepancies.push(`${item.name} has no frozen approved product offer.`); continue; }
    if (!item.offer.verified || item.offer.priceCents == null) discrepancies.push(`${item.name} has no verified approved price.`);
    if (normalizeName(line.title) !== normalizeName(item.offer.title)) discrepancies.push(`${item.name} is a different product or variant.`);
    if (line.quantity !== item.offer.packs) discrepancies.push(`${item.name} has a different quantity.`);
    // The frozen offer records the price for all packs, rather than one unit.
    if (line.lineTotalCents !== item.offer.priceCents) discrepancies.push(`${item.name} has a different price.`);
    if (item.offer.url && line.productUrl !== item.offer.url) discrepancies.push(`${item.name} has a different or unverified product URL.`);
    if (normalizeName(item.offer.merchant) !== normalizeName(snapshot.merchant)) discrepancies.push(`${item.name} belongs to a different merchant.`);
  }
  if (snapshot.lines.some(line => !cart.items.some(item => item.id === line.itemId))) discrepancies.push('Checkout includes items that were not approved.');
  return { matches: !discrepancies.length, discrepancies };
}

export async function createPurchaseApproval(snapshot: CheckoutSnapshot, options: { id: string; now: string; maximumTotalCents: number; expiresAt?: string }): Promise<PurchaseApproval> {
  const final = checkoutSnapshotSchema.parse(snapshot);
  if (!freshSnapshot(final, options.now)) throw new Error('Read a fresh final checkout before purchase approval');
  if (options.maximumTotalCents < final.totalCents) throw new Error('Final checkout exceeds the approved maximum total');
  const latestExpiry = Date.parse(final.capturedAt) + CHECKOUT_SNAPSHOT_TTL_MS;
  const expiry = options.expiresAt ? Date.parse(options.expiresAt) : latestExpiry;
  if (!Number.isFinite(expiry) || expiry > latestExpiry) throw new Error('Approval cannot outlive its checkout snapshot');
  return purchaseApprovalSchema.parse({ id: options.id, cartId: final.cartId, snapshotId: final.id, snapshotHash: await checkoutSnapshotHash(final), maximumTotalCents: options.maximumTotalCents, createdAt: options.now, expiresAt: new Date(expiry).toISOString(), status: 'active' });
}

export async function validatePurchaseApproval(input: PurchaseApproval, snapshot: CheckoutSnapshot, now: string): Promise<{ valid: boolean; reason?: string }> {
  const parsed = purchaseApprovalSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: 'Purchase approval is invalid' };
  const approval = parsed.data;
  if (approval.status !== 'active') return { valid: false, reason: `Purchase approval is ${approval.status}` };
  if (validNow(now) < Date.parse(approval.createdAt) || validNow(now) >= Date.parse(approval.expiresAt)) return { valid: false, reason: 'Purchase approval has expired or is not active yet' };
  const final = checkoutSnapshotSchema.safeParse(snapshot);
  if (!final.success) return { valid: false, reason: 'Final checkout is incomplete or inconsistent' };
  if (!freshSnapshot(final.data, now)) return { valid: false, reason: 'Final checkout has expired' };
  if (approval.cartId !== snapshot.cartId || approval.snapshotId !== snapshot.id) return { valid: false, reason: 'Purchase approval belongs to a different cart or checkout' };
  if (snapshot.totalCents > approval.maximumTotalCents) return { valid: false, reason: 'Final checkout exceeds the approved maximum total' };
  if (await checkoutSnapshotHash(snapshot) !== approval.snapshotHash) return { valid: false, reason: 'Final checkout changed; review and approve it again' };
  return { valid: true };
}

export async function invalidateChangedApproval(approval: PurchaseApproval, snapshot: CheckoutSnapshot, now: string): Promise<PurchaseApproval> {
  if (approval.status !== 'active') return approval;
  const result = await validatePurchaseApproval(approval, snapshot, now);
  return result.valid ? approval : { ...approval, status: 'invalidated', invalidatedAt: now, invalidationReason: result.reason! };
}

/** Test-only boundary: the atomic claim must persist consumption before the mock merchant is called.
 * A failed/ambiguous submission stays consumed, preventing a second attempt that could duplicate an order.
 */
export async function controlledMockSubmit<T>(options: {
  approval: PurchaseApproval; snapshot: CheckoutSnapshot; now: string;
  claim: (expected: PurchaseApproval, consumed: PurchaseApproval) => Promise<boolean>;
  submit: (snapshot: CheckoutSnapshot) => Promise<T>;
}): Promise<{ approval: PurchaseApproval; result: T }> {
  // Clone and parse before asynchronous work: callers cannot mutate the approved snapshot during hashing/claim.
  const snapshot = checkoutSnapshotSchema.parse(options.snapshot), approval = purchaseApprovalSchema.parse(options.approval);
  if (snapshot.source !== 'mock') throw new Error('Controlled submission is supported only for a mock merchant');
  const validation = await validatePurchaseApproval(approval, snapshot, options.now);
  if (!validation.valid) throw new Error(validation.reason);
  const consumed: PurchaseApproval = { ...approval, status: 'used', usedAt: options.now };
  if (!await options.claim(approval, consumed)) throw new Error('Purchase approval was already consumed or changed');
  return { approval: consumed, result: await options.submit(snapshot) };
}
