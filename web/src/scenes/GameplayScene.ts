/**
 * Playing a level: the scene that binds the rules to the picture.
 *
 * The rules live in {@link GameplayWorld}, which knows nothing about Pixi. This
 * file is the other half: it owns the display tree, feeds the world a pointer
 * every frame, and implements the presenter the world reports through - turning
 * "an orb was eaten" into a burst, a flash and a sound.
 *
 * Layer order is a contract, taken from `snake/scenes/gameplay.py::_draw`:
 *
 *   background        may spill into the letterbox; everything else may not
 *   arena frame       the neon border and its glow
 *   portals           below the other hazards, deliberately
 *   hazards
 *   orbs
 *   runes
 *   snake             ) both inside the arena clip, and in this order:
 *   particles         ) particles draw over the snake, not under it
 *   popups
 *
 * The two clocks are kept apart all the way to the draw calls: hazards animate
 * from `hazardT` and everything else from `t`. They are passed together as a
 * {@link FrameClocks} pair so a call site cannot quietly use the wrong one.
 */

import { Container, Graphics, Text } from "pixi.js";

import * as C from "../core/config";
import type { Game } from "../app/Game";
import { Scene, type SceneEnterArgs } from "../app/Scene";
import { themeForLevel, type RGB, type Theme } from "../core/palette";
import { SaveData } from "../core/save";
import { toHex } from "../core/palette";
import { ArenaFrame } from "../gfx/ArenaFrame";
import { makeBackground, type Background } from "../gfx/bg";
import {
  HazardRenderer,
  OrbRenderer,
  RuneRenderer,
  type FrameClocks,
} from "../gfx/entities";
import { SnakeRenderer } from "../gfx/SnakeRenderer";
import { Button } from "../ui/Button";
import { Hud } from "../ui/hud/Hud";
import { ReadyOverlay } from "../ui/hud/ReadyOverlay";
import { SCENES } from "../app/Scene";

/** `gameplay.py:133`. The pause button's rect, inside the HUD strip. */
const PAUSE_RECT = { x: 886, y: 32, w: 70, h: 38 };
import { GameplayWorld, type Popup } from "../game/GameplayWorld";
import type {
  BurstOptions,
  GameplayPresenter,
  RingOptions,
  TrailOptions,
} from "../game/presenter";
import type { Audio } from "../audio";

/** Pooled text for the floating score numbers. */
interface PopupView {
  text: Text;
  bound: Popup | null;
}

// Popup text comes straight from the ladder: `gameplay.py:1293` picks
// `fonts.h2 if pop.big else fonts.small`. The placeholder these replaced was
// wrong three ways - 20 px instead of 17, weight 700 instead of Segoe UI
// Light's 300, and a letterSpacing the Python never asks for.

export class GameplayScene extends Scene implements GameplayPresenter {
  readonly root = new Container();

  private readonly world: GameplayWorld;
  /** Named `sound`, not `audio`: the presenter's cue method owns that name. */
  private readonly sound: Audio | null;

  /** Everything that must not paint outside the play area. */
  private readonly arenaLayer = new Container();
  private readonly arenaMask = new Graphics();
  private readonly popupLayer = new Container();

  private background: Background | null = null;
  private arenaFrame: ArenaFrame | null = null;
  private readonly hazards = new HazardRenderer();
  private readonly orbs = new OrbRenderer();
  private readonly runes = new RuneRenderer();
  private readonly snakeView = new SnakeRenderer();

