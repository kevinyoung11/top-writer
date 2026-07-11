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
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false
    });
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

  it('places agent editor controls above the editor and player region', async () => {
    vi.stubGlobal('Worker', WorkerStub);

    const element = document.createElement('wordflow-wordflow') as WordflowElement;
    document.body.append(element);
    await element.updateComplete;

    const center = element.shadowRoot?.querySelector('.center-panel');
    const toolbar = center?.querySelector('top-writer-agent-toolbar');
    const review = center?.querySelector('top-writer-agent-review-bar');
    const editor = center?.querySelector('wordflow-text-editor');

    expect(toolbar?.compareDocumentPosition(editor!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(review?.compareDocumentPosition(editor!)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it('disables the AI toolbar trigger until its session controller is ready', async () => {
    vi.stubGlobal('Worker', WorkerStub);

    const element = document.createElement('wordflow-wordflow') as WordflowElement;
    document.body.append(element);
    await element.updateComplete;

    const button = element.shadowRoot
      ?.querySelector<HTMLElement>('top-writer-agent-toolbar')
      ?.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Ask AI"]');
    expect(button?.disabled).toBe(true);
  });
});
