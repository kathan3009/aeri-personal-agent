import { randomUUID } from 'node:crypto';
import { AgentMailClient } from 'agentmail';
import type { Cart } from '@personal-agent/core';
import { registrableDomain } from './merchant-auth.js';
import { scrub } from './providers.js';
import { matchReceipt, receiptDedupKey, senderDomain } from './receipts.js';
import type { Mailbox, User } from './accounts.js';
import type { Store } from './store.js';

/**
 * Each person's own Aeri email address (an AgentMail inbox, created with one tap). They forward store emails to it
 * with a Gmail filter; Aeri reads them as untrusted evidence. Email never places orders or changes memory by itself:
 * it creates things to review. Aeri also sends sign-in codes from its own sending inbox.
 */
export type InboundEmail = { id: string; subject?: string; preview?: string; text?: string; sender?: string | string[]; receivedAt?: string };

const client = () => process.env.AGENTMAIL_API_KEY ? new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY, maxRetries: 1 }) : null;
export const mailboxConfigured = () => !!process.env.AGENTMAIL_API_KEY;

// Per inbox: when it was last read, the last error, and Gmail's forwarding confirmation code (memory only, a day).
const status = new Map<string, { checkedAt?: string; error?: string; forwardingCode?: { code: string; at: string } }>();
const statusOf = (inboxId: string) => { let entry = status.get(inboxId); if (!entry) { entry = {}; status.set(inboxId, entry); } return entry; };

/**
 * One tap in Settings: a private address for this person. The owner's address from before accounts existed is kept
 * (it's already in their Gmail forwarding); everyone else gets a new inbox that is theirs alone.
 */
export async function connectMailbox(user: Pick<User, 'id' | 'mailbox'> & { email?: string }): Promise<Mailbox> {
  if (user.mailbox) return user.mailbox;
  const mail = client();
  if (!mail) throw new Error('Email isn’t set up on this Aeri server yet.');
  const legacy = user.id === 'default';
  const wanted = legacy ? process.env.AGENTMAIL_INBOX_ID : undefined;
  const existing = wanted ? (await mail.inboxes.list({ limit: 100 })).inboxes.find(entry => entry.inboxId === wanted || entry.email === wanted) : undefined;
  // clientId makes creation idempotent: a retried tap returns the same inbox instead of making another.
  // A readable address (ana-aeri-3f9c@…) instead of a random word pair, so it's recognisable in a Gmail filter.
  const local = (user.email?.split('@')[0] ?? 'me').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'me';
  const inbox = existing ?? await mail.inboxes.create({ displayName: 'Aeri', clientId: legacy ? 'aeri-receipts' : `aeri-user-${user.id}`, ...(legacy ? {} : { username: `${local}-aeri-${randomUUID().slice(0, 4)}` }) }).catch(error => {
    // The email service's own plan limit, said plainly.
    if (/limit|quota|plan|exceed|403|402/i.test(`${(error as { statusCode?: number }).statusCode ?? ''} ${(error as Error).message}`)) throw new Error('Aeri can’t create more email addresses right now. Try again later.');
    throw error;
  });
  return { inboxId: inbox.inboxId, address: inbox.email, connectedAt: new Date().toISOString(), owned: !legacy };
}

/** Removes the person's Aeri address (only inboxes Aeri made for them; the owner's older address is just unlinked). */
export async function disconnectMailbox(mailbox: Mailbox) {
  status.delete(mailbox.inboxId);
  const mail = client();
  if (mail && mailbox.owned) await mail.inboxes.delete(mailbox.inboxId).catch(error => { if ((error as { statusCode?: number }).statusCode !== 404) throw error; });
}

export function mailboxStatus(user: Pick<User, 'mailbox'>) {
  const entry = user.mailbox ? status.get(user.mailbox.inboxId) : undefined;
  const code = entry?.forwardingCode && Date.now() - Date.parse(entry.forwardingCode.at) < 86_400_000 ? entry.forwardingCode.code : undefined;
  return { configured: mailboxConfigured(), connected: !!user.mailbox, address: user.mailbox?.address, checkedAt: entry?.checkedAt, error: entry?.error, gmailForwardingCode: code };
}

