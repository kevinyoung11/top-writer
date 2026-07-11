import { LitElement, css, unsafeCSS, html, PropertyValues } from 'lit';
import {
  customElement,
  property,
  state,
  query,
  queryAsync
} from 'lit/decorators.js';
import { random } from '@xiaohk/utils';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { WordflowTextEditor } from '../text-editor/text-editor';
import { v4 as uuidv4, validate } from 'uuid';
import { config } from '../../config/config';
import { PRODUCT_NAME } from '../../config/brand';
import { TextGenerationService } from '../../llms/text-generation-service';
import { EditorBridge } from '../../voice/editor/editor-bridge';
import { VoicePreferencesStore } from '../../voice/preferences';
import { RewriteService } from '../../voice/rewrite-service';
import { SemanticLocator } from '../../voice/semantic-locator';
import { BrowserSpeechRecognizer } from '../../voice/speech/browser-recognizer';
import { BrowserSpeechSynthesizer } from '../../voice/speech/browser-synthesizer';
import { VoiceCopilotController } from '../../voice/voice-copilot-controller';
import { AgentSessionController } from '../../agent/agent-session-controller';
import type { VoiceCopilotPanel } from '../voice-copilot/voice-copilot';
import type {
  AgentToolbarCommand,
  AgentToolbarBlockType,
  AgentToolbarFacade
} from '../agent-editor/agent-toolbar';
import type { AgentReviewFacade } from '../agent-editor/agent-review-bar';
import { PromptManager } from './prompt-manager';
import { RemotePromptManager } from './remote-prompt-manager';
import { UserConfigManager, UserConfig } from './user-config';

// Types
import type { SimpleEventMessage, PromptModel } from '../../types/common-types';
import type {
  PromptDataLocal,
  PromptDataRemote,
  TagData
} from '../../types/wordflow';
import type { VirtualElement } from '@floating-ui/dom';
import type {
  WordflowSidebarMenu,
  Mode,
  SidebarSummaryCounter
} from '../sidebar-menu/sidebar-menu';
import type { WordflowFloatingMenu } from '../floating-menu/floating-menu';
import type { Editor } from '@tiptap/core';
import type { SharePromptMessage } from '../prompt-editor/prompt-editor';
import type { NightjarToast } from '../toast/toast';
import type { PrivacyDialog } from '../privacy-dialog/privacy-dialog';
import type { PrivacyDialogSimple } from '../privacy-dialog/privacy-dialog-simple';
import type { WordflowSettingWindow } from '../setting-window/setting-window';

// Components
import '../toast/toast';
import '../text-editor/text-editor';
import '../sidebar-menu/sidebar-menu';
import '../floating-menu/floating-menu';
import '../setting-window/setting-window';
import '../privacy-dialog/privacy-dialog';
import '../privacy-dialog/privacy-dialog-simple';
import '../voice-player/voice-player';
import '../voice-copilot/voice-copilot';
import '../agent-editor/agent-toolbar';
import '../agent-editor/agent-review-bar';

// Assets
import componentCSS from './wordflow.css?inline';
import logoIcon from '../../images/wordflow-logo.svg?raw';
import githubIcon from '../../images/icon-github.svg?raw';
import fileIcon from '../../images/icon-file.svg?raw';
import youtubeIcon from '../../images/icon-play.svg?raw';
import defaultPromptsJSON from '../../prompts/default-prompts.json';
import packageInfoJSON from '../../../package.json';
import TextGenLocalWorkerInline from '../../llms/web-llm?worker&inline';

const defaultPrompts = defaultPromptsJSON as PromptDataLocal[];

// Constants
const MENU_X_OFFSET = config.layout.sidebarMenuXOffset;
const DRAWER_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export interface UpdateSidebarMenuProps {
  anchor: Element | VirtualElement;
  editor: Editor;
  boxPosition: 'left' | 'right';
  summaryCounter: SidebarSummaryCounter | null;
  mode?: Mode;
  oldText?: string;
  newText?: string;
}

export interface ToastMessage {
  message: string;
  type: 'success' | 'warning' | 'error';
}

/**
 * Wordflow element.
 *
 */
@customElement('wordflow-wordflow')
export class WordflowWordflow extends LitElement {
  // ===== Class properties ======
  @queryAsync('#popper-sidebar-box')
  popperSidebarBox: Promise<HTMLElement> | undefined;

  @queryAsync('#floating-menu-box')
  floatingMenuBox: Promise<HTMLElement> | undefined;

  @queryAsync('#popper-tooltip')
  popperTooltip: Promise<HTMLElement> | undefined;

