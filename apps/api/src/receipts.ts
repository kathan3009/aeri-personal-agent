import { createHash } from 'node:crypto';
import { normalizeName, type Cart } from '@personal-agent/core';
import { registrableDomain } from './merchant-auth.js';

export type ReceiptMessage = { subject?: string; preview?: string; text?: string; sender?: string | string[] };
export type ReceiptCandidate = {
  cartId: string; merchant: string; orderReference: string; senderDomain: string; matchedItemIds: string[];
  evidence: 'receipt_candidate'; deliveryClaim: 'delivered' | 'order_confirmation' | 'unknown';
};

/** Exact domains only: similar names, display names and unlisted subdomains do not establish a retailer match.
 * A provider webhook signature authenticates transport, not the email's merchant. Every match needs user review.
 */
export const trustedReceiptDomains: Record<string, string[]> = {
  target: ['target.com'], walmart: ['walmart.com'], amazon: ['amazon.com'],
  'whole foods': ['wholefoodsmarket.com'], 'whole foods market': ['wholefoodsmarket.com'],
  doordash: ['doordash.com'], instacart: ['instacart.com'],
};

export function senderDomain(sender?: string | string[]): string | null {
  if (Array.isArray(sender)) { if (sender.length !== 1) return null; sender = sender[0]; }
  if (!sender || sender.length > 500 || /[\r\n]/.test(sender)) return null;
  const mailbox = sender.trim().match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? sender.trim();
  const match = mailbox.match(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i);
  if (!match || match[1].includes('..') || !match[1].includes('.')) return null;
  return match[1].toLowerCase();
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanText = (value?: string) => (value ?? '').slice(0, 100_000).replace(/<[^>]*>/g, ' ');
const hasExactReference = (text: string, reference: string) => {
  if (!reference || reference.length > 200 || /[\r\n]/.test(reference)) return false;
  // Numbers that only appear as a price/address do not count. The stored reference must follow an order label.
  const label = '(?:order(?:\\s+(?:number|no\\.?|id|reference))?|confirmation(?:\\s+(?:number|no\\.?))?)';
  return new RegExp(`(?:^|[^a-z0-9])${label}\\s*(?:[:#-]\\s*)?${escapeRegex(reference)}(?![a-z0-9_-])`, 'i').test(text);
};
const containsProduct = (text: string, title: string) => {
  const tokens = (value: string) => normalizeName(value).split(/\s+/).map(normalizeName).join(' ');
  const product = tokens(title);
  return !!product && ` ${tokens(text)} `.includes(` ${product} `);
};
const deliveryClaim = (subject?: string): ReceiptCandidate['deliveryClaim'] => {
  const text = cleanText(subject).toLowerCase();
  if (/\b(not|failed|attempt|will|expected|scheduled|out for|tomorrow)\b/.test(text)) return 'unknown';
  if (/\b(delivered|delivery complete)\b/.test(text)) return 'delivered';
  if (/\b(order confirmed|order confirmation|thanks for your order|thank you for your order)\b/.test(text)) return 'order_confirmation';
  return 'unknown';
};

/** Returns review evidence only. Email text cannot place orders or modify inventory, preferences or cart lines. */
export function matchReceipt(message: ReceiptMessage, carts: Cart[], domains: Record<string, string[]> = trustedReceiptDomains): ReceiptCandidate | null {
  const domain = senderDomain(message.sender);
  if (!domain) return null;
  const text = [message.subject, message.preview, message.text].map(cleanText).join('\n');
  const matches: ReceiptCandidate[] = [];
  for (const cart of carts) {
    if (cart.status !== 'ordered' || !cart.orderReference || !cart.merchant || !cart.items.length) continue;
    // The store's own site (from the cart's product links) plus the known sender domains for well-known stores.
    const own = [cart.checkoutUrl, ...cart.items.map(item => item.offer?.url ?? item.retailerProductUrl)].flatMap(url => { try { return url ? [registrableDomain(new URL(url).hostname)] : []; } catch { return []; } });
    const allowed = [...(Object.entries(domains).find(([merchant]) => normalizeName(merchant) === normalizeName(cart.merchant!))?.[1] ?? []), ...own].filter(Boolean).map(entry => entry!.toLowerCase());
    if (!allowed.includes(domain) || !hasExactReference(text, cart.orderReference)) continue;
    // Use frozen product titles when available; generic name overlap can falsely match a different order.
    const matched = cart.items.filter(item => containsProduct(text, item.offer?.title ?? item.name));
    if (matched.length !== cart.items.length) continue;
    matches.push({ cartId: cart.id, merchant: cart.merchant, orderReference: cart.orderReference, senderDomain: domain, matchedItemIds: matched.map(item => item.id), evidence: 'receipt_candidate', deliveryClaim: deliveryClaim(message.subject) });
  }
  // A shared reference or duplicate cart remains ambiguous, even with familiar subject text.
  return matches.length === 1 ? matches[0] : null;
}

/** The store keeps this claim independently of retained UI events, so replay survives event pruning/restarts. */
export function receiptDedupKey(eventId: string, messageId?: string): string {
  const identity = messageId?.trim() || eventId.trim();
  if (!identity || identity.length > 1000) throw new Error('A receipt event or message identifier is required');
  return createHash('sha256').update(messageId?.trim() ? `message:${identity}` : `event:${identity}`).digest('hex');
}
