import { Maximize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];
const resizeDirections: ResizeDirection[] = ["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"];

export function WindowChrome() {
  const appWindow = getCurrentWindow();
  const run = (action: () => Promise<void>) => {
    void action().catch((error) => {
      console.error("Não foi possível controlar a janela.", error);
    });
  };
  const toggleSize = async () => {
    if (await appWindow.isFullscreen()) await appWindow.setFullscreen(false);
    else await appWindow.toggleMaximize();
  };

  return (
    <>
      <div
        className={`window-chrome ${isMac ? "window-chrome-mac" : "window-chrome-standard"}`}
        role="toolbar"
        aria-label="Controles da janela"
      >
        <div
          className="window-chrome-drag"
          aria-hidden="true"
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            if (event.detail === 2) run(toggleSize);
            else run(() => appWindow.startDragging());
          }}
        />
        {!isMac && <div className="window-chrome-controls">
          <button type="button" className="window-close" aria-label="Fechar janela" title="Fechar" onClick={() => run(() => appWindow.close())}><X size={13} /></button>
          <button type="button" className="window-minimize" aria-label="Minimizar janela" title="Minimizar" onClick={() => run(() => appWindow.minimize())}><Minus size={13} /></button>
          <button type="button" className="window-maximize" aria-label="Maximizar ou restaurar janela" title="Maximizar ou restaurar" onClick={() => run(toggleSize)}><Maximize2 size={12} /></button>
        </div>}
        {!isMac && <span className="window-chrome-title" aria-hidden="true">Behavior Tracker</span>}
      </div>
      {!isMac && resizeDirections.map((direction) => (
        <div
          key={direction}
          className={`window-resize-handle window-resize-${direction.toLowerCase()}`}
          aria-hidden="true"
          onMouseDown={(event) => {
            if (event.button === 0) run(() => appWindow.startResizeDragging(direction));
          }}
        />
      ))}
    </>
  );
}
