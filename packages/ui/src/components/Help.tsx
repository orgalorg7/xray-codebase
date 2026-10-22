import { useEffect, useRef } from "react";

const SHORTCUTS: [string, string][] = [
  ["/  or  Ctrl K", "Search"],
  ["Enter", "Open the highlighted result, or show a feature's territory"],
  ["Esc", "Clear the selection, close panels"],
  ["F", "Show the whole map"],
  ["+  −", "Zoom in and out"],
  ["Arrow keys", "Pan"],
  ["U", "Select the parent (file, directory)"],
  ["I", "Blast radius of the selection"],
  ["D", "Directions from the selection"],
  ["E / R / C / N / M / G", "Explore, Directions, Cycles, Insights, Matrix, Changes"],
  ["T", "Light / dark theme"],
  ["?", "This help"],
];

export function Help({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="help"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      onKeyDown={() => {}}
    >
      <h2>Getting around</h2>
      <p className="muted">
        The map nests code like places: directories are regions, files are cities, classes and
        functions are buildings. Zoom in to see more detail; lines between areas are dependencies.
      </p>
      <table>
        <tbody>
          {SHORTCUTS.map(([keys, action]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Links marked <span className="confidence confidence-inferred">~</span> are inferred from
        types or assignments; links marked{" "}
        <span className="confidence confidence-heuristic">?</span> are guesses by name.
      </p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
