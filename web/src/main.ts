/**
 * Entry point.
 *
 * Boots the renderer, wires input, registers the scenes and starts the loop.
 * Kept deliberately thin: everything interesting lives in app/ and scenes/.
 */

import { Game } from "./app/Game";
import { attachInput } from "./input/Input";
import { BootScene } from "./scenes/BootScene";

function dismissBootSplash(): void {
  const boot = document.getElementById("boot");
  if (!boot) return;
  boot.classList.add("gone");
  window.setTimeout(() => boot.remove(), 600);
}

function showFatal(err: unknown): void {
  const boot = document.getElementById("boot");
  const message = err instanceof Error ? err.message : String(err);
  console.error("[neon-serpent] fatal:", err);
  if (boot) {
    boot.innerHTML =
      `<h1 style="color:#ff546c">UNABLE TO START</h1>` +
      `<p style="max-width:40ch;text-align:center;line-height:1.6">${message}</p>`;
    boot.classList.remove("gone");
  }
}

async function main(): Promise<void> {
  const game = new Game();
  await game.init();

  attachInput(game, game.app.canvas);

  // Scenes register themselves here; Game never imports a scene module, which
  // keeps the dependency arrow pointing one way and avoids import cycles.
  game.registerScene("boot", (g) => new BootScene(g));

  game.start("boot");
  dismissBootSplash();

  // Expose for debugging on a real device, where there is no console to hand.
  (window as unknown as { game?: Game }).game = game;
}

main().catch(showFatal);