  @query('wordflow-text-editor')
  textEditorElement: WordflowTextEditor | undefined;

  @query('.center-panel')
  centerPanelElement: HTMLElement | undefined;

  @query('.wordflow')
  workflowElement: HTMLElement | undefined;

  @query('[data-voice-entry]')
  private voiceEntry: HTMLButtonElement | undefined;

  @query('#voice-copilot-drawer top-writer-voice-copilot')
  private voiceDrawerPanel: VoiceCopilotPanel | undefined;

  @state()
  showSettingWindow = false;

  @state()
  private voiceDrawerOpen = false;

  @state()
  private agentReviewVisible = false;

  @state()
  private agentReviewRefresh = 0;

  @state()
  private agentToolbarRefresh = 0;

  @state()
  private editorZoom = 100;

  @state()
  loadingActionIndex: number | null = null;

  @state()
  promptManager: PromptManager;

  @state()
  favPrompts: [
    PromptDataLocal | null,
    PromptDataLocal | null,
    PromptDataLocal | null
  ] = [null, null, null];

  @state()
  localPrompts: PromptDataLocal[] = [];

  @state()
  remotePromptManager: RemotePromptManager;

  @state()
  remotePrompts: PromptDataRemote[] = [];

  @state()
  popularTags: TagData[] = [];

  @state()
  userConfigManager: UserConfigManager;

  @state()
  userConfig!: UserConfig;

  @state()
  toastMessage = '';

  @state()
  toastType: 'success' | 'warning' | 'error' = 'success';

  @query('nightjar-toast#toast-wordflow')
  toastComponent: NightjarToast | undefined;

  @query('wordflow-privacy-dialog-simple')
  privacyDialogComponent: PrivacyDialogSimple | undefined;

  @queryAsync('wordflow-setting-window')
  settingWindowComponent!: Promise<WordflowSettingWindow>;

  lastUpdateSidebarMenuProps: UpdateSidebarMenuProps | null = null;

  textGenLocalWorker: Worker;
  textGenerationService: TextGenerationService;
  private voiceController: VoiceCopilotController | null = null;
  private voiceBridge: EditorBridge | null = null;
  private agentController: AgentSessionController | null = null;
  private toolbarTransactionEditor: Editor | null = null;
  private readonly voicePreferences = new VoicePreferencesStore();
  private voicePlayerResizeObserver: ResizeObserver | null = null;
  private observedVoicePlayer: HTMLElement | null = null;
  private agentReviewResizeObserver: ResizeObserver | null = null;
  private observedAgentReview: HTMLElement | null = null;

  // ===== Lifecycle Methods ======
  constructor() {
    super();

    // Set up user info
    this.initUserID();

    // Set up the local prompt manager
    const updateLocalPrompts = (newLocalPrompts: PromptDataLocal[]) => {
      this.localPrompts = newLocalPrompts;
    };

    const updateFavPrompts = (
      newFavPrompts: [
        PromptDataLocal | null,
        PromptDataLocal | null,
        PromptDataLocal | null
      ]
    ) => {
      this.favPrompts = newFavPrompts;
    };

    this.promptManager = new PromptManager(
      updateLocalPrompts,
      updateFavPrompts
    );

    // Set up the remote prompt manager
    const updateRemotePrompts = (newRemotePrompts: PromptDataRemote[]) => {
      this.remotePrompts = newRemotePrompts;
    };

    const updatePopularTags = (popularTags: TagData[]) => {
      this.popularTags = popularTags;
    };

    this.remotePromptManager = new RemotePromptManager(
      updateRemotePrompts,
      updatePopularTags
    );

    this.initDefaultPrompts();

    // Set up the user config store
    const updateUserConfig = (userConfig: UserConfig) => {
      this.userConfig = userConfig;
    };
    this.userConfigManager = new UserConfigManager(updateUserConfig);

    // We do not collect usage data now
    localStorage.setItem('has-confirmed-privacy', 'true');

    // Query and show a prompt if the URL includes the prompt search param
    const urlParams = new URLSearchParams(window.location.search);

    if (urlParams.has('prompt')) {
      const promptID = urlParams.get('prompt')!;
      if (validate(promptID)) {
        this.remotePromptManager.getPrompt(promptID).then(prompt => {
          if (prompt !== null) {
            this.showSettingWindow = true;
            this.settingWindowComponent.then(window => {
              window.showCommunityPrompt(prompt);
            });
          }
        });
      }
    }

    // Initialize the local llm worker
    this.textGenLocalWorker = new TextGenLocalWorkerInline();
    this.textGenerationService = new TextGenerationService({
      worker: this.textGenLocalWorker
    });
  }

