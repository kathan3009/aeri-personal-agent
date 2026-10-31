import { afterEach, describe, expect, it, vi } from 'vitest';
import type Kernel from '@onkernel/sdk';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock('./mailbox.js'); });
describe('emailed sign-in codes', () => {
  it('enters a code only when the store’s sign-in is waiting for one, and never the same code twice', async () => {
    const find = vi.fn(async () => ({ code: '482913', receivedAt: 'now' }));
    vi.doMock('./mailbox.js', () => ({ mailboxConfigured: () => true, findSignInCode: find }));
    const { answerEmailCode } = await import('./store-auth.js');
    const submit = vi.fn(async () => ({}));
    const client = { auth: { connections: { submit } } } as unknown as Kernel;
    const waiting = { id: 'con_1', flow_status: 'IN_PROGRESS', flow_step: 'AWAITING_INPUT', interaction_id: 'int_1', fields: [{ id: 'f_code', type: 'code' }] };
    expect(await answerEmailCode(client, waiting as never, 'instacart.com', new Date(), 'inbox_1')).toBe(true);
    expect(submit).toHaveBeenCalledWith('con_1', { field_values: { f_code: '482913' }, interaction_id: 'int_1' });
    expect(await answerEmailCode(client, waiting as never, 'instacart.com', new Date(), 'inbox_1')).toBe(false);
    expect(find).toHaveBeenCalledWith('inbox_1', 'instacart.com', expect.any(Date));
    // A password step or a finished sign-in is never touched.
    expect(await answerEmailCode(client, { ...waiting, fields: [{ id: 'p', type: 'password' }] } as never, 'instacart.com', new Date(), 'inbox_1')).toBe(false);
    expect(await answerEmailCode(client, { ...waiting, flow_status: 'SUCCESS' } as never, 'instacart.com', new Date(), 'inbox_1')).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
