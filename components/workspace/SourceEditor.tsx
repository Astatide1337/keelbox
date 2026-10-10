"use client";
import { useTheme } from "@/components/shell/ThemeProvider";
import { useEffect, useRef } from "react";
import {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { yaml } from "@codemirror/lang-yaml";
const yamlHighlights = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--syntax-key)" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: [tags.comment, tags.meta, tags.punctuation], color: "var(--muted)" },
]);
function editorTheme(theme: "dark" | "light") {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: "12px",
        color: "var(--foreground)",
        backgroundColor: "var(--background)",
      },
      ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)" },
      ".cm-content": { padding: "14px 0" },
      ".cm-gutters": {
        background: "var(--card)",
        border: "none",
        color: "var(--muted)",
      },
      ".cm-activeLine": { background: "var(--secondary)" },
      ".cm-activeLineGutter": { background: "var(--accent)" },
      "&.cm-focused": { outline: "none" },
    },
    { dark: theme === "dark" },
  );
}
const highlight = StateEffect.define<{ start: number; end: number }[]>();
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(highlight))
        value = Decoration.set(
          e.value
            .filter((r) => r.start < r.end && r.end <= tr.state.doc.length)
            .map((r) =>
              Decoration.mark({ class: "source-highlight" }).range(
                r.start,
                r.end,
              ),
            )
            .sort((a, b) => a.from - b.from),
        );
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
export type EditorContext = {
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
};
export function SourceEditor({
  value,
  onChange,
  ranges,
  onView,
  readOnly = false,
  contextKey,
  contexts,
}: {
  value: string;
  onChange: (value: string) => void;
  ranges: { start: number; end: number }[];
  onView?: (view: EditorView) => void;
  readOnly?: boolean;
  contextKey?: string;
  contexts?: Map<string, EditorContext>;
}) {
  const { theme } = useTheme();
  const themeExtension = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    callback = useRef(onChange),
    suppress = useRef(false);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          editable.current.of(EditorState.readOnly.of(readOnly)),
          yaml(),
          syntaxHighlighting(yamlHighlights),
          marks,
          EditorView.contentAttributes.of({
            "aria-label": "YAML source editor",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !suppress.current)
              callback.current(u.state.doc.toString());
          }),
          themeExtension.current.of(editorTheme(theme)),
        ],
      }),
    });
    const saved = contextKey && contexts?.get(contextKey);
    if (saved) {
      v.dispatch({
        selection: {
          anchor: Math.min(saved.anchor, value.length),
          head: Math.min(saved.head, value.length),
        },
      });
      v.scrollDOM.scrollTop = saved.scrollTop;
      v.scrollDOM.scrollLeft = saved.scrollLeft;
    }
    view.current = v;
    onView?.(v);
    return () => {
      if (contextKey && contexts) {
        const selection = v.state.selection.main;
        contexts.set(contextKey, {
          anchor: selection.anchor,
          head: selection.head,
          scrollTop: v.scrollDOM.scrollTop,
          scrollLeft: v.scrollDOM.scrollLeft,
        });
      }
      v.destroy();
    };
  }, [contextKey]);
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      const selection = v.state.selection.main;
      suppress.current = true;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        selection: {
          anchor: Math.min(selection.anchor, value.length),
          head: Math.min(selection.head, value.length),
        },
      });
      suppress.current = false;
    }
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: highlight.of(ranges) });
  }, [ranges]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);
  useEffect(() => {
    view.current?.dispatch({
      effects: themeExtension.current.reconfigure(editorTheme(theme)),
    });
  }, [theme]);
  return <div className="source-editor" ref={host} />;
}