  firstUpdated() {
    if (this.workflowElement === undefined) {
      throw Error('workflowElement undefined.');
    }
  }

  updated() {
    const player = this.shadowRoot?.querySelector<HTMLElement>(
      'top-writer-voice-player'
    ) ?? null;
    if (player !== this.observedVoicePlayer) {
      this.voicePlayerResizeObserver?.disconnect();
      this.voicePlayerResizeObserver = null;
      this.observedVoicePlayer = player;
      this.observeLayoutHeight(
        player,
        '--voice-player-height',
        observer => (this.voicePlayerResizeObserver = observer)
      );
    }

    const review = this.shadowRoot?.querySelector<HTMLElement>(
      'top-writer-agent-review-bar'
    ) ?? null;
    if (review !== this.observedAgentReview) {
      this.agentReviewResizeObserver?.disconnect();
      this.agentReviewResizeObserver = null;
      this.observedAgentReview = review;
      this.observeLayoutHeight(
        review,
        '--agent-review-height',
        observer => (this.agentReviewResizeObserver = observer)
      );
    }
  }

  private observeLayoutHeight(
    element: HTMLElement | null,
    variable: '--voice-player-height' | '--agent-review-height',
    setObserver: (observer: ResizeObserver) => void
  ) {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height;
      if (typeof height === 'number') {
        this.workflowElement?.style.setProperty(variable, `${height}px`);
      }
    });
    setObserver(observer);
    observer.observe(element);
  }

  disconnectedCallback() {
    this.voicePlayerResizeObserver?.disconnect();
    this.voicePlayerResizeObserver = null;
    this.observedVoicePlayer = null;
    this.agentReviewResizeObserver?.disconnect();
    this.agentReviewResizeObserver = null;
    this.observedAgentReview = null;
    this.voiceController?.destroy();
    this.voiceController?.removeEventListener(
      'state-change',
      this.voiceStateHandler
    );
    this.voiceController = null;
    this.agentController?.removeEventListener(
      'statechange',
      this.agentSessionStateHandler
    );
    this.agentController?.destroy();
    this.agentController = null;
    this.toolbarTransactionEditor?.off(
      'transaction',
      this.agentToolbarTransactionHandler
    );
    this.toolbarTransactionEditor = null;
    this.voiceBridge?.destroy();
    this.voiceBridge = null;
    this.textGenerationService.destroy();
    super.disconnectedCallback();
  }

  private voiceEditorReadyHandler(event: CustomEvent<EditorBridge>) {
    const bridge = event.detail;
    if (this.voiceController || !bridge) return;
    this.voiceBridge = bridge;
    this.voiceController = new VoiceCopilotController({
      recognizer: new BrowserSpeechRecognizer(),
      synthesizer: new BrowserSpeechSynthesizer(),
      editor: bridge,
      locator: new SemanticLocator(this.textGenerationService),
      rewriter: new RewriteService(this.textGenerationService),
      preferences: this.voicePreferences,
      getModelContext: () => ({ userConfig: this.userConfig, userID: this.initUserID() })
    });
    this.voiceController.addEventListener(
      'state-change',
      this.voiceStateHandler
    );
    this.agentController = new AgentSessionController({
      bridge,
      generator: this.textGenerationService,
      temperature: 0.2,
      userConfig: this.userConfig,
      userID: this.initUserID()
    });
    this.agentController.addEventListener(
      'statechange',
      this.agentSessionStateHandler
    );
    const editor = this.textEditorElement?.editor;
    if (editor) {
      this.toolbarTransactionEditor = editor;
      editor.on('transaction', this.agentToolbarTransactionHandler);
    }
    this.requestUpdate();
  }

  private readonly agentSessionStateHandler = () => {
    if (this.agentController?.state.result?.status === 'suggested') {
      this.agentReviewVisible = true;
    }
    this.agentReviewRefresh += 1;
  };

  private readonly voiceStateHandler = () => {
    const preview = this.voiceController?.state.preview;
    const hasSuggestions = (this.voiceBridge?.listAgentSuggestions().length ?? 0) > 0;
    const isSharedVoicePreview =
      preview?.mode === 'rewrite' &&
      this.voiceBridge?.currentAgentSuggestion()?.id === preview.id;

    if (isSharedVoicePreview) {
      this.agentReviewVisible = true;
      // A modal drawer intentionally blocks background controls. Once a voice
      // rewrite has been staged as a shared Agent Editor suggestion, return
      // focus to the document surface so its single review bar is actionable.
      this.voiceDrawerOpen = false;
    } else if (!hasSuggestions) {
      this.agentReviewVisible = false;
    }
    this.agentReviewRefresh += 1;
  };

  private readonly agentToolbarTransactionHandler = () => {
    this.agentToolbarRefresh += 1;
  };

  private readonly agentToolbarController: AgentToolbarFacade = {
    execute: command => this.executeEditorCommand(command),
    launchAgent: () => this.launchAgentSession(),
    supports: command => this.supportsEditorCommand(command),
    isEnabled: command => this.canExecuteEditorCommand(command),
    isActive: command => this.isEditorCommandActive(command),
    getZoom: () => this.editorZoom,
    getBlockType: () => this.getEditorBlockType(),
    canLaunchAgent: () =>
      this.agentController !== null &&
      this.agentController.state.phase !== 'running'
  };

  private readonly agentReviewController: AgentReviewFacade = {
    listAgentSuggestions: () => this.voiceBridge?.listAgentSuggestions() ?? [],
    currentAgentSuggestion: () => this.voiceBridge?.currentAgentSuggestion() ?? null,
    previousAgentSuggestion: () => this.voiceBridge?.previousAgentSuggestion() ?? null,
    nextAgentSuggestion: () => this.voiceBridge?.nextAgentSuggestion() ?? null,
    acceptAgentSuggestion: () => {
      const id = this.voiceBridge?.currentAgentSuggestion()?.id;
      if (this.voiceController?.acceptSharedReviewSuggestion(id)) return;
      return this.voiceBridge?.acceptAgentSuggestion();
    },
    rejectAgentSuggestion: () => {
      const id = this.voiceBridge?.currentAgentSuggestion()?.id;
      if (this.voiceController?.rejectSharedReviewSuggestion(id)) return;
      return this.voiceBridge?.rejectAgentSuggestion();
    },
    acceptAllAgentSuggestions: () => {
      const previewId = this.voiceController?.state.preview?.id;
      if (previewId) this.voiceController?.acceptSharedReviewSuggestion(previewId);
      return this.voiceBridge?.acceptAllAgentSuggestions();
    },
    rejectAllAgentSuggestions: () => {
      const previewId = this.voiceController?.state.preview?.id;
      if (previewId) this.voiceController?.rejectSharedReviewSuggestion(previewId);
      return this.voiceBridge?.rejectAllAgentSuggestions();
    },
    close: () => {
      this.agentReviewVisible = false;
    }
  };

  private editorCommandName(command: AgentToolbarCommand) {
    const names: Record<AgentToolbarCommand, string> = {
      undo: 'undo',
      redo: 'redo',
      zoomOut: '',
      zoomIn: '',
      setParagraph: 'setParagraph',
      setHeading1: 'setHeading',
      setHeading2: 'setHeading',
      setHeading3: 'setHeading',
      blockquote: 'toggleBlockquote',
      bold: 'toggleBold',
      italic: 'toggleItalic',
      strike: 'toggleStrike',
      underline: 'toggleUnderline',
      bulletList: 'toggleBulletList',
      orderedList: 'toggleOrderedList',
      alignLeft: 'setTextAlign',
      alignCenter: 'setTextAlign',
      alignRight: 'setTextAlign',
      alignJustify: 'setTextAlign',
      insertTable: 'insertTable'
    };
    return names[command];
  }

  private editorCommandArguments(command: AgentToolbarCommand): unknown | undefined {
    switch (command) {
      case 'setHeading1': return { level: 1 };
      case 'setHeading2': return { level: 2 };
      case 'setHeading3': return { level: 3 };
      case 'alignLeft': return 'left';
      case 'alignCenter': return 'center';
      case 'alignRight': return 'right';
      case 'alignJustify': return 'justify';
      case 'insertTable': return { rows: 3, cols: 3, withHeaderRow: true };
      default: return undefined;
    }
  }

  private isZoomCommand(command: AgentToolbarCommand) {
    return command === 'zoomIn' || command === 'zoomOut';
  }

  private supportsEditorCommand(command: AgentToolbarCommand) {
    if (this.isZoomCommand(command)) return true;
    const editor = this.textEditorElement?.editor;
    const name = this.editorCommandName(command);
    return Boolean(
      editor &&
        typeof (editor.commands as unknown as Record<string, unknown>)[name] ===
          'function'
    );
  }

  private canExecuteEditorCommand(command: AgentToolbarCommand) {
    if (command === 'zoomIn') return this.editorZoom < 150;
    if (command === 'zoomOut') return this.editorZoom > 50;
    const editor = this.textEditorElement?.editor;
    if (!editor || !this.supportsEditorCommand(command)) return false;
    const name = this.editorCommandName(command);
    const chain = editor.can().chain().focus() as unknown as Record<
      string,
      (...args: unknown[]) => { run: () => boolean }
    >;
    const action = chain[name];
    if (typeof action !== 'function') return false;
    const arguments_ = this.editorCommandArguments(command);
    return arguments_ === undefined
      ? action.call(chain).run()
      : action.call(chain, arguments_).run();
  }

  private isEditorCommandActive(command: AgentToolbarCommand) {
    const editor = this.textEditorElement?.editor;
    if (!editor) return false;
    const names: Partial<Record<AgentToolbarCommand, string>> = {
      blockquote: 'blockquote',
      bold: 'bold',
      italic: 'italic',
      strike: 'strike',
      underline: 'underline',
      bulletList: 'bulletList',
      orderedList: 'orderedList'
    };
    const name = names[command];
    if (name) return editor.isActive(name);
    const alignment = this.editorCommandArguments(command);
    return typeof alignment === 'string'
      ? editor.isActive({ textAlign: alignment })
      : false;
  }

  private getEditorBlockType(): AgentToolbarBlockType {
    const editor = this.textEditorElement?.editor;
    if (!editor) return 'paragraph';
    for (const level of [1, 2, 3] as const) {
      if (editor.isActive('heading', { level })) return `heading${level}` as AgentToolbarBlockType;
    }
    return 'paragraph';
  }

  private executeEditorCommand(command: AgentToolbarCommand) {
    if (command === 'zoomIn' || command === 'zoomOut') {
      const increment = command === 'zoomIn' ? 10 : -10;
      this.editorZoom = Math.min(150, Math.max(50, this.editorZoom + increment));
      this.agentToolbarRefresh += 1;
      return;
    }
    const editor = this.textEditorElement?.editor;
    if (!editor || !this.canExecuteEditorCommand(command)) return;
    const name = this.editorCommandName(command);
    const chain = editor.chain().focus() as unknown as Record<
      string,
      (...args: unknown[]) => { run: () => boolean }
    >;
    const action = chain[name];
    if (typeof action !== 'function') return;
    const arguments_ = this.editorCommandArguments(command);
    if (arguments_ === undefined) action.call(chain).run();
    else action.call(chain, arguments_).run();
    this.requestUpdate();
  }

  private launchAgentSession() {
    if (!this.agentController || this.agentController.state.phase === 'running') return;
    void this.agentController.run({
      instruction: 'Improve the selected text while preserving its meaning.',
      context: this.voiceBridge?.getSnapshot().selection ? 'selection' : 'current-block'
    });
  }

  private openVoiceDrawer() {
    this.voiceDrawerOpen = true;
    void this.focusVoiceDrawer();
  }

  private async focusVoiceDrawer() {
    await this.updateComplete;
    const panel = this.voiceDrawerPanel;
    if (!panel) return;
    await panel.updateComplete;
    if (this.voiceDrawerOpen) panel.focusHeading();
  }

  private closeVoiceDrawer() {
    if (this.voiceController?.state.phase === 'listening') {
      this.voiceController.cancel();
    }
    this.voiceDrawerOpen = false;
    void this.updateComplete.then(() => this.voiceEntry?.focus());
  }

  private drawerKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeVoiceDrawer();
      return;
    }

    if (event.key !== 'Tab') return;
    const drawer = event.currentTarget as HTMLElement;
    const focusable = this.drawerFocusableElements(drawer);
    if (focusable.length === 0) return;

    const active = this.drawerActiveElement();
    const activeIndex = focusable.indexOf(active as HTMLElement);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
    const shouldWrapForward = !event.shiftKey && activeIndex >= focusable.length - 1;

    if (shouldWrapBackward) {
      event.preventDefault();
      last.focus();
    } else if (shouldWrapForward) {
      event.preventDefault();
      first.focus();
    }
  }

  private drawerFocusableElements(drawer: HTMLElement): HTMLElement[] {
    const focusable: HTMLElement[] = [];
    const collect = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>('*').forEach(element => {
        if (element.matches(DRAWER_FOCUSABLE_SELECTOR)) focusable.push(element);
        if (element.shadowRoot) collect(element.shadowRoot);
      });
    };
    collect(drawer);
    return focusable;
  }

  private drawerActiveElement(): Element | null {
    let active = this.shadowRoot?.activeElement ?? document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  private drawerBackdropClick(event: MouseEvent) {
    if (event.target !== event.currentTarget) return;
    this.closeVoiceDrawer();
  }

  /**
   * This method is called before new DOM is updated and rendered
   * @param changedProperties Property that has been changed
   */
  willUpdate(changedProperties: PropertyValues<this>) {}

  // ===== Custom Methods ======
  initData = async () => {};

  initUserID() {
    const userID = localStorage.getItem('user-id');
    if (userID === null) {
      const newUserID = uuidv4();
      localStorage.setItem('user-id', newUserID);
      return newUserID;
    } else {
      return userID;
    }
  }

  /**
   * Add a few default prompts to the new user's local library.
   */
  initDefaultPrompts() {
    let userID = localStorage.getItem('user-id');
    if (userID === null) {
      console.warn('userID is null');
      userID = this.initUserID();
    }

    // Add some default prompts for the first-time users
    const hasAddedDefaultPrompts = localStorage.getItem(
      'has-added-default-prompts'
    );

    if (hasAddedDefaultPrompts === null) {
      for (const [_, prompt] of defaultPrompts.entries()) {
        // Update some fields
        prompt.key = uuidv4();
        prompt.userID = userID;
        prompt.created = new Date().toISOString();
        // prompt.promptRunCount = random(12, 250);
        this.promptManager.addPrompt(prompt);
      }

      // Add the last three as fav prompts
      for (const [i, prompt] of defaultPrompts
        .reverse()
        .slice(0, 3)
        .entries()) {
        this.promptManager.setFavPrompt(i, prompt);
      }

      localStorage.setItem('has-added-default-prompts', 'true');
    }
  }

  /**
   * Update the sidebar menu position and content
   */
  updateSidebarMenu = async ({
    anchor,
    boxPosition,
    editor,
    mode,
    oldText,
    newText,
    summaryCounter
  }: UpdateSidebarMenuProps) => {
    if (
      this.centerPanelElement === undefined ||
      this.popperSidebarBox === undefined
    ) {
      console.error('centerPanelElement is undefined');
      return;
    }

    const popperElement = await this.popperSidebarBox;
    const menuElement = popperElement.querySelector(
      'wordflow-sidebar-menu'
    ) as WordflowSidebarMenu;

    // Pass data to the menu component
    if (mode) menuElement.mode = mode;
    if (oldText) menuElement.oldText = oldText;
    if (newText) menuElement.newText = newText;
    if (summaryCounter) {
      menuElement.summaryCounter = summaryCounter;
    } else {
      menuElement.summaryCounter = null;
    }

    // Cache the props
    this.lastUpdateSidebarMenuProps = {
      anchor,
      boxPosition,
      editor,
      mode: menuElement.mode,
      oldText: menuElement.oldText,
      newText: menuElement.newText,
      summaryCounter: menuElement.summaryCounter
    };

    const { view } = editor;
    const $from = view.state.selection.$from;
    const cursorCoordinate = view.coordsAtPos($from.pos);

    // Need to wait the child component to update
    await new Promise(r => {
      setTimeout(r, 0);
    });

    // Need to bound the box inside the view
    const popperElementBBox = popperElement.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const invisibleHeight = window.scrollY;

    // Get the line height in the editor element
    const lineHeight = parseInt(
      window.getComputedStyle(editor.view.dom).lineHeight
    );

    const PADDING_OFFSET = 5;
    const minTop =
      invisibleHeight + popperElementBBox.height / 2 + PADDING_OFFSET;
    const maxTop =
      windowHeight +
      invisibleHeight -
      popperElementBBox.height / 2 -
      PADDING_OFFSET;
    const idealTop = cursorCoordinate.top + invisibleHeight + lineHeight / 2;
    const boundedTop = Math.min(maxTop, Math.max(minTop, idealTop));

    popperElement.style.marginTop = `${boundedTop}px`;
  };

  async updateSidebarMenuXPos(boxPosition: 'left' | 'right') {
    if (
      this.centerPanelElement === undefined ||
      this.popperSidebarBox === undefined
    ) {
      console.error('centerPanelElement is undefined');
      return;
    }

    const popperElement = await this.popperSidebarBox;
    const containerBBox = this.centerPanelElement.getBoundingClientRect();
    const menuElement = popperElement.querySelector(
      'wordflow-sidebar-menu'
    ) as WordflowSidebarMenu;

    if (boxPosition === 'left') {
      // Set the 'is-on-left' property of the component
      menuElement.isOnLeft = true;

      const offsetParentBBox =
        popperElement.offsetParent!.getBoundingClientRect();
      popperElement.style.left = 'unset';
      popperElement.style.right = `${
        offsetParentBBox.width - containerBBox.x + MENU_X_OFFSET
      }px`;
    } else {
      // Set the 'is-on-left' property of the component
      menuElement.isOnLeft = false;

      popperElement.style.right = 'unset';
      popperElement.style.left = `${
        containerBBox.x + containerBBox.width + MENU_X_OFFSET
      }px`;
    }
  }

  // ===== Event Methods ======
  sidebarMenuFooterButtonClickedHandler(e: CustomEvent<string>) {
    // Delegate the event to the text editor component
    if (!this.textEditorElement) return;
    this.textEditorElement.sidebarMenuFooterButtonClickedHandler(e);
  }

  floatingMenuToolMouseEnterHandler() {
    // Delegate the event to the text editor component
    if (!this.textEditorElement) return;
    this.textEditorElement.floatingMenuToolsMouseEnterHandler();
  }

  floatingMenuToolsMouseLeaveHandler() {
    // Delegate the event to the text editor component
    if (!this.textEditorElement) return;
    this.textEditorElement.floatingMenuToolsMouseLeaveHandler();
  }

  floatingMenuToolButtonClickHandler(
    e: CustomEvent<[PromptDataLocal, number]>
  ) {
    if (this.workflowElement === undefined) {
      throw Error('workflowElement is undefined');
    }

    const handleButtonClick = () => {
      // Delegate the event to the text editor component
      if (!this.textEditorElement) return;
      const [prompt, index] = e.detail;
      this.textEditorElement.floatingMenuToolButtonClickHandler(prompt);

      // Start the loading animation
      this.loadingActionIndex = index;
    };

    // First check if the user has agreed the privacy policy
    const hasConfirmedPrivacy = localStorage.getItem('has-confirmed-privacy');
    if (hasConfirmedPrivacy === 'true') {
      handleButtonClick();
    } else {
      if (!this.privacyDialogComponent) {
        throw Error('privacyDialogComponent is null');
      }
      this.privacyDialogComponent.show(handleButtonClick);
    }
  }

  textEditorLoadingFinishedHandler() {
    this.loadingActionIndex = null;
  }

  promptEditorShareClicked(e: CustomEvent<SharePromptMessage>) {
    if (!this.toastComponent) {
      throw Error('Toast is undefined.');
    }

    const prompt = e.detail.data;
    const stopLoader = e.detail.stopLoader;

    const handleShareClick = () => {
      this.remotePromptManager.sharePrompt(prompt).then(status => {
        stopLoader(status);
      });
    };

    // First check if the user has agreed the privacy policy
    const hasConfirmedPrivacy = localStorage.getItem('has-confirmed-privacy');

    if (hasConfirmedPrivacy === 'true') {
      handleShareClick();
    } else {
      if (!this.privacyDialogComponent) {
        throw Error('privacyDialogComponent is null');
      }
      this.privacyDialogComponent.show(handleShareClick);
    }
  }

  // ===== Templates and Styles ======
  render() {
    return html`
      <div class="wordflow">
        <div class="toast-container">
          <nightjar-toast
            id="toast-wordflow"
            message=${this.toastMessage}
            type=${this.toastType}
          ></nightjar-toast>
        </div>

        <div class="left-panel">
          <div class="left-padding"></div>
          <div
            class="popper-box popper-sidebar-menu hidden"
            id="popper-sidebar-box"
          >
            <wordflow-sidebar-menu
              id="right-sidebar-menu"
              @footer-button-clicked=${(e: CustomEvent<string>) =>
                this.sidebarMenuFooterButtonClickedHandler(e)}
            ></wordflow-sidebar-menu>
          </div>
          <div class="right-padding"></div>
        </div>

        <div class="logo-container">
          <div class="center">
            <a
              class="row"
              href="https://github.com/poloclub/wordflow"
              target="_blank"
            >
              <span class="svg-icon">${unsafeHTML(logoIcon)}</span>
              <span class="name">${PRODUCT_NAME}</span>
            </a>
          </div>
        </div>

        <div class="center-panel">
          <top-writer-agent-toolbar
            .controller=${this.agentToolbarController}
            .refreshToken=${this.agentToolbarRefresh}
          ></top-writer-agent-toolbar>
          <div class="editor-content">
            <wordflow-text-editor
              .zoomPercent=${this.editorZoom}
              .popperSidebarBox=${this.popperSidebarBox}
              .floatingMenuBox=${this.floatingMenuBox}
              .updateSidebarMenu=${this.updateSidebarMenu}
              .promptManager=${this.promptManager}
              .userConfig=${this.userConfig}
              .textGenerationService=${this.textGenerationService}
              @editor-bridge-ready=${(event: CustomEvent<EditorBridge>) => this.voiceEditorReadyHandler(event)}
              @loading-finished=${() => this.textEditorLoadingFinishedHandler()}
              @show-toast=${(e: CustomEvent<ToastMessage>) => {
                this.toastMessage = e.detail.message;
                this.toastType = e.detail.type;
                this.toastComponent?.show();
              }}
            ></wordflow-text-editor>
          </div>
          <top-writer-agent-review-bar
            ?hidden=${!this.agentReviewVisible}
            .controller=${this.agentReviewController}
            .refreshToken=${this.agentReviewRefresh}
          ></top-writer-agent-review-bar>
          ${this.voiceController ? html`<top-writer-voice-player .controller=${this.voiceController}></top-writer-voice-player>` : null}
        </div>

        <div class="right-panel">
          <button
            class="voice-entry-rail"
            data-voice-entry
            aria-label="语音副驾"
            aria-expanded=${this.voiceDrawerOpen ? 'true' : 'false'}
            aria-controls="voice-copilot-drawer"
            @click=${this.openVoiceDrawer}
          >
            语音副驾
          </button>
          <div class="top-padding"></div>
          <div class="footer-info">
            <a
              class="row"
              href="https://github.com/poloclub/wordflow/"
              target="_blank"
              ><span class="svg-icon">${unsafeHTML(githubIcon)}</span> Code</a
            >

            <a
              class="row"
              href="https://arxiv.org/abs/2401.14447"
              target="_blank"
              ><span class="svg-icon">${unsafeHTML(fileIcon)}</span> Paper</a
            >

            <a class="row" href="https://youtu.be/3dOcVuofGVo" target="_blank"
              ><span class="svg-icon">${unsafeHTML(youtubeIcon)}</span> Video</a
            >

            <a
              class="row"
              href="https://github.com/poloclub/wordflow/issues/new"
              target="_blank"
              >Report an issue</a
            >

            <a
              class="row"
              href="https://github.com/poloclub/wordflow"
              target="_blank"
              >Version (${packageInfoJSON.version})</a
            >

            <div
              class="row"
              @click=${() => {
                this.privacyDialogComponent?.show(() => {});
              }}
            >
              Privacy
            </div>
          </div>
        </div>

        ${this.voiceDrawerOpen
          ? html`
              <div
                class="voice-drawer-backdrop"
                @click=${this.drawerBackdropClick}
              ></div>
              <aside
                id="voice-copilot-drawer"
                role="dialog"
                aria-modal="true"
                aria-label="语音副驾"
                @keydown=${this.drawerKeydown}
              >
                <button
                  aria-label="关闭语音副驾"
                  @click=${this.closeVoiceDrawer}
                >
                  关闭
                </button>
                <top-writer-voice-copilot
                  .controller=${this.voiceController}
                  .preferences=${this.voicePreferences}
                ></top-writer-voice-copilot>
              </aside>
            `
          : null}

        <div class="floating-menu-box hidden" id="floating-menu-box">
          <wordflow-floating-menu
            .popperTooltip=${this.popperTooltip}
            .loadingActionIndex=${this.loadingActionIndex}
            .favPrompts=${this.favPrompts}
            @mouse-enter-tools=${() => this.floatingMenuToolMouseEnterHandler()}
            @mouse-leave-tools=${() =>
              this.floatingMenuToolsMouseLeaveHandler()}
            @tool-button-clicked=${(
              e: CustomEvent<[PromptDataLocal, number]>
            ) => this.floatingMenuToolButtonClickHandler(e)}
            @setting-button-clicked=${() => {
              this.showSettingWindow = true;
            }}
          ></wordflow-floating-menu>
        </div>

        <wordflow-setting-window
          ?is-hidden=${!this.showSettingWindow}
          .promptManager=${this.promptManager}
          .localPrompts=${this.localPrompts}
          .favPrompts=${this.favPrompts}
          .remotePromptManager=${this.remotePromptManager}
          .remotePrompts=${this.remotePrompts}
          .popularTags=${this.popularTags}
          .userConfigManager=${this.userConfigManager}
          .userConfig=${this.userConfig}
          .textGenLocalWorker=${this.textGenLocalWorker}
          @close-button-clicked=${() => {
            this.showSettingWindow = false;
          }}
          @share-clicked=${(e: CustomEvent<SharePromptMessage>) =>
            this.promptEditorShareClicked(e)}
        ></wordflow-setting-window>

        <wordflow-privacy-dialog-simple></wordflow-privacy-dialog-simple>

        <div id="popper-tooltip" class="popper-tooltip hidden" role="tooltip">
          <span class="popper-content"></span>
          <div class="popper-arrow"></div>
        </div>
      </div>
    `;
  }

  static styles = [
    css`
      ${unsafeCSS(componentCSS)}
    `
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'wordflow-wordflow': WordflowWordflow;
  }
}
