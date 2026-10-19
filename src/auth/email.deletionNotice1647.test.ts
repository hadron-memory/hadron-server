import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key';
  send.mockReset();
});

describe('sendAccountDeletionNotice (#1647)', () => {
  it('treats a RESOLVED provider error ({data:null,error}: HTTP 422, network) as a failure, not an acknowledgement', async () => {
    const { sendAccountDeletionNotice } = await import('./email.js');
    send.mockResolvedValueOnce({ data: null, error: { message: 'validation_error', name: 'validation_error', statusCode: 422 } });
    await expect(sendAccountDeletionNotice('a@example.com')).rejects.toThrow(/did not acknowledge/);
    send.mockResolvedValueOnce({ data: null, error: null });
    await expect(sendAccountDeletionNotice('a@example.com')).rejects.toThrow();
  });

  it('resolves only on an acknowledgement carrying data, and the text has no reason', async () => {
    const { sendAccountDeletionNotice } = await import('./email.js');
    send.mockResolvedValueOnce({ data: { id: 'em_1' }, error: null });
    await expect(sendAccountDeletionNotice('a@example.com')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com' }));
  });
});
