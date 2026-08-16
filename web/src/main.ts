/**
 * Entry point.
 *
 * Boots the renderer, wires input, registers the scenes and starts the loop.
 * Kept deliberately thin: everything interesting lives in app/ and scenes/.
 */

import { Audio, installUnlockGesture } from "./audio";
import { Game } from "./app/Game";
import { SaveData } from "./core/save";
import * as story from "./core/story";
import { attachInput } from "./input/Input";
import { BootScene } from "./scenes/BootScene";
import { GameplayScene } from "./scenes/GameplayScene";
import { PauseScene } from "./scenes/PauseScene";
import { HelpScene } from "./scenes/HelpScene";
import { LevelSelectScene } from "./scenes/LevelSelectScene";
import { MenuScene } from "./scenes/MenuScene";
import { ModeSelectScene } from "./scenes/ModeSelectScene";
import { PreviewScene } from "./scenes/PreviewScene";
import { GameOverScene } from "./scenes/result/GameOverScene";
import { VictoryScene } from "./scenes/result/VictoryScene";
import { SettingsScene } from "./scenes/SettingsScene";
import { StoryScene } from "./scenes/StoryScene";
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

  // The four visual-effect switches persist (a deliberate divergence from the
  // Python, whose schema never grew the field). Absent keys read as ON - with
  // one exception: bloom is the biggest frame-rate lever a phone player has,
  // and no test device exists for this port, so on a touch device it defaults
  // OFF until the player explicitly turns it on in settings (the user's call,
  // 2026-08-16). An explicit save value always wins, either way.
  const touchDevice = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const bloomOn =
    "bloom" in save.effects ? save.effectEnabled("bloom") : !touchDevice;
  game.post.fx.setPostFlags({
    bloom: bloomOn,
    scanlines: save.effectEnabled("scanlines"),
    grain: save.effectEnabled("grain"),
  });
  game.post.fx.shakeEnabled = save.effectEnabled("shake");

  // Scenes register themselves here; Game never imports a scene module, which
  // keeps the dependency arrow pointing one way and avoids import cycles.
  game.registerScene("boot", (g) => new BootScene(g));
  game.registerScene("game", (g) => new GameplayScene(g, save, sound));
  game.registerScene("pause", (g) => new PauseScene(g, save, sound));
  game.registerScene("menu", (g) => new MenuScene(g, save, sound));
  game.registerScene("help", (g) => new HelpScene(g, sound));
  game.registerScene("mode", (g) => new ModeSelectScene(g, save, sound));
  game.registerScene("levels", (g) => new LevelSelectScene(g, save, sound));
  game.registerScene("gameover", (g) => new GameOverScene(g, save, sound));
  game.registerScene("victory", (g) => new VictoryScene(g, save, sound));
  game.registerScene("settings", (g) => new SettingsScene(g, save, sound));
  game.registerScene("story", (g) => new StoryScene(g, sound));
  // Development only: reachable by name from the screenshot harness, never
  // linked to from the game itself.
  game.registerScene("preview", (g) => new PreviewScene(g));
  game.registerScene("uikit", (g) => new UiKitScene(g));

  game.start("boot");
  dismissBootSplash();

  // Expose for debugging on a real device, where there is no console to hand.
  // `story` is what lets the screenshot harness hand real Chapter/StoryBeat
  // objects to the story scene, exercising the same duck-typing the game does.
  (window as unknown as { game?: Game; save?: SaveData; sound?: Audio }).game = game;
  (window as unknown as { save?: SaveData }).save = save;
  (window as unknown as { sound?: Audio }).sound = sound;
  (window as unknown as { story?: unknown }).story = story;
}

main().catch(showFatal);