  private readonly popupViews: PopupView[] = [];
  /** Above the arena and outside its clip; it owns a clip of its own. */
  private readonly hud: Hud;
  private readonly pauseButton: Button;
  private readonly pauseLayer = new Container();
  private readonly pauseClip = new Graphics();
  private readonly ready: ReadyOverlay;
  private theme: Theme;
  private entered = false;

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game);
    this.sound = sound;
    this.theme = themeForLevel(0);
    this.world = new GameplayWorld({ save, presenter: this });

    this.arenaMask
      .rect(C.ARENA_X, C.ARENA_Y, C.ARENA_W, C.ARENA_H)
      .fill({ color: 0xffffff });
    this.root.addChild(this.arenaMask);
    this.arenaLayer.mask = this.arenaMask;

    this.arenaLayer.addChild(
      this.hazards.container,
      this.orbs.container,
      this.runes.container,
      this.snakeView.container,
    );
    this.root.addChild(this.arenaLayer);
    this.arenaLayer.addChild(this.popupLayer);

    // Added last so it stays above the arena; rebuildBackground only ever
    // inserts at the front, so this ordering survives a level change.
    this.hud = new Hud(game.fonts);
    this.root.addChild(this.hud.root);

    // The pause button lives in the HUD strip and its 18 px halo is clipped to
    // it - the rect reaches y = 70, so an unclipped glow would spill onto the
    // arena border below.
    this.pauseButton = new Button(game.fonts, PAUSE_RECT, "PAUSE", {
      style: "ghost",
      font: game.fonts.tiny,
    });
    this.pauseClip.rect(0, 0, C.WINDOW_W, C.HUD_H).fill({ color: 0xffffff });
    this.pauseLayer.addChild(this.pauseClip, this.pauseButton.root);
    this.pauseButton.root.mask = this.pauseClip;
    this.root.addChild(this.pauseLayer);

    // Above everything, unclipped: the card overlaps the arena border by design.
    this.ready = new ReadyOverlay(game.fonts);
    this.root.addChild(this.ready.root);
  }

  // -------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------

  override onEnter(args?: SceneEnterArgs): void {
    const levelIndex =
      typeof args?.["level"] === "number" ? (args["level"] as number) : this.game.levelIndex;

    this.world.enter({
      levelIndex,
      difficulty: this.game.difficulty,
      mode: this.game.mode,
    });
    this.game.levelIndex = this.world.level.index;
    this.theme = this.world.theme;

    this.rebuildBackground();
    this.arenaFrame?.setTheme(this.theme);
    this.hazards.setLevel(this.world.obstacles, this.theme);
    this.runes.setTheme(this.theme);

    // The particle system belongs to the shell, but it has to draw inside this
    // scene's arena clip and above the snake - so it is borrowed here and
    // handed back on exit.
    this.arenaLayer.addChildAt(
      this.game.particles.root,
      this.arenaLayer.getChildIndex(this.popupLayer),
    );

    this.releasePopups();
    // Scene instances are reused, so without this the odometer would roll up
    // from the previous level's score.
    this.hud.reset();
    this.entered = true;
  }

  override onExit(): void {
    this.entered = false;
    this.world.exit();
    if (this.game.particles.root.parent === this.arenaLayer) {
      this.arenaLayer.removeChild(this.game.particles.root);
    }
    this.hazards.clear();
    this.releasePopups();
  }

  override onResize(): void {
    // Background layers are pre-rendered at a fixed size, so a new viewport
    // means rebuilding. The seed comes from the style and theme, so the layout
    // comes back exactly as it was.
    if (this.entered) this.rebuildBackground();
  }

  private rebuildBackground(): void {
    this.background?.destroy();
    this.background = null;

    // The background is the one layer allowed past the design box: on a wide
    // phone those bars would otherwise be dead black.
    const rect = { ...this.game.viewport.overscan };
    this.background = makeBackground(
      this.theme.bgStyle,
      this.theme,
      rect,
      this.game.app.renderer,
    );
    this.root.addChildAt(this.background.root, 0);

    if (!this.arenaFrame) {
      this.arenaFrame = new ArenaFrame(
        { x: C.ARENA_X, y: C.ARENA_Y, w: C.ARENA_W, h: C.ARENA_H },
        this.theme,
      );
      this.root.addChildAt(this.arenaFrame.container, 1);
    }
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  override update(dt: number): void {
    const pointer = this.game.pointer;

    // Events before the update, matching the Python's pump-then-update order:
    // a move must be able to write `hovered` before `justEntered` is computed,
    // and a tap can press and release inside one frame.
    let pauseClicked = false;
    for (const ev of this.game.uiEvents) {
      if (this.pauseButton.handlePointer(ev)) pauseClicked = true;
    }
    for (const ev of this.game.keyEvents) {
      if (ev.type === "down" && !ev.repeat && (ev.key === "Escape" || ev.key === "p")) {
        pauseClicked = true;
      }
    }
    // Real dt: the button is chrome, and slow motion must not slow it down.
    this.pauseButton.update(dt, pointer);
    this.pauseButton.draw(this.theme, this.game.time);
    if (pauseClicked) this.pause();

    this.world.update(dt, pointer);

    const clocks: FrameClocks = { t: this.world.clockT, hazardT: this.world.hazardT };

    // The background leans toward the snake, so the parallax tracks the player
    // rather than the cursor.
    this.background?.update(dt, { x: this.world.snake.x, y: this.world.snake.y });
    this.arenaFrame?.update(clocks.t);
    this.hazards.draw(clocks);
    this.orbs.draw(this.world.food, clocks);
    this.runes.draw(this.world.runes.items, clocks);

    // Skipped outright on the blink-off frames of mercy invulnerability - the
    // Python does not fade it, it simply does not draw it.
    const visible = this.world.snakeVisible();
    this.snakeView.container.visible = visible;
    if (visible) {
      this.snakeView.draw(this.world.snake, this.theme, clocks.t, {
        ghost: this.world.effects.has("ghost"),
        shield: this.world.effects.has("shield"),
      });
    }

    this.syncPopups();

    // Real time, not the scaled clock: slow motion is for the simulation, and
    // the wall clock separately drives the bars' tip bloom.
    this.hud.update(
      { ...this.world.hudState(this.game.time), boosting: pointer.boost },
      this.theme,
      this.game.time,
      performance.now(),
    );

    const world = this.world;
    this.ready.update(world.readyTimer, world.goTimer, {
      levelNumber: world.level.number,
      levelName: world.level.name,
      levelSubtitle: world.level.subtitle,
      levelHint: world.level.hint,
      goalFood: world.level.goalFood,
      difficultyLabel: world.diff.hudLabel,
      difficultyColor: world.diff.color,
      storyMode: world.storyMode,
      chapterRoman: world.chapter?.roman() ?? null,
      chapterTitle: world.chapter?.title ?? null,
      beatTitle: world.beat?.title ?? null,
    }, this.theme);
  }

  /**
   * Push the pause overlay.
   *
   * Guarded on registration so the button is live from the moment PauseScene
   * lands, and inert rather than throwing until then.
   */
  private pause(): void {
    if (!this.game.registeredScenes().includes(SCENES.PAUSE)) return;
    this.game.pushScene(SCENES.PAUSE);
  }

  // -------------------------------------------------------------------
  // popups
  // -------------------------------------------------------------------

  private syncPopups(): void {
    const live = this.world.popups;
    for (let i = 0; i < live.length; i++) {
      const p = live[i]!;
      let view = this.popupViews[i];
      if (!view) {
        view = {
          text: new Text({ text: "", style: this.game.fonts.small }),
          bound: null,
        };
        view.text.anchor.set(0.5);
        view.text.resolution = this.game.fonts.resolution;
        this.popupLayer.addChild(view.text);
        this.popupViews.push(view);
      }
      // Re-render the glyphs only when the popup behind this slot changes;
      // the Python rasterises the text every frame and that is exactly the
      // cost worth not copying.
      if (view.bound !== p) {
        view.bound = p;
        view.text.style = p.big ? this.game.fonts.h2 : this.game.fonts.small;
        view.text.text = p.text;
        view.text.tint = toHex(p.color);
      }
      const fade = Math.max(0, Math.min(1, p.life / p.maxLife));
      view.text.position.set(p.x, p.y);
      view.text.alpha = Math.min(1, fade * 1.5);
      view.text.visible = true;
    }
    for (let i = live.length; i < this.popupViews.length; i++) {
      const view = this.popupViews[i]!;
      view.text.visible = false;
      view.bound = null;
    }
  }

  private releasePopups(): void {
    for (const v of this.popupViews) {
      v.text.visible = false;
      v.bound = null;
    }
  }

  // -------------------------------------------------------------------
  // GameplayPresenter - the world reports here
  // -------------------------------------------------------------------

  trail(x: number, y: number, color: RGB, dt: number, opts: TrailOptions): void {
    this.game.particles.trail(x, y, color, dt, {
      rate: opts.rate,
      speed: opts.speed,
      ...(opts.spread !== undefined ? { spread: opts.spread } : {}),
      ...(opts.life !== undefined ? { life: opts.life } : {}),
      ...(opts.radius !== undefined ? { radius: opts.radius } : {}),
    });
  }

  burst(x: number, y: number, color: RGB, opts: BurstOptions): void {
    this.game.particles.burst(x, y, color, {
      count: opts.count,
      speed: opts.speed,
      life: opts.life,
      ...(opts.radius !== undefined ? { radius: opts.radius } : {}),
    });
  }

  ring(x: number, y: number, color: RGB, opts: RingOptions): void {
    this.game.particles.ring(x, y, color, {
      radius: opts.radius,
      count: opts.count,
      life: opts.life,
      ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
    });
  }

  ambient(color: RGB, dt: number, rate: number): void {
    this.game.particles.ambient(
      { x: C.ARENA_X, y: C.ARENA_Y, w: C.ARENA_W, h: C.ARENA_H },
      color,
      dt,
      { rate },
    );
  }

  clearParticles(): void {
    this.game.particles.clear();
  }

  shake(magnitude: number): void {
    this.game.post.fx.shake(magnitude);
  }

  flash(color: RGB, strength: number): void {
    this.game.post.fx.flash(color, strength);
  }

  slowmo(scale: number, seconds: number): void {
    this.game.post.fx.slowmo(scale, seconds);
  }

  timeScale(): number {
    return this.game.post.fx.timeScale();
  }

  setTheme(color: RGB): void {
    void color;
    this.game.post.fx.setTheme(this.theme);
  }

  audio(name: string, volume?: number): void {
    this.sound?.play(name, volume);
  }
}
