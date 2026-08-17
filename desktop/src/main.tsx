import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";

import { createRoot } from "react-dom/client";

import App from "./App";
import { applyExperimentalTheme } from "./components/theme-playground";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Hivemind desktop root element is missing.");
}

/* EXPERIMENTAL: applied before the first paint, so the app opens on the chosen
   radius and typeface rather than adopting them only once settings has been
   visited. Deleting the panel means deleting this line and the import.
   After `styles.css`, because it overrides tokens the stylesheet declares. */
applyExperimentalTheme();

createRoot(root).render(<App />);