let sender: Promise<{ inboxId: string }> | null = null;
/** Aeri's own sending address for sign-in codes (AGENTMAIL_SENDER_INBOX_ID, or one Aeri creates once). */
const senderInbox = (mail: AgentMailClient) => sender ??= (async () => {
  const wanted = process.env.AGENTMAIL_SENDER_INBOX_ID;
  if (wanted) return { inboxId: wanted };
  // Try a recognisable sender name first; fall back to whatever address the email service picks.
  const username = process.env.AGENTMAIL_SENDER_USERNAME ?? 'aeri-sign-in';
  const inbox = await mail.inboxes.create({ displayName: 'Aeri', clientId: 'aeri-sender', username })
    .catch(() => mail.inboxes.create({ displayName: 'Aeri', clientId: 'aeri-sender' }));
  return { inboxId: inbox.inboxId };
})().catch(error => { sender = null; throw error; });

/** Emails a sign-in code. Returns false when email isn't set up (development prints the code instead). */
export async function sendSignInCode(email: string, code: string): Promise<boolean> {
  const mail = client();
  if (!mail) return false;
  const { inboxId } = await senderInbox(mail);
  await mail.inboxes.messages.send(inboxId, {
    to: [email], subject: `${code} is your Aeri code`,
    text: `Your Aeri sign-in code is ${code}.\n\nIt works once and expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
    html: `<p>Your Aeri sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works once and expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>`,
  });
  return true;
}

const orderNumber = (text: string) => text.match(/\b(?:order|confirmation)\s*(?:number|no\.?|#|id)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{4,30})\b/i)?.[1];
const cartDomains = (cart: Cart) => new Set([cart.checkoutUrl, ...cart.items.map(item => item.offer?.url ?? item.retailerProductUrl)]
  .flatMap(url => { try { return url ? [registrableDomain(new URL(url).hostname)] : []; } catch { return []; } }).filter((d): d is string => !!d));
const body = (email: InboundEmail) => [email.subject, email.preview, email.text].filter(Boolean).join('\n').slice(0, 100_000).replace(/<[^>]*>/g, ' ');

/** Records one inbound email. Returns false when this email was already handled (webhook and polling can overlap). */
export async function recordEmail(store: Store, email: InboundEmail, inboxId?: string): Promise<boolean> {
  if (!await store.claimReceipt(receiptDedupKey(email.id, email.id))) return false;
  const host = senderDomain(email.sender);
  const domain = host ? registrableDomain(host) : null;
  const text = body(email);
  if (host === 'google.com' || host?.endsWith('.google.com')) {
    const code = (email.subject ?? '').match(/\(#(\d{6,12})\)/)?.[1] ?? text.match(/confirmation code:\s*(\d{6,12})/i)?.[1];
    if (code && /forwarding/i.test(email.subject ?? '')) { if (inboxId) statusOf(inboxId).forwardingCode = { code, at: new Date().toISOString() }; return true; }
  }
  await store.update(state => {
    const at = new Date().toISOString();
    const receipt = matchReceipt({ subject: email.subject, preview: email.preview, text: email.text, sender: email.sender }, state.carts);
    // A store's confirmation email for a cart that is waiting for its order number: suggest it, never apply it.
    const reference = orderNumber(text);
    const waiting = reference && domain ? state.carts.filter(cart => cart.status === 'checkout_ready' && !cart.orderReference && cartDomains(cart).has(domain)) : [];
    if (waiting.length === 1 && /\d/.test(reference!)) {
      waiting[0].suggestedOrderReference = { reference: reference!, from: domain!, at };
      state.tasks.unshift({ id: randomUUID(), kind: 'receipt', title: 'Order number found', status: 'needs_review', createdAt: at, updatedAt: at, subjectId: waiting[0].id,
        detail: `${reference} in an email from ${domain}. Check it matches your order, then save it.` });
    } else if (receipt || /\b(order|delivered|delivery|shipped|receipt|refund|substitut)/i.test(email.subject ?? '')) {
      state.tasks.unshift({ id: randomUUID(), kind: 'receipt', title: 'Review email evidence', status: 'needs_review', createdAt: at, updatedAt: at, ...(receipt ? { subjectId: receipt.cartId } : {}),
        detail: receipt ? `Possible ${receipt.deliveryClaim.replace('_', ' ')} for ${receipt.merchant} order ${receipt.orderReference}. Check the items before marking anything delivered.` : `${(email.subject ?? 'An email').slice(0, 120)}${domain ? ` from ${domain}` : ''}. It doesn’t match an order yet.` });
    }
    state.events.push({ id: randomUUID(), type: 'email.received', at, data: { messageId: email.id, subject: (email.subject ?? '').slice(0, 240), sender: host, receipt, ...(waiting.length === 1 ? { suggestedOrderReference: reference } : {}) } });
  });
  return true;
}

/** Reads each person's new email every minute. No public web address or webhook is needed, so it works on a laptop. */
export function startMailboxPolling(inboxes: () => Promise<Array<{ inboxId: string; store: Store }>>, everyMs = 60_000) {
  const mail = client();
  if (!mail) return () => undefined;
  const since = new Map<string, Date>();
  let running = false;
  const pollOne = async (inboxId: string, store: Store) => {
    const entry = statusOf(inboxId);
    try {
      const from = since.get(inboxId) ?? new Date(Date.now() - 3 * 86_400_000);
      let pageToken: string | undefined; let newest = from;
      for (let page = 0; page < 3; page++) {
        const result = await mail.inboxes.messages.list(inboxId, { after: from, limit: 50, ...(pageToken ? { pageToken } : {}) });
        for (const item of result.messages) {
          if (item.timestamp > newest) newest = item.timestamp;
          const full = await mail.inboxes.messages.get(inboxId, item.messageId);
          await recordEmail(store, { id: item.messageId, subject: full.subject, preview: item.preview, text: full.extractedText ?? full.text ?? full.extractedHtml ?? full.html, sender: full.from, receivedAt: item.timestamp.toISOString() }, inboxId);
        }
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      }
      // Overlap by a minute; already-handled emails are skipped by their claim.
      since.set(inboxId, new Date(newest.getTime() - 60_000));
      entry.checkedAt = new Date().toISOString(); delete entry.error;
    } catch (error) { entry.error = scrub((error as Error).message).slice(0, 200); }
  };
  const poll = async () => {
    if (running) return;
    running = true;
    try { for (const { inboxId, store } of await inboxes().catch(() => [])) await pollOne(inboxId, store); }
    finally { running = false; }
  };
  const first = setTimeout(() => void poll(), 3_000);
  const timer = setInterval(() => void poll(), everyMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}

/**
 * A one-time sign-in code a store just emailed, for a sign-in the person started in Aeri. It is looked up on
 * request, only from this person's own inbox and that store's own domain and only after the sign-in began, and is never saved.
 */
export async function findSignInCode(inboxId: string | undefined, domain: string, since: Date): Promise<{ code: string; receivedAt: string } | null> {
  const mail = client();
  if (!mail || !inboxId) return null;
  const result = await mail.inboxes.messages.list(inboxId, { after: since, limit: 20 });
  const fromStore = result.messages.filter(item => { const host = senderDomain(item.from); return !!host && registrableDomain(host) === domain; })
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  for (const item of fromStore) {
    const full = await mail.inboxes.messages.get(inboxId, item.messageId);
    const code = extractCode([full.subject, full.extractedText ?? full.text ?? full.html].filter(Boolean).join('\n'));
    if (code) return { code, receivedAt: item.timestamp.toISOString() };
  }
  return null;
}

/** "Your verification code is 482913" → "482913". Needs a code word nearby so prices and dates don't count. */
export function extractCode(text: string): string | null {
  const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 20_000);
  const near = clean.match(/(?:code|passcode|verification|one[- ]time|otp|security)[^0-9]{0,60}?\b(\d{4,8})\b/i) ?? clean.match(/\b(\d{4,8})\b[^0-9]{0,40}?(?:is your|verification|code)/i);
  return near?.[1] ?? null;
}

