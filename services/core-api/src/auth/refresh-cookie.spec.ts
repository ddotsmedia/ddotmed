import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
  withoutRefreshToken,
  type CookieCapableReply,
} from './refresh-cookie';

const makeReply = () => {
  const calls: Array<{ name: string; value?: string; options?: Record<string, unknown> }> = [];
  const reply: CookieCapableReply = {
    setCookie: (name, value, options) => calls.push({ name, value, options }),
    clearCookie: (name, options) => calls.push({ name, options }),
  };
  return { reply, calls };
};

describe('setRefreshCookie', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('marks the cookie httpOnly and scopes it to the auth path', () => {
    const { reply, calls } = makeReply();
    setRefreshCookie(reply, 'token-value', 604800);

    expect(calls[0]!.name).toBe(REFRESH_COOKIE);
    expect(calls[0]!.value).toBe('token-value');
    expect(calls[0]!.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 604800,
    });
  });

  it('sets Secure only in production', () => {
    process.env.NODE_ENV = 'production';
    const prod = makeReply();
    setRefreshCookie(prod.reply, 't', 60);
    expect(prod.calls[0]!.options).toMatchObject({ secure: true });

    process.env.NODE_ENV = 'development';
    const dev = makeReply();
    setRefreshCookie(dev.reply, 't', 60);
    expect(dev.calls[0]!.options).toMatchObject({ secure: false });
  });

  it('clears using the same path so the browser actually drops it', () => {
    const { reply, calls } = makeReply();
    clearRefreshCookie(reply);
    expect(calls[0]).toMatchObject({ name: REFRESH_COOKIE, options: { path: '/api/auth' } });
  });
});

describe('readRefreshToken', () => {
  it('prefers the cookie over a body token', () => {
    expect(readRefreshToken({ cookies: { [REFRESH_COOKIE]: 'from-cookie' } }, 'from-body')).toBe(
      'from-cookie',
    );
  });

  it('falls back to the body for native clients with no cookie jar', () => {
    expect(readRefreshToken({ cookies: {} }, 'from-body')).toBe('from-body');
    expect(readRefreshToken({}, 'from-body')).toBe('from-body');
  });

  it('returns null when neither source has a token', () => {
    expect(readRefreshToken({ cookies: {} }, undefined)).toBeNull();
    expect(readRefreshToken({}, null)).toBeNull();
  });
});

describe('withoutRefreshToken', () => {
  it('removes the refresh token so it never reaches JavaScript', () => {
    const result = withoutRefreshToken({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 900,
    });
    expect(result).toEqual({ access_token: 'a', expires_in: 900 });
    expect('refresh_token' in result).toBe(false);
  });

  it('leaves a payload without a refresh token untouched', () => {
    expect(withoutRefreshToken({ access_token: 'a' })).toEqual({ access_token: 'a' });
  });
});
