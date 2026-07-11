import type {
  EditorSnapshot,
  ParagraphRef,
  VoiceRange,
  VoiceScope,
} from "./types";

const cloneRange = (range: VoiceRange, block = range.block): VoiceRange => ({
  ...range,
  paragraphIndexes: [...range.paragraphIndexes],
  block,
});

const rangeForParagraph = (
  paragraph: ParagraphRef,
  revision: number,
): VoiceRange => ({
  revision,
  from: paragraph.nodeFrom,
  to: paragraph.nodeTo,
  text: paragraph.text,
  paragraphIndexes: [paragraph.index],
  block: true,
});

const findParagraphPosition = (
  snapshot: EditorSnapshot,
  index: number | null,
): number => {
  if (index === null || !Number.isInteger(index)) return -1;
  return snapshot.paragraphs.findIndex(
    (paragraph) => paragraph.index === index,
  );
};

const anchorPosition = (snapshot: EditorSnapshot): number => {
  const spoken = findParagraphPosition(
    snapshot,
    snapshot.lastSpokenParagraphIndex,
  );
  return spoken >= 0
    ? spoken
    : findParagraphPosition(snapshot, snapshot.currentParagraphIndex);
};

const selectionSpansFullNodes = (
  selection: VoiceRange,
  paragraphs: readonly ParagraphRef[],
): boolean => {
  const overlapping = paragraphs.filter(
    (paragraph) =>
      selection.from < paragraph.nodeTo && selection.to > paragraph.nodeFrom,
  );
  if (overlapping.length === 0) return false;

  return (
    selection.from === overlapping[0].nodeFrom &&
    selection.to === overlapping[overlapping.length - 1].nodeTo &&
    overlapping.every(
      (paragraph) =>
        selection.from <= paragraph.nodeFrom &&
        selection.to >= paragraph.nodeTo,
    )
  );
};

const resolvedSelection = (snapshot: EditorSnapshot): VoiceRange | null => {
  if (!snapshot.selection) return null;
  return cloneRange(
    snapshot.selection,
    selectionSpansFullNodes(snapshot.selection, snapshot.paragraphs),
  );
};

const resolvedAnchor = (
  snapshot: EditorSnapshot,
  offset: -1 | 0 | 1,
): VoiceRange | null => {
  const position = anchorPosition(snapshot);
  const target = position + offset;
  if (position < 0 || target < 0 || target >= snapshot.paragraphs.length) {
    return null;
  }
  return rangeForParagraph(snapshot.paragraphs[target], snapshot.revision);
};

const canonicalDocumentText = (
  paragraphs: readonly ParagraphRef[],
): string | null => {
  const first = paragraphs[0];
  if (!first) return null;

  let text = first.text;
  for (const paragraph of paragraphs.slice(1)) {
    if (typeof paragraph.separatorBefore !== "string") return null;
    text += paragraph.separatorBefore + paragraph.text;
  }
  return text;
};

export const resolveScope = (
  scope: VoiceScope,
  snapshot: EditorSnapshot,
  resolvedTarget: VoiceRange | null,
): VoiceRange | null => {
  switch (scope.kind) {
    case "document": {
      const first = snapshot.paragraphs[0];
      const last = snapshot.paragraphs[snapshot.paragraphs.length - 1];
      if (!first || !last) return null;
      const text = canonicalDocumentText(snapshot.paragraphs);
      if (text === null) return null;
      return {
        revision: snapshot.revision,
        from: first.nodeFrom,
        to: last.nodeTo,
        text,
        paragraphIndexes: snapshot.paragraphs.map(
          (paragraph) => paragraph.index,
        ),
        block: true,
      };
    }
    case "selection":
      return resolvedSelection(snapshot);
    case "effective":
      return resolvedSelection(snapshot) ?? resolvedAnchor(snapshot, 0);
    case "current":
      return resolvedAnchor(snapshot, 0);
    case "previous":
      return resolvedAnchor(snapshot, -1);
    case "next":
      return resolvedAnchor(snapshot, 1);
    case "paragraph": {
      const position = findParagraphPosition(snapshot, scope.index);
      return position < 0
        ? null
        : rangeForParagraph(snapshot.paragraphs[position], snapshot.revision);
    }
    case "resolved-target":
      return resolvedTarget ? cloneRange(resolvedTarget) : null;
    case "semantic":
      return null;
  }
};

export const toSpeechContentRanges = (
  range: VoiceRange,
  snapshot: EditorSnapshot,
): VoiceRange[] => {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.to <= range.from
  ) {
    return [];
  }

  const results: VoiceRange[] = [];
  for (const paragraph of snapshot.paragraphs) {
    const from = Math.max(range.from, paragraph.from);
    const to = Math.min(range.to, paragraph.to);
    if (from >= to) continue;

    const text = paragraph.text.slice(
      from - paragraph.from,
      to - paragraph.from,
    );
    if (text.length !== to - from) continue;
    results.push({
      revision: range.revision,
      from,
      to,
      text,
      paragraphIndexes: [paragraph.index],
      block: false,
    });
  }
  return results;
};
