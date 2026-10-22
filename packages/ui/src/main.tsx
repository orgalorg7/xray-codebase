import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connectBackend, pageMeta } from "./backend";
import { Home } from "./Home";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
const page = pageMeta("xray-page");
// The hosted site's start page, and its page for a repository that is still being mapped.
if (page === "home" || page === "pending") {
  root.render(<Home target={pageMeta("xray-target")} repo={pageMeta("xray-repo")} />);
} else {
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
}
