import type { Summary } from "@xray/service";
import { useEffect, useId, useState } from "react";
import { useApp } from "../context";
import { KindDot } from "./common";

/** A search field that picks one node. */
export function NodePicker({
  label,
  value,
  onPick,
  placeholder,
}: {
  label: string;
  value: Summary | undefined;
  onPick: (id: string | undefined) => void;
  placeholder: string;
}) {
  const { backend, theme, store } = useApp();
  const [text, setText] = useState("");
  const [options, setOptions] = useState<Summary[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    if (text.trim().length < 2) {
      setOptions([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      backend.search(text, 8).then((r) => {
        if (current) {
          setOptions(r.hits.map((h) => h.node));
          setActive(0);
        }
      });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text, backend]);

  const choose = (summary: Summary | undefined) => {
    onPick(summary?.id);
    setText("");
    setOptions([]);
  };

  if (value) {
    return (
      <div className="picker picker-set">
        <span className="picker-label">{label}</span>
        <span className="picker-value" title={value.id}>
          <KindDot kind={value.kind} theme={theme} /> {value.label}
        </span>
        <button
          type="button"
          className="link-button"
          onClick={() => onPick(undefined)}
          aria-label={`Clear ${label}`}
        >
          change
        </button>
      </div>
    );
  }
  const selected = store.get().selected;
  return (
    <div className="picker">
      <label className="picker-label" htmlFor={`${listId}-input`}>
        {label}
      </label>
      <input
        id={`${listId}-input`}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(options.length - 1, a + 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
          else if (e.key === "Enter") choose(options[active]);
        }}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        autoComplete="off"
      />
      {selected && (
        <button type="button" className="link-button" onClick={() => onPick(selected)}>
          use selection
        </button>
      )}
      {options.length > 0 && (
        <div className="picker-options" id={listId} role="listbox">
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? "picker-option active" : "picker-option"}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
            >
              <KindDot kind={o.kind} theme={theme} /> {o.label}
              {o.file && <span className="muted"> {o.file}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
