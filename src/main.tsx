import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WindowChrome } from "./components/WindowChrome";
import { AppStoreProvider } from "./store/AppStore";
import { isTauriRuntime } from "./features/colab/connection";
import "./styles.css";

const desktop = isTauriRuntime();
if (desktop) document.documentElement.classList.add("desktop-chrome");
if (desktop && /Mac/i.test(navigator.platform)) document.documentElement.classList.add("desktop-chrome-mac");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {desktop && <WindowChrome />}
    <AppStoreProvider>
      <App />
    </AppStoreProvider>
  </StrictMode>,
);

