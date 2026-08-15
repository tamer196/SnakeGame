/**
 * Entry point.
 *
 * Boots the renderer, wires input, registers the scenes and starts the loop.
 * Kept deliberately thin: everything interesting lives in app/ and scenes/.
 */

import { Audio, installUnlockGesture } from "./audio";
import { Game } from "./app/Game";
import { SaveData } from "./core/save";
import { attachInput } from "./input/Input";
import { BootScene } from "./scenes/BootScene";
import { GameplayScene } from "./scenes/GameplayScene";
import { PauseScene } from "./scenes/PauseScene";
import { MenuScene } from "./scenes/MenuScene";
import { PreviewScene } from "./scenes/PreviewScene";
import { UiKitScene } from "./scenes/UiKitScene";

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

  const save = SaveData.load();
  game.difficulty = save.difficulty;
  game.mode = save.mode;

  // A browser will not let a page make a sound until the user has touched it,
  // so the context stays suspended and every cue is a silent no-op until the
  // first gesture unlocks it. Baking is spread across tasks from there.
  const sound = new Audio({ muted: save.muted });
  installUnlockGesture(sound, window);

  // Scenes register themselves here; Game never imports a scene module, which
  // keeps the dependency arrow pointing one way and avoids import cycles.
  game.registerScene("boot", (g) => new BootScene(g));
  game.registerScene("game", (g) => new GameplayScene(g, save, sound));
  game.registerScene("pause", (g) => new PauseScene(g, save, sound));
  game.registerScene("menu", (g) => new MenuScene(g, save, sound));
  // Development only: reachable by name from the screenshot harness, never
  // linked to from the game itself.
  game.registerScene("preview", (g) => new PreviewScene(g));
  game.registerScene("uikit", (g) => new UiKitScene(g));

  game.start("boot");
  dismissBootSplash();

  // Expose for debugging on a real device, where there is no console to hand.
  (window as unknown as { game?: Game; save?: SaveData; sound?: Audio }).game = game;
  (window as unknown as { save?: SaveData }).save = save;
  (window as unknown as { sound?: Audio }).sound = sound;
}

main().catch(showFatal);
