import { beforeEach } from 'vitest';

beforeEach(() => {
  if (
    typeof window !== 'undefined' &&
    typeof window.localStorage.clear === 'function'
  ) {
    window.localStorage.clear();
  }
  if (typeof document !== 'undefined') document.body.replaceChildren();
});
