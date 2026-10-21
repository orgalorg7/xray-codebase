import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connectBackend } from "./backend";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
connectBackend().then(
  (backend) => root.render(<App backend={backend} />),
  (error: unknown) =>
    root.render(
      <div className="boot">
        <h1>xray could not start</h1>
        <p>{error instanceof Error ? error.message : String(error)}</p>
      </div>,
    ),
);
