/** @vitest-environment jsdom */

import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

class WorkerStub extends EventTarget {
  onerror: ((this: Worker, ev: ErrorEvent) => unknown) | null = null;
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;

  postMessage() {}
  terminate() {}
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

type WordflowElement = HTMLElement & { updateComplete: Promise<boolean> };
type WordflowElementConstructor = CustomElementConstructor & {
  new (): WordflowElement;
};

describe('wordflow-wordflow', () => {
  let WordflowWordflow: WordflowElementConstructor;

  beforeAll(async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    (
      globalThis as typeof globalThis & { litIssuedWarnings: Set<string> }
    ).litIssuedWarnings = new Set([
      'dev-mode',
      'Expressions are not supported inside `textarea` elements. See https://lit.dev/msg/expression-in-textarea for more information.'
    ]);
    const modulePath = './wordflow';
    const wordflowModule = (await import(/* @vite-ignore */ modulePath)) as {
      WordflowWordflow: WordflowElementConstructor;
    };
    WordflowWordflow = wordflowModule.WordflowWordflow;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders the approved product name when mounted', async () => {
    vi.stubGlobal('Worker', WorkerStub);

    const element = document.createElement('wordflow-wordflow');
    expect(element).toBeInstanceOf(WordflowWordflow);

    document.body.append(element);
    await (element as WordflowElement).updateComplete;

    expect(element.shadowRoot?.querySelector('.name')?.textContent).toBe(
      'Top Writer'
    );
  });
});
