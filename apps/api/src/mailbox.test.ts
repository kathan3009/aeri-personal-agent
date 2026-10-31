import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCode, recordEmail } from './mailbox.js';
import { createStore } from './store.js';

describe('sign-in codes from store emails', () => {
  it('reads a code only when a code word is nearby, so prices, dates and order numbers do not count', () => {
    expect(extractCode('Your Instacart verification code is 482913. It expires in 10 minutes.')).toBe('482913');
    expect(extractCode('<p>Use this one-time passcode:</p><h1>7314</h1>')).toBe('7314');
    expect(extractCode('Your order total was $2024.50 on 10/04/2026')).toBeNull();
    expect(extractCode('Order 1234567 shipped')).toBeNull();
  });
});

describe('store emails in Aeri’s inbox', () => {
  it('suggests the order number from the store’s confirmation email for the cart waiting on it, once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeri-mail-'));
    const store = createStore('', directory);
    try {
      await store.update(state => { state.carts.push({ id: 'c1', origin: 'request', status: 'checkout_ready', merchant: 'Target', checkoutUrl: 'https://www.target.com/cart', createdAt: 'now', updatedAt: 'now',
        items: [{ id: 'i1', name: 'Milk', quantity: { amount: 1, unit: 'each' }, optional: false, status: 'added', estimatedPriceCents: 399 }] }); });
      const email = { id: 'm1', sender: 'Target <orders@oe.target.com>', subject: 'Thanks for your order!', text: 'Order #912004417 is confirmed.' };
      expect(await recordEmail(store, email)).toBe(true);
      const state = await store.read();
      expect(state.carts[0].suggestedOrderReference).toMatchObject({ reference: '912004417', from: 'target.com' });
      expect(state.carts[0].orderReference).toBeUndefined();
      expect(state.tasks[0]).toMatchObject({ title: 'Order number found', subjectId: 'c1' });
      expect(await recordEmail(store, email)).toBe(false);
      // Another store's email never suggests a number for this cart.
      await recordEmail(store, { id: 'm2', sender: 'orders@walmart.com', subject: 'Order confirmed', text: 'Order #55500011' });
      expect((await store.read()).carts[0].suggestedOrderReference?.reference).toBe('912004417');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
