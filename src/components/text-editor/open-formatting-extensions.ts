import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

/**
 * Open-source formatting features used by the Agent Editor toolbar.
 * Kept separate from the UI component so command availability is testable
 * without starting the editor's asynchronous floating-menu plugins.
 */
export const openFormattingExtensions = [
  Underline,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell
];
