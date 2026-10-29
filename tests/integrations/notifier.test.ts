import { describe, expect, it, vi } from 'vitest';
import { ResendNotifier } from '../../src/integrations/notifier.js';
import { AppError } from '../../src/lib/errors.js';

function fakeResend(result: unknown = { data: { id: 'em_1' }, error: null }) {
  const send = vi.fn().mockResolvedValue(result);
  return { client: { emails: { send } }, send };
}

describe('ResendNotifier', () => {
  it('sends the verification code with subject, html and text', async () => {
    const { client, send } = fakeResend();
    const n = new ResendNotifier(client as never, 'Pipeline <no-reply@pipelinepub.com>');
    await n.sendOtp({ channel: 'email', destination: 'a@b.com', code: '0420', purpose: 'login' });

    const arg = send.mock.calls[0]?.[0];
    expect(arg.from).toBe('Pipeline <no-reply@pipelinepub.com>');
    expect(arg.to).toEqual(['a@b.com']);
    expect(arg.subject).toBe('Your Pipeline verification code');
    expect(arg.html).toContain('0420');
    expect(arg.text).toContain('0420');
    expect(arg.text).toMatch(/5 minutes/);
  });

  it('uses the reset subject for password resets', async () => {
    const { client, send } = fakeResend();
    await new ResendNotifier(client as never, 'x@y.com').sendOtp({
      channel: 'email',
      destination: 'a@b.com',
      code: '1234',
      purpose: 'password_reset',
    });
    expect(send.mock.calls[0]?.[0].subject).toBe('Reset your Pipeline password');
  });

  it('maps a Resend error result to EMAIL_DELIVERY_FAILED', async () => {
    const { client } = fakeResend({ data: null, error: { name: 'validation_error', message: 'bad from' } });
    const p = new ResendNotifier(client as never, 'x@y.com').sendOtp({
      channel: 'email',
      destination: 'a@b.com',
      code: '1234',
      purpose: 'signup',
    });
    await expect(p).rejects.toMatchObject({ code: 'EMAIL_DELIVERY_FAILED' });
  });

  it('keeps the Resend error text out of the client-visible extra', async () => {
    const { client } = fakeResend({
      data: null,
      error: { name: 'validation_error', message: 'You can only send testing emails to owner@corp.com' },
    });
    const err = await new ResendNotifier(client as never, 'x@y.com')
      .sendOtp({ channel: 'email', destination: 'a@b.com', code: '1234', purpose: 'signup' })
      .catch((e: unknown) => e);
    expect(JSON.stringify((err as AppError).extra)).not.toContain('owner@corp.com');
    expect((err as Error).cause).toBeDefined();
  });

  it('maps a thrown network error to EMAIL_DELIVERY_FAILED', async () => {
    const client = { emails: { send: vi.fn().mockRejectedValue(new Error('ECONNRESET')) } };
    const p = new ResendNotifier(client as never, 'x@y.com').sendOtp({
      channel: 'email',
      destination: 'a@b.com',
      code: '1234',
      purpose: 'signup',
    });
    await expect(p).rejects.toBeInstanceOf(AppError);
  });

  it('refuses the sms channel until an SMS provider is configured', async () => {
    const { client } = fakeResend();
    await expect(
      new ResendNotifier(client as never, 'x@y.com').sendOtp({
        channel: 'sms',
        destination: '+15550000000',
        code: '1234',
        purpose: 'signup',
      }),
    ).rejects.toThrow('SMS channel not configured');
  });
});
