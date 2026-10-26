import { isLoginUrl } from './login.guard';

describe('isLoginUrl', () => {
  it('matches the login route incl. query/fragment only', () => {
    expect(isLoginUrl('/login')).toBe(true);
    expect(isLoginUrl('/login?x=1')).toBe(true);
    expect(isLoginUrl('/login#a')).toBe(true);
    expect(isLoginUrl('/')).toBe(false);
    expect(isLoginUrl('/loginx')).toBe(false);
    expect(isLoginUrl('/tag/TODAY/tasks')).toBe(false);
  });
});
